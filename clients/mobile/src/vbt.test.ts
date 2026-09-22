import assert from 'node:assert/strict';
import { test } from 'node:test';
// Node's built-in TS runner needs the explicit extension for ESM resolution;
// Metro (which bundles the app itself) resolves extensionless imports fine.
import { analyzeSession, calibrate, createVbtProcessor, VBT_TUNING, type RawSample, type Vec3 } from './vbt.ts';

// --- deterministic RNG (mulberry32 + Box-Muller) -------------------------
// A numeric-tolerance test seeded with Math.random() is a flaky test that
// fails at 3am for no reason. This is fully deterministic.

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

// --- sensor-frame geometry -------------------------------------------------

function normalize(v: Vec3): Vec3 {
  const m = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / m, y: v.y / m, z: v.z / m };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** Builds an orthonormal frame {e1, e2, u} for an arbitrary "up" direction u
 *  in sensor space — one Gram-Schmidt step, no Euler angles, no rotation
 *  library. These three vectors ARE the rows of the rotation matrix. */
function worldBasis(u: Vec3): { e1: Vec3; e2: Vec3 } {
  const seed: Vec3 = Math.abs(u.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const e1 = normalize(cross(u, seed));
  const e2 = cross(u, e1); // already unit: u perp e1, both unit
  return { e1, e2 };
}

// --- synthetic squat -------------------------------------------------------
// v(t) = V*sin^2(pi*t/T) has exact closed-form ground truth and a(0)=a(T)=0
// (no jerk impulse at the phase boundaries, unlike a plain sin() profile):
//   peak velocity = V, mean velocity = V/2, ROM = V*T/2, peak accel = V*pi/T

type SquatParams = {
  vEcc: number;
  tEcc: number;
  vCon: number;
  tCon: number;
  pauseS: number;
  reps: number;
  scale: number; // modelled MPU6050 scale-factor error
  bias: Vec3; // modelled zero-g offset
  sway: boolean; // horizontal bar sway, present specifically to test axis rejection
  noiseSigma: number;
  dropoutInRep: number | null; // rep index (1-based) to drop 3 samples from, or null
  u: Vec3; // sensor-frame "up" — arbitrary orientation on the bar
};

const DEFAULT_PARAMS: SquatParams = {
  vEcc: 0.6,
  tEcc: 1.2,
  vCon: 0.9,
  tCon: 0.8,
  pauseS: 0.3,
  reps: 3,
  scale: 1.0,
  bias: { x: 0.05, y: -0.08, z: 0.12 },
  sway: true,
  noiseSigma: 0.02,
  dropoutInRep: null,
  u: normalize({ x: 0.31, y: -0.47, z: 0.83 }),
};

const G = 9.81;
const HZ = 100;
const DT_US = 1_000_000 / HZ;
// Forces the uint32 timestamp wraparound to be a tested path on every run,
// not a hoped-for one: this session's timestamps cross 2^32 mid-calibration.
const START_US = 2 ** 32 - 3_000_000;

function sinSquaredVelocity(t: number, tPhase: number, vPeak: number, sign: 1 | -1): { v: number; a: number } {
  if (t < 0 || t > tPhase) return { v: 0, a: 0 };
  const w = Math.PI / tPhase;
  return { v: sign * vPeak * Math.sin(w * t) ** 2, a: sign * vPeak * w * Math.sin(2 * w * t) };
}

/** One rep's vertical (v, a) profile, `elapsed` seconds into the rep. */
function repProfile(elapsed: number, p: SquatParams): { v: number; a: number } {
  if (elapsed < p.tEcc) return sinSquaredVelocity(elapsed, p.tEcc, p.vEcc, -1);
  const tCon0 = elapsed - p.tEcc - p.pauseS;
  return sinSquaredVelocity(tCon0, p.tCon, p.vCon, 1);
}

function buildSession(p: SquatParams): RawSample[] {
  const { e1, e2 } = worldBasis(p.u);
  const r = rng(1234);
  const repDurationS = p.tEcc + p.pauseS + p.tCon;
  const leadS = 2.0; // covers the 1s calibration window with margin
  const gapS = 1.5; // still time between reps
  const totalS = leadS + p.reps * repDurationS + (p.reps - 1) * gapS + gapS;

  const samples: RawSample[] = [];
  let sequence = 0;
  const n = Math.round((totalS * 1_000_000) / DT_US);

  for (let i = 0; i < n; i++) {
    const tUs = i * DT_US;
    const tS = tUs / 1e6;

    let aVert = 0;
    if (tS >= leadS) {
      const sinceLead = tS - leadS;
      const repIdx = Math.floor(sinceLead / (repDurationS + gapS));
      const intoSlot = sinceLead - repIdx * (repDurationS + gapS);
      if (repIdx < p.reps && intoSlot < repDurationS) {
        aVert = repProfile(intoSlot, p).a;
      }
    }

    const swayX = p.sway ? 0.3 * Math.sin(2 * Math.PI * 1.1 * tS) : 0;

    const worldVec: Vec3 = {
      x: p.u.x * (G + aVert) + e1.x * swayX,
      y: p.u.y * (G + aVert) + e1.y * swayX,
      z: p.u.z * (G + aVert) + e1.z * swayX,
    };
    void e2; // sway_y is 0 in every case here; e2 kept for a symmetric basis

    const ax = p.scale * worldVec.x + p.bias.x + gauss(r) * p.noiseSigma;
    const ay = p.scale * worldVec.y + p.bias.y + gauss(r) * p.noiseSigma;
    const az = p.scale * worldVec.z + p.bias.z + gauss(r) * p.noiseSigma;

    samples.push({ timestamp: (START_US + tUs) % 2 ** 32, ax, ay, az, sequence: sequence++ });
  }

  if (p.dropoutInRep !== null) {
    // Drop 6 consecutive samples (60ms hole at 100Hz) — enough to exceed
    // DT_GAP_S (60ms) and actually exercise the lossy-flagging path; a
    // 3-sample drop (30ms hole) is well inside "normal" jitter and wouldn't
    // flag anything, which would make this test silently test nothing.
    const DROP_N = 6;
    const repStartS = leadS + (p.dropoutInRep - 1) * (repDurationS + gapS);
    const dropAtS = repStartS + p.tEcc + p.pauseS + p.tCon * 0.4; // mid-concentric
    const dropIdx = samples.findIndex((s) => ((s.timestamp - START_US + 2 ** 32) % 2 ** 32) / 1e6 >= dropAtS);
    samples.splice(dropIdx, DROP_N);
    for (let i = dropIdx; i < samples.length; i++) samples[i].sequence = dropIdx + (i - dropIdx) + DROP_N;
  }

  return samples;
}

// --- assertions -------------------------------------------------------

test('calibrate() recovers gravity magnitude and a unit vector', () => {
  const p = DEFAULT_PARAMS;
  const still: Vec3[] = [];
  const r = rng(42);
  for (let i = 0; i < 100; i++) {
    still.push({
      x: p.scale * p.u.x * G + p.bias.x + gauss(r) * p.noiseSigma,
      y: p.scale * p.u.y * G + p.bias.y + gauss(r) * p.noiseSigma,
      z: p.scale * p.u.z * G + p.bias.z + gauss(r) * p.noiseSigma,
    });
  }
  const calib = calibrate(still);
  assert.ok(calib);
  assert.ok(calib.gMag > 9.5 && calib.gMag < 10.5, `gMag=${calib.gMag}`);
  assert.ok(Math.abs(Math.hypot(calib.ux, calib.uy, calib.uz) - 1) < 1e-9);
});

test('sign convention: flat sensor, constant upward accel reads positive a_vert', () => {
  const samples: RawSample[] = [];
  let t = 0;
  // 1.5s still to calibrate, flat sensor (u = (0,0,1))
  for (let i = 0; i < 150; i++, t += DT_US) samples.push({ timestamp: t, ax: 0, ay: 0, az: G, sequence: i });
  // then constant +1.0 m/s^2 upward for 200ms
  for (let i = 150; i < 170; i++, t += DT_US) samples.push({ timestamp: t, ax: 0, ay: 0, az: G + 1.0, sequence: i });

  // analyzeSession only exposes rep-level output; drive the processor by
  // hand here so the live scalar can be inspected mid-stream.
  const proc = createVbtProcessor();
  for (const s of samples) proc.push(s);
  assert.ok(proc.live.calibrated);
  assert.ok(Math.abs(proc.live.aVert - 1.0) < 0.05, `aVert=${proc.live.aVert}`);
});

test('a clean 3-rep squat session recovers peak/mean velocity within tolerance', () => {
  const samples = buildSession(DEFAULT_PARAMS);
  const { reps, rejected, calibration } = analyzeSession(samples);

  assert.ok(calibration, `no calibration; rejected=${JSON.stringify(rejected)}`);
  assert.equal(reps.length, 3, `expected 3 reps, got ${reps.length}; rejected=${JSON.stringify(rejected)}`);

  const S = DEFAULT_PARAMS.scale;
  for (const rep of reps) {
    // Peak velocity and ROM are the numbers that matter for VBT, and they're
    // tight: the phase extremum and the trapezoid-integrated displacement
    // don't depend on exactly where the boundary sits, only on it landing
    // somewhere inside the true phase.
    assert.ok(
      Math.abs(rep.peakConcentricVelocity - DEFAULT_PARAMS.vCon * S) < 0.02 * DEFAULT_PARAMS.vCon,
      `peak con v=${rep.peakConcentricVelocity}`
    );
    const expectedRom = DEFAULT_PARAMS.vCon * DEFAULT_PARAMS.tCon * 0.5;
    assert.ok(Math.abs(rep.concentric.rangeOfMotion - expectedRom) < 0.03 * expectedRom, `con ROM=${rep.concentric.rangeOfMotion}`);

    // Phase duration (and mean velocity, which is ROM/duration) is looser:
    // during the bottom pause the true displacement signal is exactly flat,
    // so locating the bottom is locating the minimum of doubly-integrated
    // accelerometer noise on an otherwise uninformative stretch — a genuine
    // random walk, smoothed but not eliminated by smooth() in closeRep.
    // Peak velocity and ROM above don't have this problem: they don't care
    // exactly where within the phase the boundary lands.
    assert.ok(
      Math.abs(rep.eccentric.durationMs - DEFAULT_PARAMS.tEcc * 1000) < 0.1 * DEFAULT_PARAMS.tEcc * 1000,
      `ecc dur=${rep.eccentric.durationMs}`
    );
    assert.ok(
      Math.abs(rep.concentric.durationMs - DEFAULT_PARAMS.tCon * 1000) < 0.15 * DEFAULT_PARAMS.tCon * 1000,
      `con dur=${rep.concentric.durationMs}`
    );
    assert.ok(
      Math.abs(rep.meanConcentricVelocity - 0.5 * DEFAULT_PARAMS.vCon * S) < 0.15 * DEFAULT_PARAMS.vCon,
      `mean con v=${rep.meanConcentricVelocity}`
    );
    assert.equal(rep.lossy, false);
  }
});

test('a 3% accelerometer scale error yields ~3% high velocities (the surviving, expected error)', () => {
  const params: SquatParams = { ...DEFAULT_PARAMS, scale: 1.03 };
  const { reps } = analyzeSession(buildSession(params));
  assert.equal(reps.length, 3);
  for (const rep of reps) {
    assert.ok(
      Math.abs(rep.peakConcentricVelocity - params.vCon * params.scale) < 0.03 * params.vCon,
      `peak con v=${rep.peakConcentricVelocity}`
    );
  }
});

test('still + noise only produces zero reps', () => {
  const params: SquatParams = { ...DEFAULT_PARAMS, reps: 0 };
  const samples = buildSession({ ...params, reps: 1, vEcc: 0, vCon: 0 }); // degenerate "rep" with zero amplitude
  const { reps } = analyzeSession(samples);
  assert.equal(reps.length, 0);
});

test('a walkout (bar bob, no real rep) is rejected by the ROM gate', () => {
  const samples: RawSample[] = [];
  let t = 0;
  for (let i = 0; i < 200; i++, t += DT_US) samples.push({ timestamp: t, ax: 0, ay: 0, az: G, sequence: i }); // calibrate
  const bobHz = 2;
  const bobAmpM = 0.05;
  const bobAccelPeak = bobAmpM * (2 * Math.PI * bobHz) ** 2;
  for (let i = 200; i < 500; i++, t += DT_US) {
    const tS = (i - 200) * (DT_US / 1e6);
    const a = bobAccelPeak * Math.sin(2 * Math.PI * bobHz * tS);
    samples.push({ timestamp: t, ax: 0, ay: 0, az: G + a, sequence: i });
  }
  const { reps, rejected } = analyzeSession(samples);
  assert.equal(reps.length, 0);
  if (rejected.length > 0) assert.ok(rejected.every((r) => r.reason === 'rom'));
});

test('a 3-sample dropout mid-concentric still recovers metrics and flags the rep lossy', () => {
  const params: SquatParams = { ...DEFAULT_PARAMS, reps: 1, dropoutInRep: 1 };
  const { reps } = analyzeSession(buildSession(params));
  assert.equal(reps.length, 1);
  const rep = reps[0];
  assert.equal(rep.lossy, true);
  assert.ok(
    Math.abs(rep.peakConcentricVelocity - params.vCon) < 0.05 * params.vCon,
    `peak con v=${rep.peakConcentricVelocity}`
  );
});

test('VBT_TUNING is exported and overridable via Partial<VbtTuning>', () => {
  assert.equal(VBT_TUNING.V_START, -0.15);
  const proc = createVbtProcessor({ V_START: -0.5 });
  assert.ok(proc); // just needs to construct without throwing
});
