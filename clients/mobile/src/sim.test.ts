import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SIM_SCENARIOS, simulateSquatSession } from './sim.ts';
import { analyzeSession } from './vbt.ts';

test('sim is deterministic for a given seed', () => {
  const a = simulateSquatSession({ seed: 3 });
  const b = simulateSquatSession({ seed: 3 });
  assert.equal(a.samples.length, b.samples.length);
  assert.deepEqual(a.samples[500], b.samples[500]);
});

test('sim ground truth: bar returns to start, concentric is positive, eccentric negative', () => {
  const { truth } = simulateSquatSession({ reps: 3, romM: 0.5, tConS: 0.8, walkout: false, rerack: false });
  assert.equal(truth.reps.length, 3);
  for (const r of truth.reps) {
    assert.ok(Math.abs(r.romM - 0.5) < 0.01, `rom ${r.romM}`);
    assert.ok(r.peakConcentricVelocity > r.meanConcentricVelocity);
    assert.ok(r.peakEccentricVelocity < 0);
    assert.ok(r.startS < r.bottomS && r.bottomS <= r.ascentStartS && r.ascentStartS < r.endS);
  }
  // mean = displacement / time, and the concentric covers the whole ROM
  const r = truth.reps[0];
  assert.ok(Math.abs(r.meanConcentricVelocity * (r.endS - r.ascentStartS) - r.romM) < 0.01);
});

test('a bottom pause is not counted as concentric time', () => {
  const none = simulateSquatSession({ walkout: false, rerack: false, pauseS: 0.05, reps: 1 }).truth.reps[0];
  const long = simulateSquatSession({ walkout: false, rerack: false, pauseS: 3, reps: 1 }).truth.reps[0];
  // same ascent, 3 s more pause: the mean concentric velocity must not change
  assert.ok(Math.abs(long.meanConcentricVelocity - none.meanConcentricVelocity) < 0.01);
  assert.ok(long.ascentStartS - long.bottomS > 2.9);
});

test('every scenario produces consistent, physically plausible truth', () => {
  for (const sc of SIM_SCENARIOS) {
    const sim = simulateSquatSession(sc.opts);
    assert.ok(sim.truth.reps.length > 0, sc.id);
    for (const r of sim.truth.reps) {
      assert.ok(Math.abs(r.romM - 0.45) < 0.07, `${sc.id} rom ${r.romM}`);
      assert.ok(r.meanConcentricVelocity > 0.02, `${sc.id} mean ${r.meanConcentricVelocity}`);
      assert.ok(r.peakConcentricVelocity < 2.5, `${sc.id} peak ${r.peakConcentricVelocity}`);
    }
    // The accelerometer must stay inside the MPU6050's +-8 g rail, otherwise
    // the scenario is not something the real sensor could report.
    const rail = 8 * 9.81;
    for (const s of sim.samples) assert.ok(Math.hypot(s.ax, s.ay, s.az) < rail, `${sc.id} exceeds sensor range`);
  }
});

test('bounce has no pause and reverses sharply', () => {
  const soft = simulateSquatSession({ ...SIM_SCENARIOS.find((s) => s.id === 'rebote_suave')!.opts });
  const hard = simulateSquatSession({ ...SIM_SCENARIOS.find((s) => s.id === 'rebote_brusco')!.opts });
  const peakA = (s: typeof soft) => Math.max(...s.samples.map((x) => Math.hypot(x.ax, x.ay, x.az)));
  assert.ok(peakA(hard) > peakA(soft));
});

test('sim packets are 100 Hz and dropouts leave sequence gaps', () => {
  const clean = simulateSquatSession({ dropoutRate: 0 });
  assert.equal(clean.samples[1].sequence - clean.samples[0].sequence, 1);
  assert.equal(clean.samples[1].timestamp - clean.samples[0].timestamp, 10_000);

  const lossy = simulateSquatSession({ dropoutRate: 0.1 });
  assert.ok(lossy.samples.length < clean.samples.length);
  const gaps = lossy.samples.filter((s, i) => i > 0 && s.sequence - lossy.samples[i - 1].sequence > 1);
  assert.ok(gaps.length > 0);
});

// The pipeline's current baseline on a clean set (no walkout / re-rack): every
// rep found, and concentric peak velocity within 15% of the analytic truth.
test('vbt pipeline recovers a clean simulated set', () => {
  const sim = simulateSquatSession({ walkout: false, rerack: false });
  const { reps } = analyzeSession(sim.samples);
  assert.equal(reps.length, sim.truth.reps.length);
  for (let i = 0; i < reps.length; i++) {
    const truth = sim.truth.reps[i].peakConcentricVelocity;
    assert.ok(
      Math.abs(reps[i].concentric.peakVelocity - truth) / truth < 0.15,
      `rep ${i + 1}: ${reps[i].concentric.peakVelocity} vs ${truth}`
    );
  }
});
