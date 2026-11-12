import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fuseOrientation, gravityBody, MAHONY_DEFAULTS, quatIntegrate, tiltQuat, type Quat } from './orientation.ts';

type Fixture = {
  fs: number;
  params: { kp: number; ki: number; gRef: number; tolMag: number; tolAngDeg: number };
  acc: number[][];
  gyr: number[][];
  q0: number[];
  quats: number[][];
};

// Reference produced by the Python Mahony in clients/desktop/imu.py on a real
// recording (see scripts/gen_mahony_fixture.py). The port must match it.
// The start orientation comes from the fixture because imu.py's tilt_quat has
// X/Y flipped (see tiltQuat in orientation.ts); everything after it is compared.
test('Mahony port matches clients/desktop/imu.py on a real recording', () => {
  const fx: Fixture = JSON.parse(readFileSync(new URL('./fixtures/mahony_ref.json', import.meta.url), 'utf8'));
  const col = (m: number[][], j: number) => m.map((r) => r[j]);
  const q = fuseOrientation(
    col(fx.acc, 0), col(fx.acc, 1), col(fx.acc, 2),
    col(fx.gyr, 0), col(fx.gyr, 1), col(fx.gyr, 2),
    fx.fs,
    { ...MAHONY_DEFAULTS, ...fx.params, reject: true },
    [0, 0, 0],
    fx.q0 as Quat // imu.py's own starting point: this test checks the filter arithmetic, not tilt_quat
  );
  let worst = 0;
  for (let i = 0; i < q.length; i++) for (let j = 0; j < 4; j++) worst = Math.max(worst, Math.abs(q[i][j] - fx.quats[i][j]));
  assert.ok(worst < 1e-9, `max quaternion difference vs Python: ${worst}`);
});

test('tiltQuat reproduces the measured gravity direction, whatever the mounting', () => {
  for (const a of [[0, 0, 9.81], [3, -4, 8], [-9.5, 1, 2], [0.2, 9.7, -1]]) {
    const g = gravityBody(tiltQuat(a[0], a[1], a[2]));
    const n = Math.hypot(a[0], a[1], a[2]);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(g[k] - a[k] / n) < 1e-9, `${a}`);
  }
});

test('integrating a constant rate about X rotates gravity by the right angle', () => {
  let q: Quat = [1, 0, 0, 0];
  for (let i = 0; i < 100; i++) q = quatIntegrate(q, Math.PI / 2, 0, 0, 0.01); // 90 deg in 1 s
  const g = gravityBody(q);
  assert.ok(Math.abs(g[2]) < 1e-3 && Math.abs(Math.abs(g[1]) - 1) < 1e-3);
});
