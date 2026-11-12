import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeSet } from './reps.ts';
import { randomDataset, SIM_SCENARIOS, simulateSquatSession, type SimOptions, type TruthRep } from './sim.ts';
import type { Rep } from './vbt.ts';

/** A detected rep IS the real rep when their ascents overlap in time. Matching
 *  on the start of the descent would punish a noisy descent detection for a
 *  rep whose ascent — the part that gets measured — is perfectly found. */
function ascentOverlaps(rep: Rep, truth: TruthRep): boolean {
  const end = (rep.startedAtMs + rep.totalDurationMs) / 1000;
  const start = end - rep.concentric.durationMs / 1000;
  return end > truth.ascentStartS && start < truth.endS;
}

function match(opts: Partial<SimOptions>) {
  const sim = simulateSquatSession(opts);
  const out = analyzeSet(sim.samples);
  const used = new Set<number>();
  const pairs: { truth: TruthRep; rep: Rep | null }[] = [];
  for (const truth of sim.truth.reps) {
    const idx = out.reps.findIndex((r, i) => !used.has(i) && ascentOverlaps(r, truth));
    if (idx >= 0) used.add(idx);
    pairs.push({ truth, rep: idx >= 0 ? out.reps[idx] : null });
  }
  return { sim, out, pairs, phantoms: out.reps.length - used.size };
}

for (const sc of SIM_SCENARIOS) {
  test(`scenario "${sc.id}": every rep found, none invented, peak velocity within 5%`, () => {
    const { pairs, phantoms } = match(sc.opts);
    for (const { truth, rep } of pairs) {
      assert.ok(rep, `${sc.id}: rep ${truth.index} was not detected`);
      const err = Math.abs(rep.concentric.peakVelocity - truth.peakConcentricVelocity) / truth.peakConcentricVelocity;
      assert.ok(err < 0.05, `${sc.id} rep ${truth.index}: peak error ${(err * 100).toFixed(1)}%`);
    }
    assert.equal(phantoms, 0, `${sc.id}: phantom reps`);
  });
}

test('mean concentric velocity is within 15% of the truth, pauses excluded', () => {
  for (const id of ['normal', 'pausa_larga', 'tempo_pausa', 'limite']) {
    const { pairs } = match(SIM_SCENARIOS.find((s) => s.id === id)!.opts);
    for (const { truth, rep } of pairs) {
      assert.ok(rep);
      const err = Math.abs(rep.concentric.meanVelocity - truth.meanConcentricVelocity) / truth.meanConcentricVelocity;
      assert.ok(err < 0.15, `${id} rep ${truth.index}: ${(err * 100).toFixed(1)}%`);
    }
  }
});

test('walking with the bar and re-racking it (no reps) produces no reps', () => {
  const sim = simulateSquatSession({ reps: 0, walkout: true, rerack: true });
  assert.equal(analyzeSet(sim.samples).reps.length, 0);
});

test('standing still produces no reps', () => {
  const sim = simulateSquatSession({ reps: 0, walkout: false, rerack: false });
  assert.equal(analyzeSet(sim.samples).reps.length, 0);
});

test('survives noise x4, big sensor bias, +3% scale error and 10% packet loss', () => {
  for (const opts of [{ noiseSigma: 0.12 }, { bias: [0.3, -0.4, 0.5] as [number, number, number] }, { scale: 1.03 }, { dropoutRate: 0.1 }]) {
    for (const id of ['normal', 'tempo_lento', 'limite', 'walkout']) {
      const { pairs, phantoms } = match({ ...SIM_SCENARIOS.find((s) => s.id === id)!.opts, ...opts });
      assert.ok(pairs.every((p) => p.rep), `${id} ${JSON.stringify(opts)}: missed a rep`);
      assert.equal(phantoms, 0);
    }
  }
});

test('lost packets inside a rep flag it lossy; a clean set has none', () => {
  const clean = match(SIM_SCENARIOS.find((s) => s.id === 'normal')!.opts);
  assert.ok(clean.out.reps.every((r) => !r.lossy));
  const lossy = match({ ...SIM_SCENARIOS.find((s) => s.id === 'normal')!.opts, dropoutRate: 0.1 });
  assert.ok(lossy.out.reps.some((r) => r.lossy));
});

test('velocity trace lines up with the samples, and is zero outside reps', () => {
  const { sim, out } = match({ ...SIM_SCENARIOS.find((s) => s.id === 'normal')!.opts, dropoutRate: 0 });
  const tr = out.session;
  assert.equal(tr.v.length, tr.t.length);
  assert.equal(tr.t.length, sim.samples.length);
  assert.equal(tr.v[0], 0);
  assert.ok(tr.v.some((x) => x > 0.3) && tr.v.some((x) => x < -0.3));
});

test('a link stall longer than 0.25 s splits the recording instead of corrupting it', () => {
  const sim = simulateSquatSession({ ...SIM_SCENARIOS.find((s) => s.id === 'normal')!.opts });
  // Cut 0.4 s out of the 1.2 s rest after rep 2: both halves are still analysable.
  const cutFrom = Math.round((sim.truth.reps[1].endS + 0.2) * 100);
  const samples = [...sim.samples.slice(0, cutFrom), ...sim.samples.slice(cutFrom + 40)];
  const out = analyzeSet(samples);
  assert.equal(out.reps.length, 4);
});

test('degenerate input does not throw', () => {
  assert.equal(analyzeSet([]).reps.length, 0);
  assert.equal(analyzeSet([{ timestamp: 0, ax: 0, ay: 0, az: 9.8, sequence: 0 }]).reps.length, 0);
});

// ---- regression guards on data the detector was never tuned against --------
// Loose on purpose: they catch a real regression, they are not a target to
// optimise. The full numbers are in BENCH.md (npm run bench:random / bench:final).

test('guard: a random dataset (seeds 7000+) is found almost completely, with few phantoms', () => {
  const { cases } = randomDataset(60, 7000);
  let n = 0, found = 0, phantoms = 0;
  for (const c of cases) {
    const m = match(c.opts);
    n += m.pairs.length;
    found += m.pairs.filter((p) => p.rep).length;
    phantoms += m.phantoms;
  }
  assert.ok(found / n >= 0.97, `found ${found}/${n}`);
  assert.ok(phantoms <= 3, `${phantoms} phantom reps`);
});

test("guard: the project author's own squat generator (different physics) is found completely", async () => {
  const { buildFriendSession, randomFriendParams } = await import('../scripts/friend-sim.ts');
  let n = 0, found = 0, phantoms = 0;
  for (let k = 0; k < 40; k++) {
    const { samples, truth } = buildFriendSession(randomFriendParams(70000 + k));
    const reps = analyzeSet(samples).reps;
    const used = new Set<number>();
    for (const t of truth) {
      const idx = reps.findIndex((r, i) => {
        if (used.has(i)) return false;
        const end = (r.startedAtMs + r.totalDurationMs) / 1000;
        return end > t.ascentStartS && end - r.concentric.durationMs / 1000 < t.endS;
      });
      if (idx >= 0) { used.add(idx); found++; }
    }
    n += truth.length;
    phantoms += reps.length - used.size;
  }
  assert.ok(found / n >= 0.97, `found ${found}/${n}`);
  assert.ok(phantoms <= 2, `${phantoms} phantom reps`);
});
