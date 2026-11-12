import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyzeSet } from './reps.ts';
import { buildStoredSet, makeSetId, parseCsv, samplesToCsv, summarizeSet, CSV_COLUMNS, type StoredSample } from './session.ts';
import { SIM_SCENARIOS, simulateSquatSession } from './sim.ts';
import type { Rep } from './vbt.ts';

test('CSV round trip keeps every field of a v2 sample', () => {
  const s: StoredSample = { sequence: 7, timestamp: 123456, ax: 0.1, ay: -0.2, az: 9.8, gx: 0.01, gy: -0.02, gz: 0.03, tempC: 26.5, flags: 8, txDropped: 0, jitterUs: -250, rxAt: 1700000000123.5 };
  const { samples, skipped } = parseCsv(samplesToCsv([s]));
  assert.equal(skipped, 0);
  assert.deepEqual(samples[0], s);
});

test('a v1 sample writes empty cells and reads back without gyro (never as zeros)', () => {
  const csv = samplesToCsv([{ sequence: 1, timestamp: 1000, ax: 0, ay: 0, az: 9.8 }]);
  assert.equal(csv.split('\n')[0], CSV_COLUMNS.join(','));
  const back = parseCsv(csv).samples[0];
  assert.equal(back.gx, undefined);
  assert.equal(back.tempC, undefined);
});

test('rx_at_ms is always filled, because the desktop loader requires it', () => {
  const row = samplesToCsv([{ sequence: 1, timestamp: 5000, ax: 0, ay: 0, az: 9.8 }]).split('\n')[1].split(',');
  assert.equal(row.length, CSV_COLUMNS.length);
  assert.notEqual(row[row.length - 1], '');
});

test('malformed rows are skipped and counted, a missing required column throws', () => {
  const ok = 'seq,t_us,ax,ay,az\n1,10,0,0,9.8\n2,oops,0,0,9.8\n3,30,0\n';
  const { samples, skipped } = parseCsv(ok);
  assert.equal(samples.length, 1);
  assert.equal(skipped, 2);
  assert.throws(() => parseCsv('seq,t_us,ax\n1,2,3\n'), /ay/);
});

test('a simulated set survives write -> read -> analyze with the same reps', () => {
  const sim = simulateSquatSession(SIM_SCENARIOS.find((s) => s.id === 'normal')!.opts);
  const direct = analyzeSet(sim.samples);
  const viaCsv = analyzeSet(parseCsv(samplesToCsv(sim.samples)).samples);
  assert.equal(viaCsv.reps.length, direct.reps.length);
  assert.ok(Math.abs(viaCsv.reps[0].concentric.peakVelocity - direct.reps[0].concentric.peakVelocity) < 1e-6);
});

// The recordings the project author made with the real sensor, written by the
// desktop tool: the phone has to be able to open them.
test('real recordings from clients/desktop/sessions import and analyze', () => {
  for (const f of ['2026-09-25_163821.csv', '2026-10-30_193155.csv']) {
    const url = new URL(`../../desktop/sessions/${f}`, import.meta.url);
    if (!existsSync(url)) continue; // only present once the analysis branch is merged
    const { samples, skipped } = parseCsv(readFileSync(url, 'utf8'));
    assert.equal(skipped, 0, f);
    assert.ok(samples.length > 1000 && samples[0].gx !== undefined, f);
    assert.ok(analyzeSet(samples).reps.length >= 3, f);
  }
});

function fakeRep(meanV: number, peakV = meanV * 1.6, rom = 0.5): Rep {
  const phase = (v: number) => ({ peakVelocity: v, minVelocity: 0, meanVelocity: v, durationMs: 800, rangeOfMotion: rom });
  return {
    index: 1, startedAtMs: 0, eccentric: { ...phase(-0.6), durationMs: 1400 }, concentric: { ...phase(meanV), peakVelocity: peakV },
    peakConcentricVelocity: peakV, meanConcentricVelocity: meanV, timeToPeakMs: 300, totalDurationMs: 2200, residualBias: 0, lossy: false,
  };
}

test('velocity loss: (best - last) / best, and the max loss uses the slowest rep', () => {
  const s = summarizeSet([fakeRep(0.50), fakeRep(0.48), fakeRep(0.40), fakeRep(0.42)]);
  assert.equal(s.reps, 4);
  assert.ok(Math.abs(s.bestMeanV - 0.5) < 1e-12);
  assert.ok(Math.abs(s.velocityLoss - 0.16) < 1e-9); // (0.50-0.42)/0.50
  assert.ok(Math.abs(s.maxVelocityLoss - 0.2) < 1e-9); // (0.50-0.40)/0.50
  assert.ok(Math.abs(s.rows[2].dropFromBest - 0.2) < 1e-9);
  assert.equal(s.rows[0].dropFromBest, 0);
});

test('an empty set summarizes to zeros without NaN', () => {
  const s = summarizeSet([]);
  assert.equal(s.reps, 0);
  for (const v of [s.bestMeanV, s.avgMeanV, s.velocityLoss, s.maxVelocityLoss, s.avgRomM]) assert.equal(v, 0);
});

test('set ids are sortable timestamps in the desktop tool style', () => {
  assert.match(makeSetId(Date.now()), /^\d{4}-\d{2}-\d{2}_\d{6}$/);
  assert.ok(makeSetId(Date.UTC(2026, 0, 1)) < makeSetId(Date.UTC(2026, 5, 1)));
});

test('buildStoredSet packages the analysis with the lifter\'s metadata', () => {
  const sim = simulateSquatSession(SIM_SCENARIOS.find((s) => s.id === 'tempo_lento')!.opts);
  const set = buildStoredSet(sim.samples, { source: 'demo', loadKg: 140, note: 'pausa 2s', createdAt: Date.UTC(2026, 10, 12, 15, 30, 45) });
  assert.equal(set.loadKg, 140);
  assert.equal(set.note, 'pausa 2s');
  assert.equal(set.source, 'demo');
  assert.equal(set.orientation, 'gyro');
  assert.equal(set.summary.reps, 4);
  assert.equal(set.reps.length, 4);
  assert.ok(Math.abs(set.durationS - sim.truth.durationS) < 0.05);
  assert.equal(set.sampleCount, sim.samples.length);
  assert.match(set.id, /^2026-11-1[23]_\d{6}$/);
});

test('a set with no load is stored as null, not 0 kg', () => {
  const sim = simulateSquatSession(SIM_SCENARIOS.find((s) => s.id === 'normal')!.opts);
  assert.equal(buildStoredSet(sim.samples, { source: 'sensor' }).loadKg, null);
});
