// The squat generator from src/vbt.test.ts (written by the project author, not
// by the detector under test), copied here so it can be swept over random
// parameters. It is deliberately a different physics from src/sim.ts:
//   - velocity per phase is v(t) = V * sin^2(pi t / T)   (closed-form truth:
//     peak = V, mean = V/2, ROM = V*T/2), where sim.ts uses trapezoid-ish
//     ramps built from cosine-eased segments;
//   - lateral sway at 1.1 Hz, a fixed accelerometer bias and scale error;
//   - it has no gyroscope, so only the accelerometer-only path can run on it.
// It exists to answer one question: does the detector work on a squat it was
// not designed around? Keep this copy in sync with vbt.test.ts only if that
// generator changes; do not tune the detector against it.

import type { RawSample } from '../src/vbt.ts';

type Vec3 = { x: number; y: number; z: number };

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
function normalize(v: Vec3): Vec3 {
  const m = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / m, y: v.y / m, z: v.z / m };
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function worldBasis(u: Vec3): { e1: Vec3; e2: Vec3 } {
  const seed: Vec3 = Math.abs(u.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const e1 = normalize(cross(u, seed));
  const e2 = cross(u, e1);
  return { e1, e2 };
}

export type FriendParams = {
  vEcc: number;
  tEcc: number;
  vCon: number;
  tCon: number;
  pauseS: number;
  reps: number;
  scale: number;
  bias: Vec3;
  sway: boolean;
  noiseSigma: number;
  u: Vec3;
  seed: number;
};

const G = 9.81;
const HZ = 100;
const DT_US = 1_000_000 / HZ;
const START_US = 2 ** 32 - 3_000_000; // forces the uint32 timestamp wrap mid-session, as the original does
const LEAD_S = 2.0;
const GAP_S = 1.5;

function sinSquaredVelocity(t: number, tPhase: number, vPeak: number, sign: 1 | -1): { v: number; a: number } {
  if (t < 0 || t > tPhase) return { v: 0, a: 0 };
  const w = Math.PI / tPhase;
  return { v: sign * vPeak * Math.sin(w * t) ** 2, a: sign * vPeak * w * Math.sin(2 * w * t) };
}

export function buildFriendSession(p: FriendParams): { samples: RawSample[]; truth: { ascentStartS: number; endS: number; peak: number; mean: number; rom: number }[] } {
  const { e1, e2 } = worldBasis(p.u);
  void e2;
  const r = rng(p.seed);
  const repDurationS = p.tEcc + p.pauseS + p.tCon;
  const totalS = LEAD_S + p.reps * repDurationS + (p.reps - 1) * GAP_S + GAP_S;
  const samples: RawSample[] = [];
  const n = Math.round((totalS * 1_000_000) / DT_US);
  for (let i = 0; i < n; i++) {
    const tS = (i * DT_US) / 1e6;
    let aVert = 0;
    if (tS >= LEAD_S) {
      const sinceLead = tS - LEAD_S;
      const repIdx = Math.floor(sinceLead / (repDurationS + GAP_S));
      const intoSlot = sinceLead - repIdx * (repDurationS + GAP_S);
      if (repIdx < p.reps && intoSlot < repDurationS) {
        aVert = intoSlot < p.tEcc ? sinSquaredVelocity(intoSlot, p.tEcc, p.vEcc, -1).a : sinSquaredVelocity(intoSlot - p.tEcc - p.pauseS, p.tCon, p.vCon, 1).a;
      }
    }
    const swayX = p.sway ? 0.3 * Math.sin(2 * Math.PI * 1.1 * tS) : 0;
    const wx = p.u.x * (G + aVert) + e1.x * swayX;
    const wy = p.u.y * (G + aVert) + e1.y * swayX;
    const wz = p.u.z * (G + aVert) + e1.z * swayX;
    samples.push({
      timestamp: (START_US + i * DT_US) % 2 ** 32,
      ax: p.scale * wx + p.bias.x + gauss(r) * p.noiseSigma,
      ay: p.scale * wy + p.bias.y + gauss(r) * p.noiseSigma,
      az: p.scale * wz + p.bias.z + gauss(r) * p.noiseSigma,
      sequence: i,
    });
  }
  const truth = Array.from({ length: p.reps }, (_, k) => {
    const start = LEAD_S + k * (repDurationS + GAP_S);
    const ascentStartS = start + p.tEcc + p.pauseS;
    return { ascentStartS, endS: ascentStartS + p.tCon, peak: p.vCon, mean: p.vCon / 2, rom: (p.vCon * p.tCon) / 2 };
  });
  return { samples, truth };
}

/** Random parameters for the friend's generator, seeded. */
export function randomFriendParams(seed: number): FriendParams {
  const r = rng(seed * 104729 + 7);
  const uni = (lo: number, hi: number) => lo + (hi - lo) * r();
  const z = uni(-1, 1);
  const phi = uni(0, 2 * Math.PI);
  const rho = Math.sqrt(1 - z * z);
  let p: FriendParams;
  // keep draws that are a plausible squat: ROM 0.25-0.8 m, bar speed < 2 m/s
  for (let tries = 0; ; tries++) {
    const tCon = uni(0.5, 6);
    const vCon = uni(0.15, 1.6);
    const tEcc = uni(0.8, 5);
    const vEcc = uni(0.2, 1.2);
    p = {
      vEcc, tEcc, vCon, tCon,
      pauseS: r() < 0.4 ? 0 : uni(0, 4),
      reps: 1 + Math.floor(r() * 7),
      scale: uni(0.95, 1.05),
      bias: { x: uni(-0.3, 0.3), y: uni(-0.3, 0.3), z: uni(-0.3, 0.3) },
      sway: r() < 0.7,
      noiseSigma: uni(0.02, 0.12),
      u: { x: rho * Math.cos(phi), y: rho * Math.sin(phi), z },
      seed: seed + 1,
    };
    const romCon = (vCon * tCon) / 2;
    const romEcc = (vEcc * tEcc) / 2;
    if (romCon > 0.25 && romCon < 0.8 && Math.abs(romCon - romEcc) < 0.08 && tries < 500) break;
    if (tries >= 500) break;
  }
  return p;
}
