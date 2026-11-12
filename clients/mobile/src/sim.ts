// Squat simulator: a deterministic stream of RawSample packets with known
// ground truth. Two jobs:
//   1. Demo mode — lets the UI be designed and demoed with no sensor attached.
//   2. Error benchmark — SIM_SCENARIOS reproduces the situations where the
//      real pipeline struggles (slow grinds, tempo, long pauses, bounces,
//      walkout/re-rack), and `truth` says exactly what the right answer is,
//      so changes to vbt.ts can be scored (see scripts/bench.ts).
//
// Zero runtime imports (type-only import below is erased), so `node --test`
// can load it, same constraint as vbt.ts.
//
// Model: the bar's vertical VELOCITY is a chain of smooth segments, each a
// cosine-eased ramp v0 -> v1 over `dur` seconds. Acceleration is the exact
// derivative of that, and position is its exact integral, so ground truth
// (ROM, peak and mean velocity per phase) is computed from the same path the
// accelerometer is fed from. The accelerometer then reads specific force
// (g + a_vert up, plus horizontal terms), optionally tilted by a slowly
// varying bar angle (walkout), pushed through an arbitrary mounting
// orientation, and corrupted with bias / scale error / noise / dropouts.

import type { RawSample } from './vbt';

export type SimStyle =
  | 'smooth' // down, optional pause, up — the textbook squat
  | 'bounce' // no pause: velocity reverses at the bottom in `reversalS`
  | 'grind'; // ascent with a sticking point where the bar nearly stalls

export type SimOptions = {
  reps: number;
  romM: number; // nominal squat depth, metres (bounce reps overshoot slightly)
  tEccS: number; // descent duration
  tConS: number; // ascent duration (grind: total, sticking point included)
  pauseS: number; // bottom pause (smooth/grind only)
  style: SimStyle;
  reversalS: number; // bounce only: how long the bottom reversal takes
  fatigue: number; // each rep's ascent is this fraction slower than the last
  restBetweenRepsS: number; // standing still between reps
  leadS: number; // stillness before anything happens (calibration window)
  walkout: boolean; // unrack + walk back before the set
  rerack: boolean; // walk forward + rerack after the set
  noiseSigma: number; // m/s^2
  bias: [number, number, number]; // m/s^2 per sensor axis
  scale: number; // accelerometer scale error (1.0 = perfect)
  dropoutRate: number; // fraction of packets lost over the air
  seed: number;
};

export const DEFAULT_SIM: SimOptions = {
  reps: 5,
  romM: 0.5,
  tEccS: 1.4,
  tConS: 0.85,
  pauseS: 0.25,
  style: 'smooth',
  reversalS: 0.2,
  fatigue: 0,
  restBetweenRepsS: 1.2,
  leadS: 2.0,
  walkout: true,
  rerack: true,
  noiseSigma: 0.03,
  bias: [0.05, -0.08, 0.12],
  scale: 1.0,
  dropoutRate: 0,
  seed: 7,
};

export type TruthRep = {
  index: number;
  startS: number;
  bottomS: number; // instant the bar first reaches its lowest position (end of eccentric)
  ascentStartS: number; // instant the bar starts rising again — after any bottom pause
  endS: number;
  romM: number; // measured depth of this rep
  peakConcentricVelocity: number;
  meanConcentricVelocity: number; // displacement / duration, ascentStartS -> endS (start of the rise to lockout)
  peakEccentricVelocity: number; // negative
};

export type SimPhase = { name: 'rest' | 'walkout' | 'set' | 'rerack'; startS: number; endS: number };

export type SimSession = {
  samples: RawSample[];
  truth: { reps: TruthRep[]; phases: SimPhase[]; durationS: number };
};

const G = 9.81;
export const SIM_HZ = 100;
const DT_S = 1 / SIM_HZ;

// --- deterministic RNG (mulberry32 + Box-Muller) ---------------------------

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
}

// --- velocity segments -----------------------------------------------------

type Seg = { t0: number; dur: number; v0: number; v1: number };
/** A segment before it has an absolute start time. */
type RelSeg = { dur: number; v0: number; v1: number };

/** Net displacement of a cosine-eased ramp: exactly the trapezoid. */
function disp(s: RelSeg): number {
  return ((s.v0 + s.v1) / 2) * s.dur;
}

function scaleSegs(segs: RelSeg[], k: number): RelSeg[] {
  return segs.map((s) => ({ dur: s.dur, v0: s.v0 * k, v1: s.v1 * k }));
}

function sumDisp(segs: RelSeg[]): number {
  return segs.reduce((a, s) => a + disp(s), 0);
}

function segAccel(s: Seg, t: number): number {
  if (s.dur <= 0 || t < s.t0 || t > s.t0 + s.dur) return 0;
  return ((s.v1 - s.v0) / 2) * (Math.PI / s.dur) * Math.sin((Math.PI * (t - s.t0)) / s.dur);
}

function segVel(s: Seg, t: number): number {
  const u = (t - s.t0) / s.dur;
  return s.v0 + ((s.v1 - s.v0) * (1 - Math.cos(Math.PI * u))) / 2;
}

/** Velocity at time t for a chain of segments. Outside every segment the bar
 *  is held at 0 (rests, pauses): chains always start and end at v = 0. */
function velocityAt(segs: Seg[], t: number): number {
  for (const s of segs) if (t >= s.t0 && t <= s.t0 + s.dur) return segVel(s, t);
  return 0;
}

// --- rep recipes -------------------------------------------------------------

/** Descent that ends at rest: ramp up, cruise, ramp down. Unit peak = 1. */
function descentUnit(tEcc: number): RelSeg[] {
  return [
    { dur: 0.35 * tEcc, v0: 0, v1: -1 },
    { dur: 0.3 * tEcc, v0: -1, v1: -1 },
    { dur: 0.35 * tEcc, v0: -1, v1: 0 },
  ];
}

/** Ascent that ends at rest. Fast peak early, long decel into lockout. */
function ascentUnit(tCon: number): RelSeg[] {
  return [
    { dur: 0.3 * tCon, v0: 0, v1: 1 },
    { dur: 0.2 * tCon, v0: 1, v1: 1 },
    { dur: 0.5 * tCon, v0: 1, v1: 0 },
  ];
}

/** Ascent with a sticking point: the bar surges, nearly stalls for a stretch,
 *  then grinds through. Slowest part is a quarter of the surge speed. */
function grindUnit(tCon: number): RelSeg[] {
  return [
    { dur: 0.2 * tCon, v0: 0, v1: 1 },
    { dur: 0.25 * tCon, v0: 1, v1: 0.25 },
    { dur: 0.25 * tCon, v0: 0.25, v1: 0.25 },
    { dur: 0.15 * tCon, v0: 0.25, v1: 0.6 },
    { dur: 0.15 * tCon, v0: 0.6, v1: 0 },
  ];
}

/** Ascent that starts already moving (continuing out of a bounce). */
function bounceAscentUnit(tCon: number): RelSeg[] {
  return [
    { dur: 0.2 * tCon, v0: 0.5, v1: 1 },
    { dur: 0.15 * tCon, v0: 1, v1: 1 },
    { dur: 0.65 * tCon, v0: 1, v1: 0 },
  ];
}

/** Builds one rep's relative segment chain plus where its bottom falls. */
function buildRep(o: SimOptions, tCon: number): { segs: RelSeg[] } {
  if (o.style === 'bounce') {
    // Descent at speed -vE straight into a reversal that carries through
    // zero into the ascent, with no pause. Net displacement over the whole
    // chain must be zero (the bar returns to where it started), which is one
    // linear equation in the ascent scale k once vE is fixed.
    const rev = Math.max(0.04, o.reversalS);
    // descent covers vE*(0.8*tEcc - rev/2); the reversal adds a little more before
    // v crosses zero. 0.3*rev is a fitted allowance; truth.romM reports the real depth.
    const vE = o.romM / (0.8 * o.tEccS - 0.3 * rev);
    const down: RelSeg[] = [
      { dur: 0.4 * o.tEccS, v0: 0, v1: -vE },
      { dur: Math.max(0.01, 0.6 * o.tEccS - rev / 2), v0: -vE, v1: -vE },
    ];
    const up = bounceAscentUnit(tCon);
    // reversal: -vE -> +0.5k ; net = sum(down) + (-vE + 0.5k)/2*rev + k*sum(up) = 0
    const k = -(sumDisp(down) + (-vE / 2) * rev) / (sumDisp(up) + 0.25 * rev);
    return {
      segs: [...down, { dur: rev, v0: -vE, v1: 0.5 * k }, ...scaleSegs(up, k)],
    };
  }

  const desc = descentUnit(o.tEccS);
  const down = scaleSegs(desc, -o.romM / sumDisp(desc)); // sumDisp(desc) < 0 -> positive scale
  const upUnit = o.style === 'grind' ? grindUnit(tCon) : ascentUnit(tCon);
  const up = scaleSegs(upUnit, o.romM / sumDisp(upUnit));
  return { segs: [...down, { dur: o.pauseS, v0: 0, v1: 0 }, ...up] };
}

// --- cosine-eased position moves (unrack bump only) --------------------------

type Move = { t0: number; dur: number; from: number; to: number };

function moveAccel(m: Move, t: number): number {
  if (t < m.t0 || t > m.t0 + m.dur) return 0;
  const w = Math.PI / m.dur;
  return ((m.to - m.from) / 2) * w * w * Math.cos(w * (t - m.t0));
}

function smoothstep(x: number): number {
  const u = Math.min(1, Math.max(0, x));
  return u * u * (3 - 2 * u);
}

// --- the session -------------------------------------------------------------

export function simulateSquatSession(overrides: Partial<SimOptions> = {}): SimSession {
  const o: SimOptions = { ...DEFAULT_SIM, ...overrides };
  const r = rng(o.seed);

  const moves: Move[] = [];
  const segs: Seg[] = [];
  const repSpans: { startS: number; endS: number }[] = [];
  const phases: SimPhase[] = [];

  let t = o.leadS;
  phases.push({ name: 'rest', startS: 0, endS: o.leadS });

  // Walkout: unrack (bar rises ~5 cm and returns, taking the weight off the
  // hooks), then ~6 s of stepping backwards. The bar bounces and sways with
  // the gait and the lifter's torso tilts it a few degrees.
  const WALK_S = 6;
  let walkout: { start: number; end: number } | null = null;
  if (o.walkout) {
    moves.push({ t0: t, dur: 0.5, from: 0, to: 0.05 });
    moves.push({ t0: t + 0.5, dur: 0.5, from: 0.05, to: 0 });
    walkout = { start: t, end: t + 1 + WALK_S };
    phases.push({ name: 'walkout', startS: walkout.start, endS: walkout.end });
    t = walkout.end;
  }
  const setStart = t + 1.0;
  t = setStart;

  for (let i = 0; i < o.reps; i++) {
    const tCon = o.tConS * Math.pow(1 + o.fatigue, i);
    const { segs: rel } = buildRep(o, tCon);
    const startS = t;
    for (const s of rel) {
      segs.push({ t0: t, ...s });
      t += s.dur;
    }
    repSpans.push({ startS, endS: t });
    t += o.restBetweenRepsS;
  }
  phases.push({ name: 'set', startS: setStart, endS: t - o.restBetweenRepsS });

  let rerack: { start: number; end: number } | null = null;
  if (o.rerack) {
    rerack = { start: t, end: t + WALK_S + 1 };
    moves.push({ t0: rerack.end - 1, dur: 0.4, from: 0, to: 0.05 });
    moves.push({ t0: rerack.end - 0.6, dur: 0.4, from: 0.05, to: 0 });
    phases.push({ name: 'rerack', startS: rerack.start, endS: rerack.end });
    t = rerack.end;
  }
  const durationS = t + 2.0;

  // Ground truth, from the exact velocity path sampled at 1 kHz.
  const truthReps: TruthRep[] = repSpans.map((span, i) => {
    const STEP = 0.001;
    const n = Math.round((span.endS - span.startS) / STEP);
    const p = new Float64Array(n + 1);
    const v = new Float64Array(n + 1);
    for (let k = 0; k <= n; k++) v[k] = velocityAt(segs, span.startS + k * STEP);
    for (let k = 1; k <= n; k++) p[k] = p[k - 1] + 0.5 * (v[k - 1] + v[k]) * STEP;
    let iBottom = 0;
    for (let k = 1; k <= n; k++) if (p[k] < p[iBottom]) iBottom = k;
    // The concentric starts when the bar starts RISING, not when it reaches
    // the bottom: with a pause the two differ by the whole pause, and counting
    // it would make a paused rep look slow. Walk forward past the dead time.
    let iAscent = iBottom;
    while (iAscent < n && v[iAscent + 1] <= 1e-3) iAscent++;
    let peakCon = 0;
    let peakEcc = 0;
    for (let k = 0; k <= n; k++) {
      if (k >= iAscent && v[k] > peakCon) peakCon = v[k];
      if (k <= iBottom && v[k] < peakEcc) peakEcc = v[k];
    }
    const conDur = (n - iAscent) * STEP;
    return {
      index: i + 1,
      startS: span.startS,
      bottomS: span.startS + iBottom * STEP,
      ascentStartS: span.startS + iAscent * STEP,
      endS: span.endS,
      romM: -p[iBottom],
      peakConcentricVelocity: peakCon,
      meanConcentricVelocity: conDur > 0 ? (p[n] - p[iAscent]) / conDur : 0,
      peakEccentricVelocity: peakEcc,
    };
  });

  // Mounting: an arbitrary "up" direction in sensor space, via one
  // Gram-Schmidt step (same trick as vbt.test.ts).
  const u = norm([0.31, -0.47, 0.83]);
  const seedV: [number, number, number] = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = norm(cross(u, seedV));
  const e2 = cross(u, e1);

  const samples: RawSample[] = [];
  const n = Math.round(durationS * SIM_HZ);
  for (let i = 0; i < n; i++) {
    const ts = i * DT_S;

    let aVert = 0;
    for (const s of segs) aVert += segAccel(s, ts);
    for (const m of moves) aVert += moveAccel(m, ts);

    let fx = 0; // horizontal specific force, world X
    let fy = 0;
    let tiltRad = 0;

    for (const w of [walkout, rerack]) {
      if (!w || ts < w.start || ts > w.end) continue;
      const k = ts - w.start;
      const span = w.end - w.start;
      // Gait: ~1.8 Hz steps, strongest in the middle of the walk.
      const env = smoothstep(k / 1.2) * smoothstep((span - k) / 1.2);
      const gait = Math.sin(2 * Math.PI * 1.8 * k);
      aVert += 0.9 * env * gait;
      fx += 1.1 * env * Math.sin(2 * Math.PI * 0.9 * k + 0.6);
      fy += 0.5 * env * Math.cos(2 * Math.PI * 0.9 * k);
      // Torso tilt of the bar while unracked: up to ~7 degrees.
      tiltRad = Math.max(tiltRad, ((7 * Math.PI) / 180) * env);
    }
    // Slight lateral sway during the set itself.
    fx += 0.25 * Math.sin(2 * Math.PI * 1.1 * ts);

    const c = Math.cos(tiltRad);
    const s = Math.sin(tiltRad);
    const fz = G + aVert;
    const fxT = fx * c + fz * s;
    const fzT = -fx * s + fz * c;

    const bx = e1[0] * fxT + e2[0] * fy + u[0] * fzT;
    const by = e1[1] * fxT + e2[1] * fy + u[1] * fzT;
    const bz = e1[2] * fxT + e2[2] * fy + u[2] * fzT;

    const ax = o.scale * bx + o.bias[0] + gauss(r) * o.noiseSigma;
    const ay = o.scale * by + o.bias[1] + gauss(r) * o.noiseSigma;
    const az = o.scale * bz + o.bias[2] + gauss(r) * o.noiseSigma;

    // Dropouts: the packet is lost but the firmware's sequence kept counting.
    if (o.dropoutRate > 0 && r() < o.dropoutRate) continue;

    samples.push({ timestamp: Math.round(ts * 1e6) % 2 ** 32, ax, ay, az, sequence: i });
  }

  return { samples, truth: { reps: truthReps, phases, durationS } };
}

// --- scenario catalog ----------------------------------------------------------

export type SimScenario = {
  id: string;
  label: string;
  description: string;
  opts: Partial<SimOptions>;
};

// Squat only, for now. Every scenario isolates ONE difficulty (walkout and
// re-rack are off) except the last two, which combine them. ROM is ~0.45 m
// throughout, a realistic full squat for bar travel.
const SQ = { walkout: false, rerack: false, reps: 4, romM: 0.45 } as const;

export const SIM_SCENARIOS: SimScenario[] = [
  { id: 'normal', label: 'Normal', description: 'Control: bajada 1,4 s, pausa corta, subida 0,85 s', opts: { ...SQ } },
  { id: 'rapida', label: 'Rápida', description: 'Reps veloces, subida de 0,45 s', opts: { ...SQ, tEccS: 0.9, tConS: 0.45, pauseS: 0.05, restBetweenRepsS: 1.0 } },
  { id: 'pausa_corta', label: 'Pausa corta', description: 'Pausa de 0,6 s abajo', opts: { ...SQ, pauseS: 0.6 } },
  { id: 'pausa_larga', label: 'Pausa larga', description: 'Pausa de 3 s abajo', opts: { ...SQ, pauseS: 3.0 } },
  { id: 'tempo_lento', label: 'Tempo lento', description: 'Bajada de 4 s, sin pausa, subida 1 s', opts: { ...SQ, tEccS: 4, pauseS: 0.05, tConS: 1.0 } },
  { id: 'tempo_pausa', label: 'Tempo + pausa', description: 'Bajada 4 s, pausa 4 s, subida 1,5 s', opts: { ...SQ, tEccS: 4, pauseS: 4, tConS: 1.5 } },
  { id: 'rebote_suave', label: 'Rebote suave', description: 'Sin pausa, giro abajo en 0,25 s', opts: { ...SQ, style: 'bounce', reversalS: 0.25, tEccS: 1.0, tConS: 0.8, restBetweenRepsS: 0.4 } },
  { id: 'rebote_brusco', label: 'Rebote brusco', description: 'Sin pausa, giro abajo en 0,08 s (aceleraciones altas)', opts: { ...SQ, style: 'bounce', reversalS: 0.08, tEccS: 0.8, tConS: 0.7, restBetweenRepsS: 0.4 } },
  { id: 'limite', label: 'Al límite', description: 'Subida de 4 s con punto de estancamiento', opts: { ...SQ, style: 'grind', tConS: 4.0, restBetweenRepsS: 1.5 } },
  { id: 'limite_extremo', label: 'Al límite (PR)', description: 'Subida de 6 s casi frenando, con pausa de 1 s', opts: { ...SQ, style: 'grind', tConS: 6.0, pauseS: 1.0, reps: 2, restBetweenRepsS: 2.0 } },
  { id: 'fatiga', label: 'Serie con fatiga', description: '6 reps, cada subida 25% más lenta que la anterior', opts: { ...SQ, reps: 6, tConS: 0.7, fatigue: 0.25 } },
  { id: 'walkout', label: 'Walkout + re-rack', description: 'Serie normal con sacar y guardar la barra', opts: { ...SQ, walkout: true, rerack: true } },
  { id: 'walkout_lento', label: 'Walkout + tempo', description: 'Sacar y guardar la barra con una serie de tempo+pausa', opts: { ...SQ, walkout: true, rerack: true, tEccS: 3, pauseS: 2, tConS: 1.2, reps: 3 } },
];

function norm(v: [number, number, number]): [number, number, number] {
  const m = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / m, v[1] / m, v[2] / m];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
