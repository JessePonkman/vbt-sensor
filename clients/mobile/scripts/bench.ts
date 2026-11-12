// Before / after comparison of the rep pipelines, scored against the
// simulator's ground truth, one row per scenario in SIM_SCENARIOS:
//
//   ORIGINAL   the streaming FSM in src/vbt.ts (what the app used so far)
//   ACELERÓM.  the displacement-based batch detector in src/reps.ts, with the
//              tilt estimated from the accelerometer alone (gyro: false)
//   +GIROSCOPIO the same detector with the Mahony-fused orientation from the
//              gyroscope (src/orientation.ts, ported from clients/desktop/imu.py)
//
//   npm run bench                  all scenarios, printed
//   npm run bench -- tempo         only scenarios whose id contains "tempo"
//   npm run bench -- --md          also write BENCH.md next to package.json
//
// A real rep is "found" when a detected rep's ascent overlaps its ascent.
// "fant" counts phantom reps (detected, but no real rep behind them). The
// errors are the average over matched reps, relative to the truth: peak
// concentric velocity, mean concentric velocity (bottom pause excluded,
// start of the rise to lockout) and range of motion.
//
// The second table runs the same pipelines on the real recordings in
// clients/desktop/sessions. There is no ground truth for those, so it only
// shows what each pipeline reports.

import { readFileSync, writeFileSync } from 'node:fs';
import { SIM_SCENARIOS, simulateSquatSession } from '../src/sim.ts';
import type { RawSample, Rep } from '../src/vbt.ts';
import { avg, PIPELINES, pct, score, type Score } from './benchlib.ts';

const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
const writeMd = process.argv.includes('--md');
const scenarios = SIM_SCENARIOS.filter((s) => !filter || s.id.includes(filter));

// ---- table 1: simulation, with truth -------------------------------------

const rows: { id: string; label: string; scores: Score[] }[] = [];
const totals = PIPELINES.map(() => ({ found: 0, n: 0, phantom: 0 }));
for (const sc of scenarios) {
  const sim = simulateSquatSession(sc.opts);
  const scores = PIPELINES.map((p) => score(sim, p.run(sim.samples)));
  scores.forEach((s, i) => {
    totals[i].found += s.found;
    totals[i].n += s.n;
    totals[i].phantom += s.phantom;
  });
  rows.push({ id: sc.id, label: sc.label, scores });
}

const cell = (s: Score) => `${s.found}/${s.n}  ${String(s.phantom).padEnd(2)} ${pct(avg(s.peak)).padStart(5)} ${pct(avg(s.mean)).padStart(5)} ${pct(avg(s.rom)).padStart(5)}`;
const W = 31;
const line = (a: string, ...b: string[]) => a.padEnd(19) + b.map((x) => '| ' + x.padEnd(W)).join('');

const out: string[] = [];
out.push('SIMULACIÓN — reps encontradas / reales, fantasmas, error de pico, de media y de recorrido (ROM)');
out.push(line('', ...PIPELINES.map((p) => p.label)));
out.push(line('escenario', ...PIPELINES.map(() => 'reps  fant  pico  media  rom')));
out.push('-'.repeat(19 + PIPELINES.length * (W + 2)));
for (const r of rows) out.push(line(r.id, ...r.scores.map(cell)));
out.push('-'.repeat(19 + PIPELINES.length * (W + 2)));
out.push(line('TOTAL', ...totals.map((t) => `${t.found}/${t.n}  ${t.phantom} fantasmas`)));

// ---- table 2: real recordings, no truth --------------------------------------

const SESSIONS = new URL('../../desktop/sessions/', import.meta.url);
const real: string[] = [];
for (const f of ['2026-09-25_163821.csv', '2026-10-30_193155.csv']) {
  let text: string;
  try {
    text = readFileSync(new URL(f, SESSIONS), 'utf8');
  } catch {
    continue; // the recordings live on the analysis branch; skip if absent
  }
  const rowsCsv = text.trim().split('\n');
  const head = rowsCsv[0].split(',');
  const ix = (k: string) => head.indexOf(k);
  const samples: RawSample[] = rowsCsv.slice(1).map((r) => {
    const c = r.split(',');
    return { sequence: +c[ix('seq')], timestamp: +c[ix('t_us')], ax: +c[ix('ax')], ay: +c[ix('ay')], az: +c[ix('az')], gx: +c[ix('gx')], gy: +c[ix('gy')], gz: +c[ix('gz')] };
  });
  real.push(`${f}  (${samples.length} muestras)`);
  for (const p of PIPELINES) {
    const reps = p.run(samples);
    const f2 = (g: (r: Rep) => number) => reps.map((r) => g(r).toFixed(2)).join(' ') || '—';
    real.push(`  ${p.label.padEnd(20)} reps ${reps.length}  ROM ${f2((r) => r.concentric.rangeOfMotion).padEnd(20)} pico ${f2((r) => r.concentric.peakVelocity).padEnd(20)} media ${f2((r) => r.concentric.meanVelocity)}`);
  }
}
if (real.length) {
  out.push('');
  out.push('GRABACIONES REALES (clients/desktop/sessions) — sin verdad conocida, solo lo que reporta cada pipeline');
  out.push(...real);
}

console.log(out.join('\n'));

if (writeMd) {
  const md: string[] = [];
  md.push('# Comparativa de pipelines — antes y después');
  md.push('');
  md.push('Generado con `npm run bench -- --md`. Simulador con verdad conocida (`src/sim.ts`), sentadilla.');
  md.push('');
  md.push('- **ORIGINAL**: la máquina de estados en streaming de `src/vbt.ts`.');
  md.push('- **NUEVO, acelerómetro**: detector por desplazamiento (`src/reps.ts`), inclinación estimada solo con el acelerómetro.');
  md.push('- **NUEVO + giroscopio**: igual, pero con la orientación fusionada Mahony (`src/orientation.ts`, portada de `clients/desktop/imu.py`).');
  md.push('');
  md.push('Reps = encontradas / reales. Fant. = reps detectadas que no existen. Pico / media / ROM = error medio relativo a la verdad sobre las reps emparejadas.');
  md.push('');
  const head = ['Escenario', ...PIPELINES.flatMap((p) => [`${p.id} reps`, 'fant.', 'pico', 'media', 'ROM'])];
  md.push('| ' + head.join(' | ') + ' |');
  md.push('|' + head.map(() => '---').join('|') + '|');
  for (const r of rows) {
    md.push('| ' + [r.id, ...r.scores.flatMap((s) => [`${s.found}/${s.n}`, String(s.phantom), pct(avg(s.peak)), pct(avg(s.mean)), pct(avg(s.rom))])].join(' | ') + ' |');
  }
  md.push('| **TOTAL** | ' + totals.flatMap((t) => [`**${t.found}/${t.n}**`, String(t.phantom), '', '', '']).join(' | ') + ' |');
  if (real.length) {
    md.push('', '## Grabaciones reales (sin verdad conocida)', '', '```', ...real, '```');
  }
  writeFileSync(new URL('../BENCH.md', import.meta.url), md.join('\n') + '\n');
  console.log('\nescrito BENCH.md');
}
