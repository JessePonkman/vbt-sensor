// Sweeps the detector's phase-boundary thresholds on a TRAINING dataset
// (seeds 5000+), which is separate from the evaluation dataset bench:random
// uses (seeds 1000+). Tune here, report there.
//
//   node scripts/tune.ts [sessions]
import { analyzeSet, SQUAT_PROFILE } from '../src/reps.ts';
import { randomDataset, simulateSquatSession } from '../src/sim.ts';
import { quantile, score } from './benchlib.ts';

const N = parseInt(process.argv[2] ?? '300', 10);
const { cases } = randomDataset(N, 5000);
const sims = cases.map((c) => simulateSquatSession(c.opts));

const grid: { moveFrac: number; moveFloor: number; moveCeil: number }[] = [];
for (const moveFrac of [0.01, 0.015, 0.02, 0.03]) for (const moveFloor of [0.006, 0.01, 0.012]) for (const moveCeil of [0.02, 0.04]) grid.push({ moveFrac, moveFloor, moveCeil });

console.log('moveFrac floor ceil | reps%   fant | media: mediana(abs) p95 | pico: med p95 | rom: med p95');
for (const g of grid) {
  const prof = { ...SQUAT_PROFILE, ...g };
  let n = 0, found = 0, ph = 0;
  const mean: number[] = [], peak: number[] = [], rom: number[] = [];
  sims.forEach((sim) => {
    const sc = score(sim, analyzeSet(sim.samples, prof).reps);
    n += sc.n; found += sc.found; ph += sc.phantom;
    mean.push(...sc.mean.map(Math.abs)); peak.push(...sc.peak.map(Math.abs)); rom.push(...sc.rom.map(Math.abs));
  });
  const f = (a: number[], q: number) => (100 * quantile(a, q)).toFixed(1).padStart(5);
  console.log(`${String(g.moveFrac).padEnd(8)} ${String(g.moveFloor).padEnd(5)} ${String(g.moveCeil).padEnd(4)} | ${(100 * found / n).toFixed(1)}%  ${String(ph).padStart(3)} | ${f(mean, 0.5)} ${f(mean, 0.95)} | ${f(peak, 0.5)} ${f(peak, 0.95)} | ${f(rom, 0.5)} ${f(rom, 0.95)}`);
}
