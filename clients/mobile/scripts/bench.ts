// Scores both rep detectors against the simulator's ground truth, one row per
// scenario in SIM_SCENARIOS:
//   - "actual":  the streaming FSM in src/vbt.ts (what the app used so far)
//   - "nuevo":   the displacement-based batch detector in src/reps.ts
//
//   npm run bench              all scenarios
//   npm run bench -- tempo     only scenarios whose id contains "tempo"
//
// A real rep is "found" when a detected rep's ascent overlaps its ascent.
// "fant." counts phantom reps (detected with no real rep behind them).
// "err media" / "err pico" are the mean error of the concentric mean and peak
// velocity over the matched reps. This is a regression gauge: watch the
// numbers move as the detectors change.

import { analyzeSet } from '../src/reps.ts';
import { SIM_SCENARIOS, simulateSquatSession, type SimSession } from '../src/sim.ts';
import { analyzeSession, type Rep } from '../src/vbt.ts';

type Score = { found: number; phantom: number; meanErr: number; peakErr: number; rejected: string };

function score(sim: SimSession, reps: Rep[], rejected: { reason: string }[]): Score {
  const used = new Set<number>();
  const meanErr: number[] = [];
  const peakErr: number[] = [];
  let found = 0;
  for (const t of sim.truth.reps) {
    const idx = reps.findIndex((r, i) => {
      if (used.has(i)) return false;
      const end = (r.startedAtMs + r.totalDurationMs) / 1000;
      return end > t.ascentStartS && end - r.concentric.durationMs / 1000 < t.endS; // ascents overlap
    });
    if (idx < 0) continue;
    used.add(idx);
    found++;
    const r = reps[idx];
    meanErr.push((r.concentric.meanVelocity - t.meanConcentricVelocity) / t.meanConcentricVelocity);
    peakErr.push((r.concentric.peakVelocity - t.peakConcentricVelocity) / t.peakConcentricVelocity);
  }
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  return {
    found,
    phantom: reps.length - used.size,
    meanErr: avg(meanErr),
    peakErr: avg(peakErr),
    rejected: rejected.map((r) => r.reason).join(','),
  };
}

const pad = (s: string, n: number) => s.padEnd(n);
const pct = (x: number) => (Number.isNaN(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`);

const filter = process.argv[2];
const scenarios = SIM_SCENARIOS.filter((s) => !filter || s.id.includes(filter));

console.log(pad('escenario', 17) + '|' + pad(' ACTUAL (vbt.ts)', 13) + '|' + pad(' NUEVO (reps.ts)', 44) + '| rechazos nuevo');
console.log(pad('', 17) + '|' + pad(' reps  fant.', 13) + '|' + pad(' reps  fant.  err media  err pico', 44) + '|');
console.log('-'.repeat(100));

const tot = { real: 0, old: 0, neu: 0, phOld: 0, phNew: 0 };
for (const sc of scenarios) {
  const sim = simulateSquatSession(sc.opts);
  const old = analyzeSession(sim.samples);
  const neu = analyzeSet(sim.samples);
  const a = score(sim, old.reps, old.rejected);
  const b = score(sim, neu.reps, neu.rejected);
  const n = sim.truth.reps.length;
  tot.real += n;
  tot.old += a.found;
  tot.neu += b.found;
  tot.phOld += a.phantom;
  tot.phNew += b.phantom;
  console.log(
    pad(sc.id, 17) +
      '|' + pad(` ${a.found}/${n}   ${a.phantom}`, 13) +
      '|' + pad(` ${b.found}/${n}   ${b.phantom}     ${pct(b.meanErr)}`.padEnd(30) + pct(b.peakErr), 44) +
      '| ' + b.rejected
  );
}
console.log('-'.repeat(100));
console.log(`total reps encontradas: actual ${tot.old}/${tot.real} (fantasmas ${tot.phOld})  |  nuevo ${tot.neu}/${tot.real} (fantasmas ${tot.phNew})`);
