// Orientation fusion — a TypeScript port of the Mahony filter in
// clients/desktop/imu.py (quat_integrate, gravity_body, mahony_step), kept
// line-for-line so the two can be checked against each other (see
// orientation.test.ts and scripts/gen_mahony_fixture.py). tilt_quat is the one
// exception, fixed on purpose — see tiltQuat below.
//
// Why the app needs it: the accelerometer alone cannot tell "the bar tilted"
// from "the bar accelerated sideways". The gyroscope can. Fusing the two gives
// the direction of gravity in the sensor frame at every sample, which is what
// the vertical axis is measured along (a . g_hat - |g|). A fixed or
// slowly-averaged g_hat leaks horizontal motion into the vertical channel as
// soon as the bar rolls.
//
// Quaternion convention (imu.py): Hamilton [w, x, y, z], body -> world, world
// Z up. At rest the accelerometer reads +g along world Z, so the quaternion
// starts at tiltQuat(first rest reading) whatever the mounting angle.
//
// Zero imports, like vbt.ts, so node's test runner can load it.

export type Quat = [number, number, number, number];

export function quatNormalize(q: Quat): Quat {
  const n = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  if (n <= 0) return [1, 0, 0, 0];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** First-order integration of a body-frame angular rate (rad/s). */
export function quatIntegrate(q: Quat, gx: number, gy: number, gz: number, dt: number): Quat {
  const [q0, q1, q2, q3] = q;
  const hx = gx * 0.5 * dt;
  const hy = gy * 0.5 * dt;
  const hz = gz * 0.5 * dt;
  return quatNormalize([
    q0 - q1 * hx - q2 * hy - q3 * hz,
    q1 + q0 * hx + q2 * hz - q3 * hy,
    q2 + q0 * hy - q1 * hz + q3 * hx,
    q3 + q0 * hz + q1 * hy - q2 * hx,
  ]);
}

/** Unit gravity ("up") direction in the sensor frame for orientation q. */
export function gravityBody(q: Quat): [number, number, number] {
  const [q0, q1, q2, q3] = q;
  return [2 * (q1 * q3 - q0 * q2), 2 * (q0 * q1 + q2 * q3), q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3];
}

/** Quaternion whose gravityBody() reproduces the measured accelerometer
 *  direction, with yaw fixed at 0 (shortest-arc rotation).
 *
 *  Deliberately NOT a line-for-line copy of imu.py's tilt_quat: that one uses
 *  the rotation axis e_z x u, which is the opposite rotation for this
 *  body->world convention, so gravity_body(tilt_quat(a)) comes out with the X
 *  and Y components negated (a = [3, -4, 8] gives [-0.32, 0.42, 0.85] instead
 *  of [0.32, -0.42, 0.85]). Invisible with the sensor level, but the sensor is
 *  mounted at an arbitrary angle on the bar. The axis here is u x e_z. */
export function tiltQuat(ax: number, ay: number, az: number): Quat {
  const n = Math.sqrt(ax * ax + ay * ay + az * az);
  if (n <= 1e-9) return [1, 0, 0, 0];
  const ux = ax / n;
  const uy = ay / n;
  const uz = az / n;
  let axisX = uy;
  let axisY = -ux;
  const axisN = Math.sqrt(axisX * axisX + axisY * axisY);
  const cosTheta = Math.max(-1, Math.min(1, uz));
  if (axisN < 1e-9) return cosTheta > 0 ? [1, 0, 0, 0] : [0, 1, 0, 0];
  axisX /= axisN;
  axisY /= axisN;
  const half = Math.acos(cosTheta) * 0.5;
  const s = Math.sin(half);
  return quatNormalize([Math.cos(half), axisX * s, axisY * s, 0]);
}

export type MahonyParams = {
  kp: number; // proportional gain (imu.py "twoKp"): tilt correction time constant ~ 1/kp seconds
  ki: number; // integral gain: learns a constant gyro bias
  gRef: number; // |g| the accelerometer is expected to read at rest
  reject: boolean; // ignore the accelerometer while the bar is accelerating
  tolMag: number; // m/s^2 around gRef
  tolAngDeg: number; // degrees between measured and predicted gravity
};

export const MAHONY_DEFAULTS: Omit<MahonyParams, 'gRef'> = {
  kp: 1.0,
  ki: 0.05,
  reject: true,
  tolMag: 1.0,
  tolAngDeg: 10.0,
};

type MahonyState = { q: Quat; ix: number; iy: number; iz: number };

function mahonyStep(
  st: MahonyState,
  gx: number,
  gy: number,
  gz: number,
  ax: number,
  ay: number,
  az: number,
  dt: number,
  p: MahonyParams
): void {
  const [q0, q1, q2, q3] = st.q;
  const vx = 2 * (q1 * q3 - q0 * q2);
  const vy = 2 * (q0 * q1 + q2 * q3);
  const vz = q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3;

  const n = Math.sqrt(ax * ax + ay * ay + az * az);
  let accept = n > 1e-6;
  if (accept && p.reject) accept = Math.abs(n - p.gRef) < p.tolMag;
  let axn = 0;
  let ayn = 0;
  let azn = 0;
  if (accept) {
    axn = ax / n;
    ayn = ay / n;
    azn = az / n;
    if (p.reject) {
      const cosAng = axn * vx + ayn * vy + azn * vz;
      accept = cosAng > Math.cos((p.tolAngDeg * Math.PI) / 180);
    }
  }

  if (accept) {
    const ex = ayn * vz - azn * vy;
    const ey = azn * vx - axn * vz;
    const ez = axn * vy - ayn * vx;
    if (p.ki > 0) {
      st.ix += p.ki * ex * dt;
      st.iy += p.ki * ey * dt;
      st.iz += p.ki * ez * dt;
    }
    gx += p.kp * ex;
    gy += p.kp * ey;
    gz += p.kp * ez;
  }

  gx += st.ix;
  gy += st.iy;
  gz += st.iz;
  st.q = quatIntegrate(st.q, gx, gy, gz, dt);
}

/** Runs Mahony over a whole recording. `gyroBias` (rad/s) is subtracted first;
 *  `q0` is the starting orientation (defaults to the tilt of the first
 *  accelerometer reading). Returns one orientation quaternion per sample. */
export function fuseOrientation(
  ax: readonly number[],
  ay: readonly number[],
  az: readonly number[],
  gx: readonly number[],
  gy: readonly number[],
  gz: readonly number[],
  fs: number,
  params: MahonyParams,
  gyroBias: readonly [number, number, number] = [0, 0, 0],
  q0?: Quat
): Quat[] {
  const n = ax.length;
  const dt = 1 / fs;
  const st: MahonyState = { q: q0 ?? tiltQuat(ax[0], ay[0], az[0]), ix: 0, iy: 0, iz: 0 };
  const out = new Array<Quat>(n);
  for (let i = 0; i < n; i++) {
    mahonyStep(st, gx[i] - gyroBias[0], gy[i] - gyroBias[1], gz[i] - gyroBias[2], ax[i], ay[i], az[i], dt, params);
    out[i] = st.q;
  }
  return out;
}
