// The honest benchmark: a large randomized dataset (src/sim.ts randomDataset),
// where every parameter of every session is drawn at random and none of it was
// looked at while the detector was written.
//
//   npm run bench:random              600 sessions
//   npm run bench:random -- 2000      2000 sessions
//   npm run bench:random -- 600 --md  also append the report to BENCH.md
//
// Reported per pipeline: reps found, phantom reps, sessions with every rep
// found and nothing invented, and the spread (median and 95th percentile of
// the ABSOLUTE error) of peak velocity, mean velocity and range of motion on
// the reps that were found. Then the same split by kind of session, and the
// worst sessions for the best pipeline.

import { appendFileSync, writeFileSync } from 'node:fs';
import { randomDataset, simulateSquatSession } from '../src/sim.ts';
import { PIPELINES, pct, quantile, score, type Score } from './benchlib.ts';

const nArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const N = nArg ? parseInt(nArg, 10) : 600;
const md = process.argv.includes('--md');

const { cases, skipped } = randomDataset(N);
const per = PIPELINES.map(() => new Map<string, Score>());
for (const c of cases) {
  const sim = simulateSquatSession(c.opts);
  PIPELINES.forEach((p, i) => per[i].set(c.id, score(sim, p.run(sim.samples))));
}

const abs = (a: number[]) => a.map(Math.abs);
function summarize(ids: string[], i: number) {
  const ss = ids.map((id) => per[i].get(id)!);
  const n = ss.reduce((a, s) => a + s.n, 0);
  const found = ss.reduce((a, s) => a + s.found, 0);
  const phantom = ss.reduce((a, s) => a + s.phantom, 0);
  const perfect = ss.filter((s) => s.found === s.n && s.phantom === 0).length;
  const peak = abs(ss.flatMap((s) => s.peak));
  const mean = abs(ss.flatMap((s) => s.mean));
  const rom = abs(ss.flatMap((s) => s.rom));
  return { sessions: ss.length, n, found, phantom, perfect, peak, mean, rom };
}

const all = cases.map((c) => c.id);
const lines: string[] = [];
lines.push(`DATASET ALEATORIO — ${cases.length} sesiones, ${cases.reduce((a, c) => a + (c.opts.reps as number), 0)} reps (${skipped} sorteos descartados por no ser una sentadilla físicamente posible)`);
lines.push('');
lines.push('pipeline'.padEnd(22) + 'reps halladas'.padEnd(18) + 'fantasmas'.padEnd(11) + 'sesiones perfectas'.padEnd(20) + 'error pico (mediana / p95)'.padEnd(28) + 'error media (med / p95)'.padEnd(26) + 'error ROM (med / p95)');
lines.push('-'.repeat(150));
const fmtQ = (a: number[]) => `${pct(quantile(a, 0.5))} / ${pct(quantile(a, 0.95))}`.replace(/\+/g, '');
PIPELINES.forEach((p, i) => {
  const s = summarize(all, i);
  lines.push(
    p.label.padEnd(22) +
      `${s.found}/${s.n} (${((100 * s.found) / s.n).toFixed(1)}%)`.padEnd(18) +
      String(s.phantom).padEnd(11) +
      `${s.perfect}/${s.sessions} (${((100 * s.perfect) / s.sessions).toFixed(0)}%)`.padEnd(20) +
      fmtQ(s.peak).padEnd(28) +
      fmtQ(s.mean).padEnd(26) +
      fmtQ(s.rom)
  );
});

// ---- by kind of session ---------------------------------------------------------
const tagSet = [...new Set(cases.flatMap((c) => c.tags))].sort();
lines.push('', 'POR TIPO DE SESIÓN — % de reps halladas (fantasmas entre paréntesis)', '');
lines.push('tipo'.padEnd(20) + 'sesiones'.padEnd(10) + PIPELINES.map((p) => p.label.padEnd(24)).join(''));
lines.push('-'.repeat(20 + 10 + 24 * PIPELINES.length));
for (const tag of tagSet) {
  const ids = cases.filter((c) => c.tags.includes(tag)).map((c) => c.id);
  lines.push(
    tag.padEnd(20) +
      String(ids.length).padEnd(10) +
      PIPELINES.map((_, i) => {
        const s = summarize(ids, i);
        return `${((100 * s.found) / s.n).toFixed(1)}% (${s.phantom})`.padEnd(24);
      }).join('')
  );
}

// ---- worst sessions for the best pipeline ------------------------------------------
const best = PIPELINES.length - 1;
const bad = cases
  .map((c) => ({ c, s: per[best].get(c.id)! }))
  .filter(({ s }) => s.found < s.n || s.phantom > 0)
  .sort((a, b) => b.s.n - b.s.found + b.s.phantom - (a.s.n - a.s.found + a.s.phantom));
lines.push('', `SESIONES CON FALLOS en "${PIPELINES[best].label}": ${bad.length} de ${cases.length}`);
for (const { c, s } of bad.slice(0, 15)) {
  const o = c.opts;
  lines.push(
    `  ${c.id.padEnd(7)} ${s.found}/${s.n} reps, ${s.phantom} fantasmas | ${c.tags.join(',')} | ecc ${o.tEccS}s pausa ${o.pauseS}s con ${o.tConS}s rom ${(o.romM as number).toFixed(2)} ruido ${(o.noiseSigma as number).toFixed(2)}`
  );
}

console.log(lines.join('\n'));
if (md) {
  const block = '\n## Dataset aleatorio\n\n```\n' + lines.join('\n') + '\n```\n';
  try {
    appendFileSync(new URL('../BENCH.md', import.meta.url), block);
  } catch {
    writeFileSync(new URL('../BENCH.md', import.meta.url), '# Comparativa\n' + block);
  }
  console.log('\nañadido a BENCH.md');
}
