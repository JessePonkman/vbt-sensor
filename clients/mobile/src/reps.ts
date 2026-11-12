// Batch rep detector. Finds reps from the bar's DISPLACEMENT, not from
// velocity thresholds, so it works for any speed: a 6 s grinding PR and a
// 0.4 s speed rep are both "the bar went down ~45 cm and came back".
//
// Why not the streaming FSM in vbt.ts for this: it decides "the bar is still"
// from a 300 ms window of acceleration and then clamps velocity to zero. An
// accelerometer cannot tell constant slow motion from rest (both have ~zero
// acceleration), so slow tempo, long pauses and grinding reps are read as
// "still" and never start a rep. See scripts/bench.ts for the measurement.
//
// Pipeline (all zero-phase, because this runs on a recorded set):
//   1. uniform grid by `sequence`        packets lost over the air are filled
//   2. vertical axis, tilt-tracked        a . g_hat(t) - |g|; g_hat follows the
//                                         slowly changing bar angle, so
//                                         walkout tilt does not leak into it
//   3. drift-free displacement            double integration, high-passed:
//                                         the DC bias that ruins integration
//                                         is exactly what a high-pass removes
//   4. zigzag extrema on displacement     top -> bottom -> top = one rep.
//                                         Gait bounce and the unrack bump are
//                                         centimetres, reps are ~half a metre
//   5. per-rep re-integration             from the unfiltered a_vert, with v=0
//                                         at both tops (same as vbt.ts's
//                                         closeRep), then phase boundaries
//                                         from velocity: concentric = from the
//                                         moment the bar starts rising to the
//                                         moment it stops, pauses excluded
//
// Like vbt.ts: zero runtime imports (the type import is erased), so node's
// test runner can load it.

// Node's test runner needs the explicit .ts extension for a runtime import (see
// the note in vbt.test.ts); tsconfig allows it, and Metro resolves the file.
import { fuseOrientation, gravityBody, MAHONY_DEFAULTS, tiltQuat } from './orientation.ts';
import type { Calibration, PhaseMetrics, RawSample, Rep, RejectedRep, SessionTrace } from './vbt';

export type RepProfile = {
  id: string;
  romMinM: number;
  romMaxM: number;
  returnMaxM: number; // the bar must come back this close to where it started
  repMinMs: number;
  repMaxMs: number;
  /** Swing needed between neighbouring extrema to be considered a rep at all. */
  swingM: number;
  /** Each phase (down, up) must itself cover this fraction of romMinM. The
   *  window-wide range alone lets drift over a long, noisy stretch pass. */
  phaseRomFrac: number;
  /** In a set of 3+ reps, drop a rep whose travel is under this fraction of
   *  the set's median: reps of one set are the same exercise. */
  setRomFrac: number;
  /** Where a phase starts/ends: the bar counts as "moving" above this fraction
   *  of the phase's own peak velocity, clamped to [moveFloor, moveCeil] m/s. */
  moveFrac: number;
  moveFloor: number;
  moveCeil: number;
};

export const SQUAT_PROFILE: RepProfile = {
  id: 'squat',
  romMinM: 0.2,
  romMaxM: 1.0,
  returnMaxM: 0.15,
  repMinMs: 500,
  repMaxMs: 30_000, // a 6 s grind plus a 4 s pause still fits with room to spare
  swingM: 0.12,
  phaseRomFrac: 0.6,
  setRomFrac: 0.5,
  moveFrac: 0.03,
  moveFloor: 0.012,
  moveCeil: 0.04,
};

/** Fitted start velocity / bias beyond which an edge rep counts as cut by the set's marks. */
const PARTIAL_V_START = 0.15; // m/s
const PARTIAL_BIAS = 0.08; // m/s^2

/** Seconds of assumed stillness added before and after every recorded segment. */
const EDGE_REST_S = 3;

const DT_MAX_S = 0.25; // a gap this long between received packets splits the recording
const US_WRAP = 2 ** 32;

export type SetAnalysis = {
  reps: Rep[];
  rejected: RejectedRep[];
  calibration: Calibration | null;
  session: SessionTrace;
  /** Which tilt estimate fed the vertical axis: the gyroscope-fused one, or
   *  the accelerometer-only average (v1 data, or `gyro: false`). */
  orientation: 'gyro' | 'accel';
};

export type AnalyzeOptions = {
  /** Use the gyroscope to track the bar's tilt when the packets carry it
   *  (protocol v2). false forces the accelerometer-only path, which is what
   *  v1 data gets anyway; scripts/bench.ts uses it for the before/after. */
  gyro?: boolean;
};

// --- numeric helpers ---------------------------------------------------------

function median(a: readonly number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function cumtrapz(x: readonly number[], dt: number): number[] {
  const out = new Array<number>(x.length).fill(0);
  for (let i = 1; i < x.length; i++) out[i] = out[i - 1] + 0.5 * (x[i - 1] + x[i]) * dt;
  return out;
}

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

/** 2nd-order Butterworth via bilinear transform. */
function butter2(fc: number, fs: number, type: 'low' | 'high'): Biquad {
  const k = Math.tan((Math.PI * Math.min(fc, fs * 0.45)) / fs);
  const q = Math.SQRT1_2;
  const norm = 1 / (1 + k / q + k * k);
  const a1 = 2 * (k * k - 1) * norm;
  const a2 = (1 - k / q + k * k) * norm;
  if (type === 'low') return { b0: k * k * norm, b1: 2 * k * k * norm, b2: k * k * norm, a1, a2 };
  return { b0: norm, b1: -2 * norm, b2: norm, a1, a2 };
}

function runBiquad(x: readonly number[], c: Biquad): number[] {
  const y = new Array<number>(x.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const out = c.b0 * x[i] + z1;
    z1 = c.b1 * x[i] - c.a1 * out + z2;
    z2 = c.b2 * x[i] - c.a2 * out;
    y[i] = out;
  }
  return y;
}

/** Forward-backward filtering (zero phase). The signal is extended at both
 *  ends with its edge value so the filter's start-up transient dies in the
 *  padding instead of in the data. The sets we record start and end at rest,
 *  where a constant extension is the right guess. */
function filtfilt(x: readonly number[], c: Biquad, pad: number): number[] {
  const n = x.length;
  if (n === 0) return [];
  const ext = new Array<number>(n + 2 * pad);
  for (let i = 0; i < pad; i++) ext[i] = x[0];
  for (let i = 0; i < n; i++) ext[pad + i] = x[i];
  for (let i = 0; i < pad; i++) ext[pad + n + i] = x[n - 1];
  const fwd = runBiquad(ext, c);
  fwd.reverse();
  const bwd = runBiquad(fwd, c);
  bwd.reverse();
  return bwd.slice(pad, pad + n);
}

// --- 1. uniform grid -----------------------------------------------------------

type Segment = {
  t: number[]; // seconds from the first sample of the recording
  ax: number[];
  ay: number[];
  az: number[];
  gx: number[]; // rad/s; NaN-free after gap filling, but only meaningful when hasGyro
  gy: number[];
  gz: number[];
  hasGyro: boolean; // every received packet in the segment carried a gyroscope reading
  filled: boolean[]; // true where the packet never arrived and was interpolated
  fs: number;
  t0: number; // this segment's start, seconds from the first sample of the recording
};

function deltaUs(prev: number, curr: number): number {
  return (curr - prev + US_WRAP) % US_WRAP;
}

/** Splits the recording where the link stalled or the ESP32 rebooted, then
 *  rebuilds each piece onto a uniform grid indexed by `sequence`. */
function buildSegments(samples: readonly RawSample[]): Segment[] {
  const pieces: RawSample[][] = [];
  let cur: RawSample[] = [];
  let elapsed = 0;
  const startAt: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (cur.length > 0) {
      const prev = cur[cur.length - 1];
      const dt = deltaUs(prev.timestamp, s.timestamp) / 1e6;
      if (dt >= DT_MAX_S || s.sequence <= prev.sequence) {
        pieces.push(cur);
        cur = [];
        elapsed += Math.min(dt, 3600) || 0;
      } else {
        elapsed += dt;
      }
    }
    if (cur.length === 0) startAt.push(elapsed);
    cur.push(s);
  }
  if (cur.length > 0) pieces.push(cur);

  const out: Segment[] = [];
  pieces.forEach((p, pi) => {
    if (p.length < 20) return;
    const perStep: number[] = [];
    for (let i = 1; i < p.length; i++) {
      const gap = p[i].sequence - p[i - 1].sequence;
      perStep.push(deltaUs(p[i - 1].timestamp, p[i].timestamp) / Math.max(1, gap));
    }
    const fs = 1e6 / median(perStep);
    const seq0 = p[0].sequence;
    const n = p[p.length - 1].sequence - seq0 + 1;
    const ax = new Array<number>(n).fill(NaN);
    const ay = new Array<number>(n).fill(NaN);
    const az = new Array<number>(n).fill(NaN);
    const gx = new Array<number>(n).fill(NaN);
    const gy = new Array<number>(n).fill(NaN);
    const gz = new Array<number>(n).fill(NaN);
    let hasGyro = true;
    for (const s of p) {
      const k = s.sequence - seq0;
      ax[k] = s.ax;
      ay[k] = s.ay;
      az[k] = s.az;
      if (s.gx === undefined || s.gy === undefined || s.gz === undefined || !Number.isFinite(s.gx)) hasGyro = false;
      else {
        gx[k] = s.gx;
        gy[k] = s.gy as number;
        gz[k] = s.gz as number;
      }
    }
    const filled = ax.map((v) => Number.isNaN(v));
    for (const arr of [ax, ay, az]) fillGaps(arr);
    if (hasGyro) for (const arr of [gx, gy, gz]) fillGaps(arr);
    out.push({ t: Array.from({ length: n }, (_, k) => startAt[pi] + k / fs), ax, ay, az, gx, gy, gz, hasGyro, filled, fs, t0: startAt[pi] });
  });
  return out;
}

function fillGaps(a: number[]): void {
  let last = -1;
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i])) continue;
    if (last >= 0 && i - last > 1) {
      for (let j = last + 1; j < i; j++) a[j] = a[last] + ((a[i] - a[last]) * (j - last)) / (i - last);
    }
    last = i;
  }
}

// --- 2. vertical axis ----------------------------------------------------------

/** a . g_hat(t) - |g|, where g_hat is the accelerometer vector averaged over a
 *  centred window. The average of a vertical rep is parallel to gravity (the
 *  dynamic part cancels in direction), while the bar slowly tilting during
 *  the walkout is tracked — a fixed projection leaks horizontal acceleration
 *  into "vertical" as soon as the bar tilts. */
function verticalAxis(seg: Segment, useGyro: boolean): { aVert: number[]; gMag: number; fused: boolean } {
  const n = seg.ax.length;
  const mag = seg.ax.map((x, i) => Math.hypot(x, seg.ay[i], seg.az[i]));
  const gMag = median(mag);

  if (useGyro && seg.hasGyro) return { aVert: fusedVertical(seg, gMag), gMag, fused: true };

  const win = Math.max(3, Math.round(1.5 * seg.fs)) | 1;
  const half = win >> 1;
  const prefix = (a: number[]) => {
    const p = new Array<number>(n + 1).fill(0);
    for (let i = 0; i < n; i++) p[i + 1] = p[i] + a[i];
    return p;
  };
  const px = prefix(seg.ax);
  const py = prefix(seg.ay);
  const pz = prefix(seg.az);

  const aVert = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    const c = hi - lo;
    const gx = (px[hi] - px[lo]) / c;
    const gy = (py[hi] - py[lo]) / c;
    const gz = (pz[hi] - pz[lo]) / c;
    const gn = Math.hypot(gx, gy, gz) || 1;
    aVert[i] = (seg.ax[i] * gx + seg.ay[i] * gy + seg.az[i] * gz) / gn - gMag;
  }
  return { aVert, gMag, fused: false };
}

/** Vertical acceleration from the gyroscope-fused orientation: the Mahony
 *  filter keeps g_hat(t) consistent with BOTH sensors, so the bar rolling
 *  does not leak into the vertical channel and a sideways push is not
 *  mistaken for a tilt. The filter starts from the tilt of the first
 *  readings and, when the set starts at rest, from the gyroscope's resting
 *  bias too. */
function fusedVertical(seg: Segment, gMag: number): number[] {
  const n = seg.ax.length;
  const n0 = Math.min(n, Math.max(10, Math.round(0.8 * seg.fs)));
  const mean = (a: number[]) => a.slice(0, n0).reduce((x, y) => x + y, 0) / n0;
  const [mx, my, mz] = [mean(seg.ax), mean(seg.ay), mean(seg.az)];
  const [mgx, mgy, mgz] = [mean(seg.gx), mean(seg.gy), mean(seg.gz)];

  // Is the sensor actually still over that first stretch? Both a steady
  // accelerometer and a (near) zero rotation rate, otherwise the "bias" would
  // just be motion and subtracting it would hurt.
  let spread = 0;
  for (let i = 0; i < n0; i++) spread += (Math.hypot(seg.ax[i], seg.ay[i], seg.az[i]) - Math.hypot(mx, my, mz)) ** 2;
  const still = Math.sqrt(spread / n0) < 0.2 && Math.hypot(mgx, mgy, mgz) < 0.1;

  const quats = fuseOrientation(
    seg.ax, seg.ay, seg.az, seg.gx, seg.gy, seg.gz, seg.fs,
    { ...MAHONY_DEFAULTS, gRef: gMag },
    still ? [mgx, mgy, mgz] : [0, 0, 0],
    tiltQuat(mx, my, mz)
  );
  return quats.map((q, i) => {
    const g = gravityBody(q);
    return seg.ax[i] * g[0] + seg.ay[i] * g[1] + seg.az[i] * g[2] - gMag;
  });
}

// --- 4. zigzag extrema ---------------------------------------------------------

type Extremum = { i: number; kind: 'max' | 'min' };

/** Alternating maxima/minima of `s`: a direction only flips once the signal
 *  has moved `delta` away from the running extreme, so noise and centimetre
 *  bounce never produce an extremum. */
function zigzag(s: readonly number[], delta: number): Extremum[] {
  const out: Extremum[] = [];
  let hi = 0;
  let lo = 0;
  let mode: 0 | 1 | -1 = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] > s[hi]) hi = i;
    if (s[i] < s[lo]) lo = i;
    if (mode === 0) {
      if (s[hi] - s[i] >= delta) {
        out.push({ i: hi, kind: 'max' });
        mode = -1;
        lo = i;
      } else if (s[i] - s[lo] >= delta) {
        out.push({ i: lo, kind: 'min' });
        mode = 1;
        hi = i;
      }
    } else if (mode === 1) {
      if (s[hi] - s[i] >= delta) {
        out.push({ i: hi, kind: 'max' });
        mode = -1;
        lo = i;
      }
    } else if (s[i] - s[lo] >= delta) {
      out.push({ i: lo, kind: 'min' });
      mode = 1;
      hi = i;
    }
  }
  if (mode === 1) out.push({ i: hi, kind: 'max' });
  else if (mode === -1) out.push({ i: lo, kind: 'min' });
  return out;
}

/** Robust estimate of the sensor noise on the vertical axis (MAD), taken over
 *  the whole recording: most of it is the bar at rest, so the spread of the
 *  signal is the noise, not the lifting. */
function noiseFloor(a: readonly number[]): number {
  const m = median(a);
  return 1.4826 * median(a.map((x) => Math.abs(x - m)));
}

/** The displacement extremum that ends a rep lands a tenth of a second or two
 *  before the bar has actually stopped (the high-pass bends it), and the
 *  re-integration below assumes v = 0 exactly at the window's end. Near the
 *  end of a rep v grows with the SQUARE of the time left, so even 0.2 s early
 *  is a ~10% velocity error. Walk forward to where the acceleration has
 *  really died out (quiet for 0.25 s), but never more than 0.8 s, and
 *  never into the next rep. */
function settleEnd(
  a: readonly number[],
  sHp: readonly number[],
  i1: number,
  fs: number,
  eps: number,
  swing: number
): number {
  const need = Math.max(2, Math.round(0.25 * fs));
  const limit = Math.min(a.length - need - 1, i1 + Math.round(0.8 * fs));
  // Zero acceleration also means "moving at constant speed": the cruise of
  // the NEXT descent looks exactly like rest. So only settle while the bar is
  // still up at the top (has not dropped more than 3% of the rep's travel).
  const topLevel = sHp[i1] - Math.max(0.01, 0.03 * swing);
  for (let j = i1; j <= limit; j++) {
    if (sHp[j] < topLevel) break;
    let quiet = true;
    for (let q = 0; q < need; q++) {
      if (Math.abs(a[j + q]) >= eps) {
        quiet = false;
        break;
      }
    }
    if (quiet) return j;
  }
  return i1;
}

// --- 5. per-rep measurement ----------------------------------------------------

function phase(t: readonly number[], v: readonly number[], s: readonly number[], from: number, to: number, dir: 'up' | 'down'): PhaseMetrics {
  let peak = v[from];
  let min = v[from];
  for (let i = from; i <= to; i++) {
    if (dir === 'up') {
      if (v[i] > peak) peak = v[i];
      if (v[i] < min) min = v[i];
    } else {
      if (v[i] < peak) peak = v[i];
      if (v[i] > min) min = v[i];
    }
  }
  const dt = t[to] - t[from];
  return {
    peakVelocity: peak,
    minVelocity: min,
    meanVelocity: dt > 0 ? (s[to] - s[from]) / dt : 0,
    durationMs: dt * 1000,
    rangeOfMotion: Math.abs(s[to] - s[from]),
  };
}

// --- the detector ----------------------------------------------------------------

export function analyzeSet(
  samples: readonly RawSample[],
  profile: RepProfile = SQUAT_PROFILE,
  opts: AnalyzeOptions = {}
): SetAnalysis {
  const reps: Rep[] = [];
  const rejected: RejectedRep[] = [];
  const trace: SessionTrace = { t: [], ax: [], ay: [], az: [], v: [] };
  let calibration: Calibration | null = null;
  let orientation: SetAnalysis['orientation'] = 'accel';

  for (const seg of buildSegments(samples)) {
    const n = seg.t.length;
    const fs = seg.fs;
    const dt = 1 / fs;
    const { aVert, gMag, fused } = verticalAxis(seg, opts.gyro !== false);
    if (fused) orientation = 'gyro';
    if (!calibration) {
      const c = Math.hypot(seg.ax[0], seg.ay[0], seg.az[0]) || 1;
      calibration = { ux: seg.ax[0] / c, uy: seg.ay[0] / c, uz: seg.az[0] / c, gMag };
    }

    // The set starts and ends with the bar at rest (the lifter presses Start
    // standing, End after lockout), so continue the recording with explicit
    // stillness. Without it the high-pass below distorts the last and first
    // rep, whose tops sit right at the edge of the data. `P` samples of
    // rest are added on both sides; indices below are in this padded space.
    const P = Math.round(EDGE_REST_S * fs);
    const aPad = [...new Array<number>(P).fill(0), ...aVert, ...new Array<number>(P).fill(0)];
    const tPad = Array.from({ length: n + 2 * P }, (_, k) => seg.t[0] + (k - P) / fs);

    // 3. drift-free displacement, only used to FIND reps.
    const padHp = Math.round(15 * fs);
    const hp = butter2(0.05, fs, 'high');
    const aLp = filtfilt(aPad, butter2(12, fs, 'low'), Math.round(0.5 * fs));
    const v0 = filtfilt(cumtrapz(aLp, dt), hp, padHp);
    const sHp = filtfilt(cumtrapz(v0, dt), hp, padHp);

    const ext = zigzag(sHp, 0.06);
    const eps = Math.max(0.05, 5 * noiseFloor(aLp));
    const sigmaA = noiseFloor(aVert); // raw accelerometer noise on the vertical axis, m/s^2

    const vTrace = new Array<number>(n).fill(0); // corrected velocity inside accepted reps, 0 elsewhere
    let prevEnd = -1; // padded index where the previous accepted rep's concentric ended
    const cands: { rep: Rep; i0: number; v: number[]; m: number }[] = [];

    // Candidate reps in order, so the edge ones can be told apart.
    const lastMin = ext.reduce((acc, e, q) => (e.kind === 'min' && q + 1 < ext.length ? q : acc), -1);
    const firstMin = ext.findIndex((e, q) => e.kind === 'min' && q >= 1 && q + 1 < ext.length);

    for (let k = 1; k + 1 < ext.length; k++) {
      if (ext[k].kind !== 'min' || ext[k - 1].kind !== 'max' || ext[k + 1].kind !== 'max') continue;
      const i0 = ext[k - 1].i;
      const swingDown = sHp[i0] - sHp[ext[k].i];
      const swingUp = sHp[ext[k + 1].i] - sHp[ext[k].i];
      if (swingDown < profile.swingM || swingUp < profile.swingM) continue;
      const i1 = settleEnd(aLp, sHp, ext[k + 1].i, fs, eps, swingUp);

      const startedAtMs = tPad[i0] * 1000;
      const bad = (reason: RejectedRep['reason']) => rejected.push({ reason, startedAtMs });

      // Re-integrate THIS rep from the unfiltered vertical acceleration.
      // Two unknowns remain: the velocity at the window start (v0) and a
      // constant accelerometer bias (b). The window ends sit near the tops,
      // but only to within a tenth of a second — assuming v = 0 exactly at
      // the start leaves a constant velocity error that the bias ramp then
      // over-corrects. So solve for both with the two facts we do know: the
      // bar is stationary at the end (v = 0) and has come back to where it
      // started (s = 0).
      const tt = tPad.slice(i0, i1 + 1);
      const a = aLp.slice(i0, i1 + 1);
      const m = tt.length;
      const vInt = cumtrapz(a, dt);
      const sInt = cumtrapz(vInt, dt);
      const span = tt[m - 1] - tt[0];
      const bias = span > 0 ? (2 * (sInt[m - 1] - vInt[m - 1] * span)) / (span * span) : 0;
      const vStart = -vInt[m - 1] - bias * span;
      if (Math.abs(vStart) > 0.3 || Math.abs(bias) > 0.3) {
        bad('return');
        continue;
      }
      // The set is delimited by the lifter's own Start / End marks. A mark
      // pressed while the bar was already moving cuts the rep at that edge, and
      // the fit above then needs an implausible starting velocity (first rep)
      // or an implausible bias (last rep) to make the books balance. Flag it
      // rather than drop it: the rep did happen, but its numbers (above all the
      // mean velocity) are not trustworthy and must not drive the set's stats.
      const partial =
        (k === firstMin && Math.abs(vStart) > PARTIAL_V_START) ||
        (k === lastMin && (Math.abs(bias) > PARTIAL_BIAS || Math.abs(vStart) > PARTIAL_V_START));
      const v = vInt.map((x, q) => x + vStart + bias * (tt[q] - tt[0]));
      const s = cumtrapz(v, dt);

      const durationMs = span * 1000;
      if (durationMs < profile.repMinMs || durationMs > profile.repMaxMs) {
        bad('duration');
        continue;
      }

      let sMin = s[0];
      let sMax = s[0];
      for (const x of s) {
        if (x < sMin) sMin = x;
        if (x > sMax) sMax = x;
      }
      if (sMax - sMin < profile.romMinM || sMax - sMin > profile.romMaxM) {
        bad('rom');
        continue;
      }

      // Phase boundaries from velocity. "Moving" means faster than a fraction of
      // the phase's own peak (profile.moveFrac, clamped), so the same rule serves a
      // 1.2 m/s speed rep and a 0.15 m/s grind, and the slow ease-in/out
      // tails stay inside the phase. Walking outward from the velocity peak
      // until it drops under that threshold also handles any bottom pause:
      // the rise starts at the END of the pause, not when the bar got there.
      let conPeak = 0;
      let eccPeak = 0;
      for (let q = 0; q < m; q++) {
        if (v[q] > v[conPeak]) conPeak = q;
        if (v[q] < v[eccPeak]) eccPeak = q;
      }
      if (conPeak < eccPeak) {
        bad('return'); // the rise came before the descent: not a squat rep
        continue;
      }
      // Integrated noise makes v wander by about 0.75 * sigma * sqrt(dt * T)
      // over a window of length T (a Brownian bridge). A fixed threshold is
      // fine for a quiet sensor on a short rep, but on a long, noisy one the
      // wander alone crosses it and drags the phase boundaries around. So the
      // floor grows with the noise and the window length; on a quiet sensor it
      // stays below moveFloor and nothing changes.
      const thrNoise = 0.75 * sigmaA * Math.sqrt(dt * span);
      const lo = Math.max(profile.moveFloor, thrNoise);
      const hi = Math.max(profile.moveCeil, lo);
      const thrCon = Math.min(hi, Math.max(lo, profile.moveFrac * v[conPeak]));
      const thrEcc = Math.min(hi, Math.max(lo, -profile.moveFrac * v[eccPeak]));
      // A phase boundary needs the bar to be slow AND at the right height. A
      // sticking point (the bar nearly stalls halfway up) is slow too, and
      // must not end the concentric: only "slow near the bottom" can start
      // the rise and only "slow near the top" can end it. "Near" = within a
      // fifth of the travel.
      let iBot = 0;
      for (let q = 1; q < m; q++) if (s[q] < s[iBot]) iBot = q;
      let sTopRef = s[iBot];
      for (let q = iBot; q < m; q++) if (s[q] > sTopRef) sTopRef = s[q];
      let sTop0 = s[0];
      for (let q = 0; q <= iBot; q++) if (s[q] > sTop0) sTop0 = s[q];
      const nearBottom = (q: number) => s[q] <= s[iBot] + 0.2 * (sTopRef - s[iBot]);
      const nearTop = (q: number, top: number) => s[q] >= top - 0.2 * (top - s[iBot]);

      let conStart = conPeak;
      while (conStart > eccPeak && !(v[conStart] <= thrCon && nearBottom(conStart))) conStart--;
      let conEnd = conPeak;
      while (conEnd < m - 1 && !(v[conEnd] <= thrCon && nearTop(conEnd, sTopRef))) conEnd++;
      let eccStart = eccPeak;
      // never reach back into the previous rep: with a noisy accelerometer the
      // velocity can sit below the threshold for longer than the real descent
      while (eccStart > 0 && !(v[eccStart] >= -thrEcc && nearTop(eccStart, sTop0)) && (prevEnd < 0 || i0 + eccStart > prevEnd)) eccStart--;
      let eccEnd = eccPeak;
      while (eccEnd < conStart && !(v[eccEnd] >= -thrEcc && nearBottom(eccEnd))) eccEnd++;
      if (conEnd <= conStart || eccEnd <= eccStart) {
        bad('duration');
        continue;
      }

      const eccentric = phase(tt, v, s, eccStart, eccEnd, 'down');
      const concentric = phase(tt, v, s, conStart, conEnd, 'up');

      prevEnd = i0 + conEnd;

      // a rep touches a filled (interpolated) sample => the data is partly invented
      const lossy = seg.filled.slice(Math.max(0, i0 - P), Math.max(0, i1 - P + 1)).some(Boolean);

      // Each phase must cover real travel by itself, not just the window.
      if (concentric.rangeOfMotion < profile.phaseRomFrac * profile.romMinM || eccentric.rangeOfMotion < profile.phaseRomFrac * profile.romMinM) {
        bad('rom');
        continue;
      }

      cands.push({
        i0,
        v,
        m,
        rep: {
          index: 0, // assigned once the set-level check below has run
          startedAtMs: tt[eccStart] * 1000,
          eccentric,
          concentric,
          peakConcentricVelocity: concentric.peakVelocity,
          meanConcentricVelocity: concentric.meanVelocity,
          timeToPeakMs: (tt[conPeak] - tt[conStart]) * 1000,
          totalDurationMs: (tt[conEnd] - tt[eccStart]) * 1000,
          residualBias: bias,
          lossy,
          ...(partial ? { partial: true } : {}),
        },
      });
    }

    // Set-level consistency: the reps of one set are the same exercise, so
    // one whose travel is a fraction of the rest is not a rep (typically the
    // walkout / re-rack, integrated over a few noisy seconds).
    let kept = cands;
    if (cands.length >= 3) {
      const typical = median(cands.map((c) => c.rep.concentric.rangeOfMotion));
      kept = cands.filter((c) => {
        if (c.rep.concentric.rangeOfMotion >= profile.setRomFrac * typical) return true;
        rejected.push({ reason: 'rom', startedAtMs: c.rep.startedAtMs });
        return false;
      });
    }
    for (const c of kept) {
      c.rep.index = reps.length + 1;
      reps.push(c.rep);
      for (let q = 0; q < c.m; q++) {
        const oi = c.i0 + q - P;
        if (oi >= 0 && oi < n) vTrace[oi] = c.v[q];
      }
    }

    for (let i = 0; i < n; i++) {
      trace.t.push(seg.t[i]);
      trace.ax.push(seg.ax[i]);
      trace.ay.push(seg.ay[i]);
      trace.az.push(seg.az[i]);
    }
    for (let i = 0; i < n; i++) trace.v.push(vTrace[i]);
  }

  return { reps, rejected, calibration, session: trace, orientation };
}
