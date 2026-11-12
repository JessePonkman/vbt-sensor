// One-shot evaluation on data the detector was never tuned or even looked at:
//   A) a FRESH randomized dataset (seeds 90000+), different from the training
//      seeds (5000+) used while tuning and the evaluation seeds (1000+) that
//      bench:random reports;
//   B) the project author's own squat generator (friend-sim.ts), a different
//      physics from src/sim.ts, swept over random parameters.
//
//   node scripts/final-eval.ts [A_sessions] [B_sessions]
//
// Do not tune against these numbers. If something here looks bad, that is the
// finding: fix it by understanding why, then rerun with NEW seeds.

import { analyzeSet } from '../src/reps.ts';
import { randomDataset, simulateSquatSession } from '../src/sim.ts';
import { analyzeSession, type Rep } from '../src/vbt.ts';
import { buildFriendSession, randomFriendParams } from './friend-sim.ts';
import { PIPELINES, quantile, score } from './benchlib.ts';

const NA = parseInt(process.argv[2] ?? '1000', 10);
const NB = parseInt(process.argv[3] ?? '400', 10);

// ---- A: fresh randomized dataset -------------------------------------------
const { cases } = randomDataset(NA, 90000);
console.log(`A) DATASET ALEATORIO NUEVO — ${cases.length} sesiones, semillas 90000+ (nunca usadas)`);
for (const p of PIPELINES) {
  let n = 0, found = 0, ph = 0, perfect = 0;
  const peak: number[] = [], mean: number[] = [], rom: number[] = [];
  for (const c of cases) {
    const sim = simulateSquatSession(c.opts);
    const s = score(sim, p.run(sim.samples));
    n += s.n; found += s.found; ph += s.phantom;
    if (s.found === s.n && s.phantom === 0) perfect++;
    peak.push(...s.peak.map(Math.abs)); mean.push(...s.mean.map(Math.abs)); rom.push(...s.rom.map(Math.abs));
  }
  const q = (a: number[]) => `${(100 * quantile(a, 0.5)).toFixed(0)}% / ${(100 * quantile(a, 0.95)).toFixed(0)}%`;
  console.log(`  ${p.label.padEnd(22)} halladas ${found}/${n} (${(100 * found / n).toFixed(1)}%)  fantasmas ${ph}  perfectas ${perfect}/${cases.length} (${(100 * perfect / cases.length).toFixed(0)}%) | |error| pico ${q(peak)}  media ${q(mean)}  ROM ${q(rom)}`);
}

// ---- B: the friend's generator ------------------------------------------------
console.log(`\nB) GENERADOR DE TU AMIGO (vbt.test.ts, perfil de velocidad sen², sin giroscopio) — ${NB} sesiones al azar`);
const pipes: { label: string; run: (s: ReturnType<typeof buildFriendSession>['samples']) => Rep[] }[] = [
  { label: 'ORIGINAL (vbt.ts)', run: (s) => analyzeSession(s).reps },
  { label: 'NUEVO, acelerómetro', run: (s) => analyzeSet(s, undefined, { gyro: false }).reps },
];
for (const p of pipes) {
  let n = 0, found = 0, ph = 0, perfect = 0;
  const peak: number[] = [], mean: number[] = [], rom: number[] = [];
  for (let k = 0; k < NB; k++) {
    const { samples, truth } = buildFriendSession(randomFriendParams(70000 + k));
    const reps = p.run(samples);
    const used = new Set<number>();
    let f = 0;
    for (const t of truth) {
      const idx = reps.findIndex((r, i) => {
        if (used.has(i)) return false;
        const end = (r.startedAtMs + r.totalDurationMs) / 1000;
        return end > t.ascentStartS && end - r.concentric.durationMs / 1000 < t.endS;
      });
      if (idx < 0) continue;
      used.add(idx); f++;
      const r = reps[idx];
      peak.push(Math.abs(r.concentric.peakVelocity - t.peak) / t.peak);
      mean.push(Math.abs(r.concentric.meanVelocity - t.mean) / t.mean);
      rom.push(Math.abs(r.concentric.rangeOfMotion - t.rom) / t.rom);
    }
    n += truth.length; found += f; ph += reps.length - used.size;
    if (f === truth.length && reps.length === used.size) perfect++;
  }
  const q = (a: number[]) => `${(100 * quantile(a, 0.5)).toFixed(0)}% / ${(100 * quantile(a, 0.95)).toFixed(0)}%`;
  console.log(`  ${p.label.padEnd(22)} halladas ${found}/${n} (${(100 * found / n).toFixed(1)}%)  fantasmas ${ph}  perfectas ${perfect}/${NB} (${(100 * perfect / NB).toFixed(0)}%) | |error| pico ${q(peak)}  media ${q(mean)}  ROM ${q(rom)}`);
}
