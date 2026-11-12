// Shared by bench.ts (hand-picked scenarios + real recordings) and
// bench-random.ts (large randomized dataset): the pipelines being compared and
// how a pipeline's output is scored against the simulator's ground truth.

import { analyzeSet } from '../src/reps.ts';
import type { SimSession } from '../src/sim.ts';
import { analyzeSession, type RawSample, type Rep } from '../src/vbt.ts';

export type Pipeline = { id: string; label: string; run: (samples: RawSample[]) => Rep[] };

export const PIPELINES: Pipeline[] = [
  { id: 'orig', label: 'ORIGINAL (vbt.ts)', run: (s) => analyzeSession(s).reps },
  { id: 'acc', label: 'NUEVO, acelerómetro', run: (s) => analyzeSet(s, undefined, { gyro: false }).reps },
  { id: 'gyro', label: 'NUEVO + giroscopio', run: (s) => analyzeSet(s, undefined, { gyro: true }).reps },
];

export type Score = {
  n: number; // real reps
  found: number;
  phantom: number;
  peak: number[]; // relative error per matched rep
  mean: number[];
  rom: number[];
};

/** A real rep is "found" when a detected rep's ascent overlaps its ascent. */
export function score(sim: SimSession, reps: Rep[]): Score {
  const used = new Set<number>();
  const out: Score = { n: sim.truth.reps.length, found: 0, phantom: 0, peak: [], mean: [], rom: [] };
  for (const t of sim.truth.reps) {
    const idx = reps.findIndex((r, i) => {
      if (used.has(i)) return false;
      const end = (r.startedAtMs + r.totalDurationMs) / 1000;
      return end > t.ascentStartS && end - r.concentric.durationMs / 1000 < t.endS;
    });
    if (idx < 0) continue;
    used.add(idx);
    out.found++;
    const r = reps[idx];
    out.peak.push((r.concentric.peakVelocity - t.peakConcentricVelocity) / t.peakConcentricVelocity);
    out.mean.push((r.concentric.meanVelocity - t.meanConcentricVelocity) / t.meanConcentricVelocity);
    out.rom.push((r.concentric.rangeOfMotion - t.romM) / t.romM);
  }
  out.phantom = reps.length - used.size;
  return out;
}

export const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
export const pct = (x: number) => (Number.isNaN(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`);

export function quantile(a: number[], q: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
