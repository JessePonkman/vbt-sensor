// VBT core — gravity calibration, filtering, integration, drift correction,
// rep/phase segmentation. See PLAN-V2.md §2 for the full derivation of every
// formula and constant here; this file implements it, it doesn't re-argue it.
//
// Deliberately ZERO imports. `node --test` (used by vbt.test.ts) can only
// load plain TS with no React/BLE/JSX, and keeping this file standalone is
// what makes the whole pipeline testable without hardware. RawSample below
// mirrors VbtSample (src/protocol.ts) structurally instead of importing it —
// any VbtSample already satisfies RawSample, so callers pass samples through
// untouched. No enum/namespace/parameter-properties: Node's type-stripping
// rejects TS that emits runtime code, so everything here is a plain `type`
// or a function.

export type Vec3 = { x: number; y: number; z: number };

export type RawSample = {
  timestamp: number; // microseconds since ESP32 boot, uint32, wraps ~71.6 min
  ax: number;
  ay: number;
  az: number;
  sequence: number;
};

export type Calibration = { ux: number; uy: number; uz: number; gMag: number };

export type RepState = 'idle' | 'descending' | 'turnaround' | 'ascending';

export type PhaseMetrics = {
  peakVelocity: number; // signed extreme in the phase's own direction
  minVelocity: number; // signed extreme in the opposite direction
  meanVelocity: number; // signed; = displacement / duration
  durationMs: number;
  rangeOfMotion: number; // metres, absolute
};

export type Rep = {
  index: number;
  startedAtMs: number; // ms since this processor's last reset (no rxAt here — see RawSample)
  eccentric: PhaseMetrics;
  concentric: PhaseMetrics;
  peakConcentricVelocity: number;
  meanConcentricVelocity: number;
  timeToPeakMs: number;
  totalDurationMs: number;
  residualBias: number; // from detrend(); large |bias| => stale calibration or hardware issue
  lossy: boolean;
};

export type RejectedRep = { reason: 'rom' | 'return' | 'duration' | 'gap'; startedAtMs: number };

export type LiveState = {
  calibrated: boolean;
  still: boolean;
  state: RepState;
  aVert: number;
  vVert: number; // approximate — see PLAN-V2.md §2.4, "las dos pasadas"
};

export type VbtProcessor = {
  push(s: RawSample): void;
  readonly live: LiveState;
  takeReps(): { reps: Rep[]; rejected: RejectedRep[] }; // drains since the last call
  reset(): void;
};

/** Every number the physical world gets a vote on. Starting values are
 *  reasoned from back-squat kinematics and the MPU6050 datasheet, NOT
 *  measured on this hardware — expect to move several after the first real
 *  session (see PLAN-V2.md §11). createVbtProcessor takes a
 *  Partial<VbtTuning> so tests can pin them. */
export const VBT_TUNING = {
  // --- time base ---
  DT_MIN_S: 0.002, // below this: firmware boot catch-up burst / dup timestamp -> drop sample
  DT_MAX_S: 0.25, // above this: reboot or stall -> full pipeline reset
  DT_GAP_S: 0.06, // above this inside a rep -> flag the rep lossy

  // --- gravity calibration ---
  CALIB_MS: 1000,
  CALIB_MIN_SAMPLES: 50,
  CALIB_STILL_RMS: 0.12, // m/s^2, 3-D deviation from the mean vector. LOOSEST KNOB —
  // raise first if calibration never fires in the gym.
  CALIB_G_MIN: 8.5, // m/s^2, reject |g| outside this: moving, or wrong range register
  CALIB_G_MAX: 11.0,
  RECAL_IDLE_MS: 1500, // re-estimate gravity after this much continuous idle-still

  // --- filter ---
  LPF_HZ: 10, // one-pole on a_vert. Raise high to disable (RC->0 => passthrough).

  // --- still detection / ZUPT ---
  STILL_WIN_MS: 300, // must exceed the near-zero-accel dwell at mid-descent
  STILL_ACC_RMS: 0.15, // m/s^2 on the filtered a_vert
  ZUPT_V_MAX: 0.3, // m/s, second discriminator against zeroing mid-rep

  // --- segmentation — all provisional, tune on real data ---
  V_START: -0.15, // m/s, IDLE -> DESCENDING
  MIN_ECC_MS: 250, // sustain required to confirm the descent
  V_TURN: -0.05, // m/s, DESCENDING -> TURNAROUND
  V_UP: 0.15, // m/s, TURNAROUND -> ASCENDING
  MIN_CON_MS: 200,
  V_END: 0.05, // m/s, ASCENDING -> IDLE
  END_HOLD_MS: 200,
  V_MOVE: 0.05, // m/s, phase-boundary refinement in pass B
  LEAD_MS: 200, // window lead-in when no still frame is available
  REP_MIN_MS: 600,
  REP_MAX_MS: 8000, // also the candidate abort timeout

  // --- displacement sanity gates ---
  ROM_MIN_M: 0.2,
  ROM_MAX_M: 1.0,
  ROM_RETURN_MAX_M: 0.15, // the bar must come back to where it started

  // --- buffering ---
  HISTORY_S: 20,
} as const;

export type VbtTuning = typeof VBT_TUNING;

const US_WRAP = 2 ** 32;

/** Wrap-safe microsecond delta between two uint32 micros() readings — the C
 *  `(uint32_t)(now - last)` trick, exact in doubles since every intermediate
 *  stays below 2^53. Ambiguous only for true gaps >= 71.6 min, which can't
 *  happen inside a set, and DT_MAX_S resets the pipeline anyway if it did. */
function deltaUs(prevUs: number, currUs: number): number {
  return (currUs - prevUs + US_WRAP) % US_WRAP;
}

/** Averages the vectors (cancels zero-mean noise per axis; averaging
 *  magnitudes would not, since ‖·‖ is convex). Rejects if the athlete wasn't
 *  actually still (3-D RMS deviation from the mean vector) or if |g| is out
 *  of a plausible range (moving, wrong sensor range register, dead axis). */
export function calibrate(samples: readonly Vec3[], tuning: VbtTuning = VBT_TUNING): Calibration | null {
  const n = samples.length;
  if (n === 0) return null;

  let gx = 0,
    gy = 0,
    gz = 0;
  for (const a of samples) {
    gx += a.x;
    gy += a.y;
    gz += a.z;
  }
  gx /= n;
  gy /= n;
  gz /= n;

  const gMag = Math.hypot(gx, gy, gz);
  if (gMag < tuning.CALIB_G_MIN || gMag > tuning.CALIB_G_MAX) return null;

  let sumSq = 0;
  for (const a of samples) {
    const dx = a.x - gx,
      dy = a.y - gy,
      dz = a.z - gz;
    sumSq += dx * dx + dy * dy + dz * dz;
  }
  if (Math.sqrt(sumSq / n) > tuning.CALIB_STILL_RMS) return null;

  return { ux: gx / gMag, uy: gy / gMag, uz: gz / gMag, gMag };
  // ponytail: single-pose calibration cancels offset+scale along the gravity
  // axis only, so dynamic velocities inherit the MPU6050's ~3% scale error.
  // Ceiling: ~3% absolute accuracy, ratios (velocity loss %) are fine.
  // Upgrade: six-position static calibration (sensor on each face, solve
  // per-axis scale + offset), stored once per device.
}

/** A constant residual accelerometer bias produces a velocity error that is
 *  exactly linear in time. A rep begins and ends at rest, so the terminal
 *  velocity of a clean re-integration from v=0 IS that error, and
 *  bias = v(T)/T. This is the exact inverse of the constant-bias error
 *  model, not a fudge factor. Mutates `v` in place; returns the bias so a
 *  large value can be surfaced as a "recalibrate" diagnostic. */
function detrend(t: readonly number[], v: number[]): number {
  const span = t[t.length - 1] - t[0];
  if (span <= 0) return 0;
  const bias = v[v.length - 1] / span;
  for (let i = 0; i < v.length; i++) v[i] -= bias * (t[i] - t[0]);
  return bias;
  // ponytail: linear (constant-bias) detrend only. Ceiling: a bias that
  // ramps within a single rep leaves a quadratic residual. Upgrade:
  // least-squares quadratic fit over the window, ~6 lines — only if real
  // data shows post-detrend v(T) residuals a constant bias can't explain.
}

function argmin(arr: readonly number[]): number {
  let idx = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] < arr[idx]) idx = i;
  return idx;
}

/** Short centered moving average, used ONLY to locate the bottom position
 *  robustly — phaseMetrics still reports off the unsmoothed s. During a
 *  bottom pause the true displacement signal is exactly flat (zero
 *  velocity), so raw argmin on doubly-integrated accelerometer noise is
 *  hunting for the minimum of what is, in that stretch, pure random walk —
 *  it can and does land anywhere within a long pause depending on the noise
 *  realization. A ~300ms moving average washes that walk out without
 *  touching the genuine, much larger displacement signal either side of it. */
function smooth(x: readonly number[], halfWin: number): number[] {
  const out = new Array<number>(x.length);
  for (let i = 0; i < x.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - halfWin); j <= Math.min(x.length - 1, i + halfWin); j++) {
      sum += x[j];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

/** First index in [from, to] where |x| exceeds `threshold`. Used on `aVert`
 *  (not `v`) to find phase boundaries: near a phase transition, acceleration
 *  rises linearly in time while re-integrated velocity rises quadratically
 *  (v is its integral), so a threshold on acceleration crosses with far less
 *  lag — and, being a per-sample instantaneous value rather than an
 *  accumulated integral, it doesn't inherit the slow, filtered drift that
 *  makes a velocity-threshold search unreliable across a bottom pause. */
function firstAboveThreshold(x: readonly number[], threshold: number, from: number, to: number): number {
  let i = from;
  while (i < to && Math.abs(x[i]) <= threshold) i++;
  return i;
}

/** Symmetric to firstAboveThreshold, scanning backward from `to`. */
function lastAboveThreshold(x: readonly number[], threshold: number, from: number, to: number): number {
  let i = to;
  while (i > from && Math.abs(x[i]) <= threshold) i--;
  return i;
}

function phaseMetrics(
  t: readonly number[],
  v: readonly number[],
  s: readonly number[],
  from: number,
  to: number,
  direction: 'up' | 'down'
): PhaseMetrics {
  let peak = v[from];
  let min = v[from];
  for (let i = from; i <= to; i++) {
    if (direction === 'up') {
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
    // mean velocity = displacement / duration (the trapezoid identity
    // ∫v dt = Δs), so this is self-consistent with the reported ROM by
    // construction — never re-sum velocities separately.
    meanVelocity: dt > 0 ? (s[to] - s[from]) / dt : 0,
    durationMs: dt * 1000,
    rangeOfMotion: Math.abs(s[to] - s[from]),
  };
}

function timeToPeak(t: readonly number[], v: readonly number[], from: number, to: number): number {
  let peakIdx = from;
  for (let i = from; i <= to; i++) if (v[i] > v[peakIdx]) peakIdx = i;
  return (t[peakIdx] - t[from]) * 1000;
}

// --- streaming processor -----------------------------------------------

type Frame = { t: number; aVert: number; still: boolean; lossy: boolean; frameIndex: number };

type Pending = { crossedAtT: number };
type StartPending = Pending & { crossFrameIndex: number };
type Candidate = { startIdx: number; confirmedAtT: number };

type State = {
  tuning: VbtTuning;

  // time base
  prevRawTs: number | null;
  tSec: number; // monotonic internal clock, seconds since last reset

  // gravity calibration
  rawWindow: { t: number; ax: number; ay: number; az: number }[];
  calib: Calibration | null;
  idleStillSinceT: number | null;
  recalDoneThisIdle: boolean;

  // filter + live integration (pass A)
  lpfY: number;
  prevAVert: number | null;
  liveV: number;

  // frame history (pass B input)
  frames: Frame[];
  frameBase: number; // frameIndex of frames[0]
  nextFrameIndex: number;

  // rep segmentation
  repState: RepState;
  candidate: Candidate | null;
  pendingStart: StartPending | null;
  pendingAscend: Pending | null;
  pendingEnd: Pending | null;
  repIndex: number;

  // drained by takeReps()
  outReps: Rep[];
  outRejected: RejectedRep[];

  // Opt-in, unbounded session recorder — off (false) for the live streaming
  // processor, which could run for a whole gym session and can't afford to
  // grow forever. On (true) only for analyzeSession's one-shot batch pass
  // over an already-finite recorded set, so a screen can plot a velocity
  // curve that's pixel-for-pixel the same computation as the rep table next
  // to it (see closeRep) instead of a separately-reconciled live estimate.
  recordSession: boolean;
  sessT: number[];
  sessAx: number[];
  sessAy: number[];
  sessAz: number[];
  sessV: number[];
};

function createState(tuning: VbtTuning, recordSession = false): State {
  return {
    tuning,
    prevRawTs: null,
    tSec: 0,
    rawWindow: [],
    calib: null,
    idleStillSinceT: null,
    recalDoneThisIdle: false,
    lpfY: 0,
    prevAVert: null,
    liveV: 0,
    frames: [],
    frameBase: 0,
    nextFrameIndex: 0,
    repState: 'idle',
    candidate: null,
    pendingStart: null,
    pendingAscend: null,
    pendingEnd: null,
    repIndex: 0,
    outReps: [],
    outRejected: [],
    recordSession,
    sessT: [],
    sessAx: [],
    sessAy: [],
    sessAz: [],
    sessV: [],
  };
}

/** Everything but the sample counters / drained queues — shared by the
 *  public reset() and the DT_MAX_S hard-reset path inside push(). */
function resetPhysics(s: State): void {
  s.calib = null;
  s.idleStillSinceT = null;
  s.recalDoneThisIdle = false;
  s.lpfY = 0;
  s.prevAVert = null;
  s.liveV = 0;
  s.frames = [];
  s.frameBase = s.nextFrameIndex;
  s.repState = 'idle';
  s.candidate = null;
  s.pendingStart = null;
  s.pendingAscend = null;
  s.pendingEnd = null;
  s.tSec = 0;
  s.rawWindow = [];
}

function reset(s: State): void {
  resetPhysics(s);
  s.prevRawTs = null;
  s.repIndex = 0;
  s.outReps = [];
  s.outRejected = [];
}

function appendRaw(s: State, sample: RawSample): void {
  s.rawWindow.push({ t: s.tSec, ax: sample.ax, ay: sample.ay, az: sample.az });
  const cutoff = s.tSec - s.tuning.CALIB_MS / 1000;
  let cut = 0;
  while (cut < s.rawWindow.length && s.rawWindow[cut].t < cutoff) cut++;
  if (cut > 0) s.rawWindow.splice(0, cut);
}

function tryCalibrate(s: State): void {
  const T = s.tuning;
  // rawWindow is already trimmed to a trailing CALIB_MS by appendRaw, so its
  // length alone is the readiness gate — CALIB_MIN_SAMPLES guards against
  // calibrating off a window that's sparse because of packet loss, not
  // against a window that's merely young (checking span here too would just
  // fight the trim: the window can never span more than the trim keeps).
  if (s.rawWindow.length < T.CALIB_MIN_SAMPLES) return;

  const calib = calibrate(
    s.rawWindow.map((r) => ({ x: r.ax, y: r.ay, z: r.az })),
    T
  );
  if (!calib) return;

  s.calib = calib;
  s.lpfY = 0;
  s.prevAVert = null;
  s.liveV = 0;
  s.frames = [];
  s.frameBase = s.nextFrameIndex;
}

/** Re-estimates gravity once per continuous idle-still period (>= 1.5s by
 *  default) — the "accepted, narrowly" half of PLAN-V2.md §2.2: it gets
 *  thermal-drift / re-taped-sensor corrections for free by reusing the ZUPT
 *  still detector, and structurally cannot run mid-rep, so it can't eat
 *  signal the way a continuous gravity tracker would. */
function updateRecal(s: State, still: boolean): void {
  const T = s.tuning;
  if (s.repState !== 'idle' || !still) {
    s.idleStillSinceT = null;
    s.recalDoneThisIdle = false;
    return;
  }
  if (s.idleStillSinceT === null) {
    s.idleStillSinceT = s.tSec;
    return;
  }
  if (s.recalDoneThisIdle) return;
  if ((s.tSec - s.idleStillSinceT) * 1000 < T.RECAL_IDLE_MS) return;

  const calib = calibrate(
    s.rawWindow.map((r) => ({ x: r.ax, y: r.ay, z: r.az })),
    T
  );
  if (calib) s.calib = calib;
  s.recalDoneThisIdle = true;
}

/** ZUPT still detector: RMS of the filtered a_vert over a trailing window,
 *  requiring at least half the nominal (100 Hz) sample count to be present.
 *  The window length is the whole discriminator — a squat's velocity is
 *  curved throughout, so |a_vert| is near zero only for an instant (the
 *  velocity peak), never for a continuous 300ms, so this can't be fooled by
 *  the accel zero-crossing at mid-descent the way an instantaneous check
 *  would be. */
function isStill(s: State, currentAVert: number): boolean {
  const T = s.tuning;
  const cutoff = s.tSec - T.STILL_WIN_MS / 1000;
  let sumSq = currentAVert * currentAVert;
  let count = 1;
  for (let i = s.frames.length - 1; i >= 0 && s.frames[i].t >= cutoff; i--) {
    sumSq += s.frames[i].aVert * s.frames[i].aVert;
    count++;
  }
  const nominalCount = Math.max(1, Math.round(T.STILL_WIN_MS / 10)); // 10ms @ 100Hz
  if (count < nominalCount / 2) return false;
  return Math.sqrt(sumSq / count) <= T.STILL_ACC_RMS;
  // ponytail: O(window) backward scan per sample (~30 iterations at 100 Hz /
  // 300ms). Upgrade: running sum-of-squares with head/tail indices — only if
  // a profiler ever says so, which it won't.
}

function findStartIdx(s: State, pending: StartPending): number {
  // Find the last still=true frame at/before the crossing, then always pad
  // further back by LEAD_MS — not only when no still frame exists at all —
  // so the window comfortably starts before the true onset. The still
  // detector's own RMS window lags real quiet by a bit, so treating its
  // last "still" reading as the exact boundary and skipping this pad would
  // clip into real motion; firstAboveThreshold in closeRep does the precise
  // part once the window has enough lead-in to work with.
  let baseT = pending.crossedAtT;
  for (let i = s.frames.length - 1; i >= 0; i--) {
    const f = s.frames[i];
    if (f.frameIndex > pending.crossFrameIndex) continue;
    if (f.still) {
      baseT = f.t;
      break;
    }
  }
  const target = baseT - s.tuning.LEAD_MS / 1000;
  for (const f of s.frames) if (f.t >= target) return f.frameIndex;
  return s.frames.length > 0 ? s.frames[0].frameIndex : pending.crossFrameIndex;
}

function abortIfTooLong(s: State): void {
  if (!s.candidate) return;
  if ((s.tSec - s.candidate.confirmedAtT) * 1000 > s.tuning.REP_MAX_MS) {
    s.repState = 'idle';
    s.candidate = null;
    s.pendingAscend = null;
    s.pendingEnd = null;
  }
}

function closeRep(s: State, endFrameIndex: number): void {
  const T = s.tuning;
  const candidate = s.candidate!;
  s.repState = 'idle';
  s.candidate = null;
  s.pendingAscend = null;
  s.pendingEnd = null;

  const startArrIdx = candidate.startIdx - s.frameBase;
  const endArrIdx = endFrameIndex - s.frameBase;
  const reject = (reason: RejectedRep['reason']) =>
    s.outRejected.push({ reason, startedAtMs: candidate.confirmedAtT * 1000 });

  if (startArrIdx < 0 || endArrIdx >= s.frames.length || endArrIdx <= startArrIdx) {
    reject('duration');
    return;
  }

  const window = s.frames.slice(startArrIdx, endArrIdx + 1);
  const t = window.map((f) => f.t);
  const aVert = window.map((f) => f.aVert);
  const n = t.length;

  // Clean re-integration from v=0 over the STORED filtered a_vert — never
  // reuse the live pass-A velocity here, it has ZUPT clamps baked in that
  // would corrupt the drift (bias) estimate below.
  const v = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) v[i] = v[i - 1] + 0.5 * (aVert[i - 1] + aVert[i]) * (t[i] - t[i - 1]);
  const bias = detrend(t, v);

  const s_ = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) s_[i] = s_[i - 1] + 0.5 * (v[i - 1] + v[i]) * (t[i] - t[i - 1]);

  const durationMs = (t[n - 1] - t[0]) * 1000;
  if (durationMs < T.REP_MIN_MS || durationMs > T.REP_MAX_MS) {
    reject('duration');
    return;
  }

  let sMin = s_[0],
    sMax = s_[0];
  for (const val of s_) {
    if (val < sMin) sMin = val;
    if (val > sMax) sMax = val;
  }
  if (sMax - sMin < T.ROM_MIN_M || sMax - sMin > T.ROM_MAX_M) {
    reject('rom');
    return;
  }
  if (Math.abs(s_[n - 1]) > T.ROM_RETURN_MAX_M) {
    reject('return');
    return;
  }

  // Detection above is causal (velocity thresholds); measurement here is
  // not, and refines the phase boundaries against displacement extrema and
  // acceleration — see PLAN-V2.md §2.6 for why these are deliberately
  // different. Boundaries are found on aVert rather than v: a paused squat
  // holds near-zero velocity (and near-constant displacement) throughout
  // the whole pause, so a velocity-based search can't tell "still paused"
  // from "started moving again" — but acceleration rises immediately when
  // real motion resumes, threshold and all, with no pause-length dependence.
  // halfWin = STILL_WIN_MS in samples (nominal 10ms period @ 100Hz), giving
  // a ~2*STILL_WIN_MS smoothing window — wide enough to average out the
  // random walk over a typical bottom pause without smoothing away the much
  // larger, faster displacement swing on either side of it.
  const turnIdx = argmin(smooth(s_, Math.round(T.STILL_WIN_MS / 10)));
  // ponytail: fixed-width smoothing to locate the bottom, not a bounded
  // search around the live FSM's own turnaround estimate. Ceiling: an
  // unusually long/uneven paused rep could still let noise walk the smoothed
  // minimum a bit off the true bottom. Upgrade: bound the argmin search to a
  // window around the live descending->turnaround transition time, which the
  // FSM already computes — only worth it if real sessions show turnIdx
  // landing somewhere implausible.
  const eccStart = Math.min(firstAboveThreshold(aVert, T.STILL_ACC_RMS, 0, turnIdx), turnIdx);
  const conEnd = Math.max(lastAboveThreshold(aVert, T.STILL_ACC_RMS, turnIdx, n - 1), turnIdx);
  const conStart = Math.min(Math.max(firstAboveThreshold(aVert, T.STILL_ACC_RMS, turnIdx, conEnd), turnIdx), conEnd);

  const eccentric = phaseMetrics(t, v, s_, eccStart, turnIdx, 'down');
  const concentric = phaseMetrics(t, v, s_, conStart, conEnd, 'up');

  // candidate.startIdx is an absolute frameIndex, and sessV is append-only
  // (never trimmed the way s.frames is), so it indexes directly — this is
  // what makes the batch-analyzed velocity curve exactly reproduce these
  // same numbers instead of a separately-reconciled live estimate.
  if (s.recordSession) for (let i = 0; i < v.length; i++) s.sessV[candidate.startIdx + i] = v[i];

  s.repIndex += 1;
  s.outReps.push({
    index: s.repIndex,
    startedAtMs: candidate.confirmedAtT * 1000,
    eccentric,
    concentric,
    peakConcentricVelocity: concentric.peakVelocity,
    meanConcentricVelocity: concentric.meanVelocity,
    timeToPeakMs: timeToPeak(t, v, turnIdx, conEnd),
    totalDurationMs: (t[conEnd] - t[eccStart]) * 1000,
    residualBias: bias,
    lossy: window.some((f) => f.lossy),
  });
}

function stepFsm(s: State, frameIndex: number, still: boolean): void {
  const T = s.tuning;
  const v = s.liveV;
  const nowT = s.tSec;

  switch (s.repState) {
    case 'idle':
      if (v < T.V_START) {
        if (!s.pendingStart) {
          s.pendingStart = { crossedAtT: nowT, crossFrameIndex: frameIndex };
        } else if ((nowT - s.pendingStart.crossedAtT) * 1000 >= T.MIN_ECC_MS) {
          s.candidate = { startIdx: findStartIdx(s, s.pendingStart), confirmedAtT: nowT };
          s.repState = 'descending';
          s.pendingStart = null;
        }
      } else {
        s.pendingStart = null;
      }
      return;

    case 'descending':
      abortIfTooLong(s);
      if (s.repState !== 'descending') return;
      if (v > T.V_TURN) {
        s.repState = 'turnaround';
        s.pendingAscend = null;
      }
      return;

    case 'turnaround':
      abortIfTooLong(s);
      if (s.repState !== 'turnaround') return;
      if (v < T.V_START) {
        s.repState = 'descending'; // re-dip at the bottom: same rep, keep candidate.startIdx
        s.pendingAscend = null;
      } else if (v > T.V_UP) {
        if (!s.pendingAscend) {
          s.pendingAscend = { crossedAtT: nowT };
        } else if ((nowT - s.pendingAscend.crossedAtT) * 1000 >= T.MIN_CON_MS) {
          s.repState = 'ascending';
          s.pendingAscend = null;
        }
      } else {
        s.pendingAscend = null;
      }
      return;

    case 'ascending':
      abortIfTooLong(s);
      if (s.repState !== 'ascending') return;
      if (still) {
        closeRep(s, frameIndex);
        return;
      }
      if (v < T.V_END) {
        if (!s.pendingEnd) {
          s.pendingEnd = { crossedAtT: nowT };
        } else if ((nowT - s.pendingEnd.crossedAtT) * 1000 >= T.END_HOLD_MS) {
          closeRep(s, frameIndex);
        }
      } else {
        s.pendingEnd = null;
      }
  }
}

function trimFrames(s: State): void {
  const cutoff = s.tSec - s.tuning.HISTORY_S;
  let cut = 0;
  while (cut < s.frames.length && s.frames[cut].t < cutoff) cut++;
  if (cut > 0) {
    s.frames.splice(0, cut);
    s.frameBase += cut;
  }
}

function push(s: State, sample: RawSample): void {
  const T = s.tuning;

  if (s.prevRawTs === null) {
    s.prevRawTs = sample.timestamp;
    appendRaw(s, sample);
    return;
  }

  const dt = deltaUs(s.prevRawTs, sample.timestamp) / 1e6;
  if (dt < T.DT_MIN_S) return; // firmware boot burst / dup timestamp — discard, don't advance prevRawTs
  s.prevRawTs = sample.timestamp;

  if (dt > T.DT_MAX_S) {
    // Hard discontinuity: reboot, link stall, backgrounding. Reset
    // everything physics-related — including calibration, which can no
    // longer be trusted across an unknown gap — and reject any rep in flight
    // rather than silently dropping it.
    const hadCandidate = s.repState !== 'idle';
    const openedAtMs = (s.candidate ? s.candidate.confirmedAtT : s.tSec) * 1000;
    resetPhysics(s);
    appendRaw(s, sample);
    if (hadCandidate) s.outRejected.push({ reason: 'gap', startedAtMs: openedAtMs });
    return;
  }

  const lossy = dt > T.DT_GAP_S;
  s.tSec += dt;
  appendRaw(s, sample);

  if (!s.calib) {
    tryCalibrate(s);
    return; // no integration until calibrated
  }

  const raw = sample.ax * s.calib.ux + sample.ay * s.calib.uy + sample.az * s.calib.uz - s.calib.gMag;

  // One-pole low-pass, coefficient recomputed per sample from the real dt —
  // what makes this correct across dropped packets, where a fixed-coefficient
  // Butterworth would need the uniform grid this design deliberately doesn't
  // have. LPF_HZ very high sends alpha -> 1, i.e. passthrough.
  const rc = 1 / (2 * Math.PI * T.LPF_HZ);
  const alpha = dt / (dt + rc);
  s.lpfY += alpha * (raw - s.lpfY);
  const aVert = s.lpfY;

  const prevA = s.prevAVert ?? aVert;
  let v = s.liveV + 0.5 * (prevA + aVert) * dt;
  s.prevAVert = aVert;

  const still = isStill(s, aVert);
  if (still && Math.abs(v) < T.ZUPT_V_MAX) v = 0;
  s.liveV = v;

  const frameIndex = s.nextFrameIndex++;
  s.frames.push({ t: s.tSec, aVert, still, lossy, frameIndex });
  trimFrames(s);

  if (s.recordSession) {
    s.sessT.push(s.tSec);
    s.sessAx.push(sample.ax);
    s.sessAy.push(sample.ay);
    s.sessAz.push(sample.az);
    s.sessV.push(0); // overwritten for frames inside an accepted rep, see closeRep
  }

  stepFsm(s, frameIndex, still);
  updateRecal(s, still);
}

export function createVbtProcessor(tuning?: Partial<VbtTuning>): VbtProcessor {
  const s = createState({ ...VBT_TUNING, ...tuning });
  return {
    push: (sample) => push(s, sample),
    get live(): LiveState {
      const last = s.frames[s.frames.length - 1];
      return {
        calibrated: s.calib !== null,
        still: last ? last.still : false,
        state: s.repState,
        aVert: s.prevAVert ?? 0,
        vVert: s.liveV,
      };
    },
    takeReps: () => {
      const reps = s.outReps;
      const rejected = s.outRejected;
      s.outReps = [];
      s.outRejected = [];
      return { reps, rejected };
    },
    reset: () => reset(s),
  };
}

/** Batch entry point: create a processor, loop, drain. Not a parallel
 *  implementation — it exercises the exact production push() path,
 *  including the state machine's causality, which is what makes it a
 *  trustworthy correctness gate (see vbt.test.ts). */
export type SessionTrace = { t: number[]; ax: number[]; ay: number[]; az: number[]; v: number[] };

export function analyzeSession(
  samples: readonly RawSample[],
  tuning?: Partial<VbtTuning>
): { reps: Rep[]; rejected: RejectedRep[]; calibration: Calibration | null; session: SessionTrace } {
  const s = createState({ ...VBT_TUNING, ...tuning }, true);
  for (const sample of samples) push(s, sample);
  return {
    reps: s.outReps,
    rejected: s.outRejected,
    calibration: s.calib,
    session: { t: s.sessT, ax: s.sessAx, ay: s.sessAy, az: s.sessAz, v: s.sessV },
  };
}
