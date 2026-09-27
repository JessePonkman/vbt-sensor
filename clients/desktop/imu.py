# Orientation, rest detection, thermal modeling, Allan deviation, lever-arm
# compensation — everything the v2 packet's gyro and temperature unlock.
# See PLAN-V2.md §5 for the reasoning behind every choice here; this file
# implements it without re-arguing it. dsp.py stays the home of 1-D signal
# processing (filters, integration, stats); this module is specifically
# about the 3-axis / SO(3) side: quaternions, fusion, and everything that
# depends on them.
#
# Quaternion convention (PLAN-V2.md §1): Hamilton [w, x, y, z], body -> world,
# world Z up. At rest the accelerometer reads +g along world Z, so q starts
# at the identity [1,0,0,0] whenever the sensor is mounted level.

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

import numpy as np

# ============================================================
# 5.2 — quaternion core
# ============================================================


def quat_normalize(q: Tuple[float, float, float, float]) -> Tuple[float, float, float, float]:
    q0, q1, q2, q3 = q
    n = math.sqrt(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3)
    if n <= 0.0:
        return (1.0, 0.0, 0.0, 0.0)
    return (q0 / n, q1 / n, q2 / n, q3 / n)


def quat_integrate(
    q: Tuple[float, float, float, float], gx: float, gy: float, gz: float, dt: float
) -> Tuple[float, float, float, float]:
    """First-order quaternion integration of a body-frame angular rate
    (rad/s): q_{k+1} = normalize(q_k + q_k * [0, w] * dt/2). Small-angle
    per step at 100 Hz, which is exactly the assumption every AHRS filter
    in this module makes for its own propagation step."""
    q0, q1, q2, q3 = q
    hx, hy, hz = gx * 0.5 * dt, gy * 0.5 * dt, gz * 0.5 * dt
    q0n = q0 - q1 * hx - q2 * hy - q3 * hz
    q1n = q1 + q0 * hx + q2 * hz - q3 * hy
    q2n = q2 + q0 * hy - q1 * hz + q3 * hx
    q3n = q3 + q0 * hz + q1 * hy - q2 * hx
    return quat_normalize((q0n, q1n, q2n, q3n))


def gravity_body(q: Tuple[float, float, float, float]) -> Tuple[float, float, float]:
    """ĝ(t): the world's up vector expressed in the body/sensor frame, i.e.
    the third row of the body->world rotation matrix R(q). This is exactly
    the `v` vector Mahony/Madgwick compute internally as their gravity
    estimate — it's re-exposed here so dsp.project_vertical's formula
    (a . ĝ - |g|) can be reused verbatim with a time-varying ĝ (PLAN-V2.md
    §4.3)."""
    q0, q1, q2, q3 = q
    return (
        2.0 * (q1 * q3 - q0 * q2),
        2.0 * (q0 * q1 + q2 * q3),
        q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3,
    )


def tilt_quat(ax: float, ay: float, az: float) -> Tuple[float, float, float, float]:
    """Quaternion whose gravity_body() reproduces the measured accel
    vector, with yaw fixed at 0. This is the "level" reference used to
    seed every fusion filter from the same rest vector that already
    calibrates dsp.project_vertical (PLAN-V2.md §5.2): whichever way the
    sensor happens to be mounted, this is orientation zero.

    Built as the minimal rotation taking world +Z to the measured
    (normalized) accel direction — i.e. shortest-arc rotation, which by
    construction carries no yaw component."""
    n = math.sqrt(ax * ax + ay * ay + az * az)
    if n <= 1e-9:
        return (1.0, 0.0, 0.0, 0.0)
    ux, uy, uz = ax / n, ay / n, az / n  # measured "up" direction, in body frame
    # Rotation axis/angle taking world-Z (0,0,1) to (ux,uy,uz): axis = z × u.
    axis_x, axis_y, axis_z = -uy, ux, 0.0
    axis_n = math.sqrt(axis_x * axis_x + axis_y * axis_y)
    cos_theta = max(-1.0, min(1.0, uz))
    if axis_n < 1e-9:
        # Already aligned (or exactly inverted) with world Z; no yaw-free
        # axis is defined, so fall back to identity (aligned) or a 180
        # degree flip about X (inverted).
        return (1.0, 0.0, 0.0, 0.0) if cos_theta > 0 else (0.0, 1.0, 0.0, 0.0)
    axis_x, axis_y = axis_x / axis_n, axis_y / axis_n
    half = math.acos(cos_theta) * 0.5
    s = math.sin(half)
    return quat_normalize((math.cos(half), axis_x * s, axis_y * s, axis_z * s))


def quat_conj(q: Tuple[float, float, float, float]) -> Tuple[float, float, float, float]:
    q0, q1, q2, q3 = q
    return (q0, -q1, -q2, -q3)


def quat_mul(
    a: Tuple[float, float, float, float], b: Tuple[float, float, float, float]
) -> Tuple[float, float, float, float]:
    a0, a1, a2, a3 = a
    b0, b1, b2, b3 = b
    return (
        a0 * b0 - a1 * b1 - a2 * b2 - a3 * b3,
        a0 * b1 + a1 * b0 + a2 * b3 - a3 * b2,
        a0 * b2 - a1 * b3 + a2 * b0 + a3 * b1,
        a0 * b3 + a1 * b2 - a2 * b1 + a3 * b0,
    )


def tilt_angle(
    q: Tuple[float, float, float, float], q0: Tuple[float, float, float, float]
) -> float:
    """Angle in degrees between ĝ(t) and ĝ₀ — how far the sensor has
    tilted from its reference orientation, independent of yaw (which
    gravity_body doesn't see anyway)."""
    gx, gy, gz = gravity_body(q)
    gx0, gy0, gz0 = gravity_body(q0)
    dot = max(-1.0, min(1.0, gx * gx0 + gy * gy0 + gz * gz0))
    return math.degrees(math.acos(dot))


def quat_to_euler_deg(q: Tuple[float, float, float, float]) -> Tuple[float, float, float]:
    """Roll/pitch/yaw in degrees, body->world, for the Orientation tab's
    plots. Yaw is included for completeness only — PLAN-V2.md §1 is
    explicit that it's unobservable with 6 axes and drifts freely."""
    q0, q1, q2, q3 = q
    roll = math.atan2(2 * (q0 * q1 + q2 * q3), 1 - 2 * (q1 * q1 + q2 * q2))
    pitch_arg = max(-1.0, min(1.0, 2 * (q0 * q2 - q3 * q1)))
    pitch = math.asin(pitch_arg)
    yaw = math.atan2(2 * (q0 * q3 + q1 * q2), 1 - 2 * (q2 * q2 + q3 * q3))
    return math.degrees(roll), math.degrees(pitch), math.degrees(yaw)


def quat_slerp(
    a: Tuple[float, float, float, float], b: Tuple[float, float, float, float], t: float
) -> Tuple[float, float, float, float]:
    """Spherical linear interpolation, shortest path. Used by the O6
    reference (anchor-to-anchor) to spread a rest-to-rest orientation
    error out linearly in time (PLAN-V2.md §5.5)."""
    a0, a1, a2, a3 = a
    b0, b1, b2, b3 = b
    dot = a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3
    if dot < 0.0:
        b0, b1, b2, b3, dot = -b0, -b1, -b2, -b3, -dot
    dot = min(1.0, dot)
    if dot > 0.9995:  # nearly identical -- avoid the 0/0 in sin(theta)
        out = (a0 + t * (b0 - a0), a1 + t * (b1 - a1), a2 + t * (b2 - a2), a3 + t * (b3 - a3))
        return quat_normalize(out)
    theta0 = math.acos(dot)
    theta = theta0 * t
    s0 = math.sin(theta0 - theta) / math.sin(theta0)
    s1 = math.sin(theta) / math.sin(theta0)
    return quat_normalize(
        (a0 * s0 + b0 * s1, a1 * s0 + b1 * s1, a2 * s0 + b2 * s1, a3 * s0 + b3 * s1)
    )


# ============================================================
# 5.3 — Mahony (and, with Ki=0, the complementary filter) + acceleration
# rejection
# ============================================================

# Defaults from PLAN-V2.md §5.3: Kp is Mahony's original "twoKp", so the
# tilt-correction time constant is tau ~= 1/Kp seconds.
MAHONY_KP_DEFAULT = 1.0
MAHONY_KI_DEFAULT = 0.05
ACC_REJECT_TOL_MAG_DEFAULT = 1.0  # m/s^2, around g_ref
ACC_REJECT_TOL_ANG_DEFAULT = 10.0  # degrees, from x-io Fusion


@dataclass
class MahonyState:
    q: Tuple[float, float, float, float] = (1.0, 0.0, 0.0, 0.0)
    ix: float = 0.0
    iy: float = 0.0
    iz: float = 0.0
    accepted: bool = True  # whether the last step's accel measurement was used


def mahony_step(
    st: MahonyState,
    gx: float,
    gy: float,
    gz: float,
    ax: float,
    ay: float,
    az: float,
    dt: float,
    kp: float,
    ki: float,
    g_ref: float,
    reject: bool = True,
    tol_mag: float = ACC_REJECT_TOL_MAG_DEFAULT,
    tol_ang_deg: float = ACC_REJECT_TOL_ANG_DEFAULT,
) -> None:
    """Explicit scalar loop (PLAN-V2.md §5.3) — deliberately NOT vectorized
    over numpy rows (see §6: indexing numpy rows measured 2.7x slower than
    plain floats + math for this exact loop). Mutates `st` in place; this
    is the per-sample step both OrientationTracker and the C exporter's
    reference implementation share.

    kp=twoKp, ki=twoKi in the original Mahony/Madgwick reference code
    naming. With ki=0 this IS the explicit complementary filter (O3);
    no separate implementation exists on purpose (PLAN-V2.md §5.3)."""
    q0, q1, q2, q3 = st.q
    vx = 2.0 * (q1 * q3 - q0 * q2)
    vy = 2.0 * (q0 * q1 + q2 * q3)
    vz = q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3

    n = math.sqrt(ax * ax + ay * ay + az * az)
    accept = n > 1e-6
    if accept and reject:
        accept = abs(n - g_ref) < tol_mag
    if accept:
        axn, ayn, azn = ax / n, ay / n, az / n
        if reject:
            cos_ang = axn * vx + ayn * vy + azn * vz
            accept = cos_ang > math.cos(math.radians(tol_ang_deg))
    else:
        axn = ayn = azn = 0.0

    if accept:
        ex = ayn * vz - azn * vy
        ey = azn * vx - axn * vz
        ez = axn * vy - ayn * vx
        if ki > 0.0:
            st.ix += ki * ex * dt
            st.iy += ki * ey * dt
            st.iz += ki * ez * dt
        gx = gx + kp * ex
        gy = gy + kp * ey
        gz = gz + kp * ez

    gx += st.ix
    gy += st.iy
    gz += st.iz
    st.q = quat_integrate(st.q, gx, gy, gz, dt)
    st.accepted = accept


# ============================================================
# 5.6 — Madgwick IMU
# ============================================================

MADGWICK_BETA_DEFAULT = 0.033  # ahrs's default for the IMU (no-mag) variant


@dataclass
class MadgwickState:
    q: Tuple[float, float, float, float] = (1.0, 0.0, 0.0, 0.0)
    accepted: bool = True


def madgwick_step(
    st: MadgwickState,
    gx: float,
    gy: float,
    gz: float,
    ax: float,
    ay: float,
    az: float,
    dt: float,
    beta: float,
    g_ref: float,
    reject: bool = True,
    tol_mag: float = ACC_REJECT_TOL_MAG_DEFAULT,
    tol_ang_deg: float = ACC_REJECT_TOL_ANG_DEFAULT,
) -> None:
    """Madgwick's gradient-descent IMU (no magnetometer) update, ported
    from the reference implementation published with the 2010 report.
    The IMU variant has no integral bias term (PLAN-V2.md §5.6) — that's a
    structural difference from Mahony, not an oversight here."""
    q0, q1, q2, q3 = st.q

    n = math.sqrt(ax * ax + ay * ay + az * az)
    accept = n > 1e-6
    if accept and reject:
        accept = abs(n - g_ref) < tol_mag
    if accept:
        axn, ayn, azn = ax / n, ay / n, az / n
        if reject:
            vx = 2.0 * (q1 * q3 - q0 * q2)
            vy = 2.0 * (q0 * q1 + q2 * q3)
            vz = q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3
            cos_ang = axn * vx + ayn * vy + azn * vz
            accept = cos_ang > math.cos(math.radians(tol_ang_deg))

    qdot0 = -0.5 * (q1 * gx + q2 * gy + q3 * gz)
    qdot1 = 0.5 * (q0 * gx + q2 * gz - q3 * gy)
    qdot2 = 0.5 * (q0 * gy - q1 * gz + q3 * gx)
    qdot3 = 0.5 * (q0 * gz + q1 * gy - q2 * gx)

    if accept:
        f1 = 2.0 * (q1 * q3 - q0 * q2) - axn
        f2 = 2.0 * (q0 * q1 + q2 * q3) - ayn
        f3 = 1.0 - 2.0 * (q1 * q1 + q2 * q2) - azn

        j11j24 = 2.0 * q2
        j12j23 = 2.0 * q3
        j13j22 = 2.0 * q0
        j14j21 = 2.0 * q1
        j32 = 2.0 * j14j21
        j33 = 2.0 * j11j24

        grad0 = j14j21 * f2 - j11j24 * f1
        grad1 = j12j23 * f1 + j13j22 * f2 - j32 * f3
        grad2 = -j13j22 * f1 + j12j23 * f2 - j33 * f3
        grad3 = j11j24 * f1 + j14j21 * f2

        gn = math.sqrt(grad0**2 + grad1**2 + grad2**2 + grad3**2)
        if gn > 1e-9:
            qdot0 -= beta * grad0 / gn
            qdot1 -= beta * grad1 / gn
            qdot2 -= beta * grad2 / gn
            qdot3 -= beta * grad3 / gn

    st.q = quat_normalize((q0 + qdot0 * dt, q1 + qdot1 * dt, q2 + qdot2 * dt, q3 + qdot3 * dt))
    st.accepted = accept


# ============================================================
# 4 / 5.4 — vertical acceleration in the world frame
# ============================================================


def gravity_body_array(quats: np.ndarray) -> np.ndarray:
    """Vectorized gravity_body() over an (N, 4) quaternion array -> (N, 3).
    The per-sample fusion loops (mahony_step/madgwick_step) stay scalar
    for the reason in §6, but once a whole array of quaternions already
    exists (OrientationResult.quats), turning it into ĝ(t) rows is cheap
    to do with numpy directly."""
    q0, q1, q2, q3 = quats[:, 0], quats[:, 1], quats[:, 2], quats[:, 3]
    gx = 2.0 * (q1 * q3 - q0 * q2)
    gy = 2.0 * (q0 * q1 + q2 * q3)
    gz = q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3
    return np.stack([gx, gy, gz], axis=1)


def vertical_world(
    ax: np.ndarray, ay: np.ndarray, az: np.ndarray, gb: np.ndarray, g_mag: float
) -> np.ndarray:
    """a_vert = a . ĝ(t) - |g| — the exact same formula as
    dsp.project_vertical, except ĝ is now per-sample instead of a fixed
    snapshot. `gb` is an (N, 3) array of gravity_body(q) rows."""
    return ax * gb[:, 0] + ay * gb[:, 1] + az * gb[:, 2] - g_mag


def horizontal_world_mag(
    ax: np.ndarray, ay: np.ndarray, az: np.ndarray, quats: np.ndarray, g_mag: float
) -> np.ndarray:
    """|a_h| in the world frame: diagnostic only (PLAN-V2.md §5.4) — the
    individual x/y components depend on yaw, which drifts, so only the
    magnitude is reported."""
    n = len(ax)
    out = np.empty(n, dtype=np.float64)
    for i in range(n):
        q = (quats[i, 0], quats[i, 1], quats[i, 2], quats[i, 3])
        wx, wy, wz = rotate_body_to_world(q, ax[i], ay[i], az[i])
        out[i] = math.hypot(wx, wy)
        _ = wz  # vertical component isn't part of this diagnostic
    return out


def rotate_body_to_world(
    q: Tuple[float, float, float, float], x: float, y: float, z: float
) -> Tuple[float, float, float]:
    """R(q) . v — rotates a body-frame vector into the world frame."""
    q0, q1, q2, q3 = q
    r00 = 1 - 2 * (q2 * q2 + q3 * q3)
    r01 = 2 * (q1 * q2 - q0 * q3)
    r02 = 2 * (q1 * q3 + q0 * q2)
    r10 = 2 * (q1 * q2 + q0 * q3)
    r11 = 1 - 2 * (q1 * q1 + q3 * q3)
    r12 = 2 * (q2 * q3 - q0 * q1)
    r20 = 2 * (q1 * q3 - q0 * q2)
    r21 = 2 * (q2 * q3 + q0 * q1)
    r22 = 1 - 2 * (q1 * q1 + q2 * q2)
    return (r00 * x + r01 * y + r02 * z, r10 * x + r11 * y + r12 * z, r20 * x + r21 * y + r22 * z)


# ============================================================
# 6 — incremental orientation tracker
# ============================================================

ESTIMATORS = ("O0", "O1", "O2", "O3", "O4", "O5")


@dataclass
class OrientationResult:
    quats: np.ndarray  # (N, 4)
    accepted: np.ndarray  # (N,) bool -- accel was used at this sample
    bias: np.ndarray  # (N, 3) -- Mahony's learned gyro bias, rad/s (zero for O0-O2, O5)


class OrientationTracker:
    """Incremental, stateful fusion — processes only the NEW tail slice
    the caller hands it each call, rather than re-walking a whole buffer
    from zero every tick (PLAN-V2.md §6): a 6000-sample Mahony pass
    measured ~19-50ms in this venv, which doesn't fit in a 33ms UI tick.

    Deliberately does NOT track "how many samples of array X have I
    seen" by array length/index: LiveBuffer's deque(maxlen=...) evicts
    from the front as new samples arrive, so the same absolute index
    means a different sample every tick once the buffer is full. The
    caller is expected to track what's new by `sequence` (which survives
    eviction) and pass only that new slice to `process_new` — see
    app.py's `_advance_orientation`.

    `estimator` in {"O0".."O5"}: O0 is the fixed snapshot (identity
    rotation always — this class simply isn't consulted for it, but is
    included for completeness so callers can loop generically). O1 is
    gyro-only (kp=ki=0, reject irrelevant). O2 is accel-only tilt per
    sample (recomputed fresh, no gyro propagation). O3 is Mahony with
    ki=0 (complementary). O4 is full Mahony. O5 is Madgwick.
    """

    def __init__(
        self,
        estimator: str = "O4",
        q0: Tuple[float, float, float, float] = (1.0, 0.0, 0.0, 0.0),
        kp: float = MAHONY_KP_DEFAULT,
        ki: float = MAHONY_KI_DEFAULT,
        beta: float = MADGWICK_BETA_DEFAULT,
        g_ref: float = 9.81,
        reject: bool = True,
        tol_mag: float = ACC_REJECT_TOL_MAG_DEFAULT,
        tol_ang_deg: float = ACC_REJECT_TOL_ANG_DEFAULT,
    ):
        self.estimator = estimator
        self.kp = kp
        self.ki = ki
        self.beta = beta
        self.g_ref = g_ref
        self.reject = reject
        self.tol_mag = tol_mag
        self.tol_ang_deg = tol_ang_deg
        self._mahony = MahonyState(q=q0)
        self._madgwick = MadgwickState(q=q0)
        self._q0 = q0

    def reset(self, q0: Optional[Tuple[float, float, float, float]] = None) -> None:
        """Re-anchors the tracker — used on a segment cut (PLAN-V2.md §6)
        or when C4's per-rest re-bias fires."""
        q0 = q0 if q0 is not None else self._q0
        self._mahony = MahonyState(q=q0)
        self._madgwick = MadgwickState(q=q0)

    def set_gyro_bias(self, bx: float, by: float, bz: float) -> None:
        """C4: folds a freshly re-estimated gyro bias into Mahony's
        integral term directly, so the correction is applied starting
        from the very next sample without waiting for ki to re-learn it."""
        self._mahony.ix, self._mahony.iy, self._mahony.iz = bx, by, bz

    def process_new(
        self, gx: np.ndarray, gy: np.ndarray, gz: np.ndarray, ax: np.ndarray, ay: np.ndarray, az: np.ndarray, dt: float
    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Advances the tracker by exactly the samples given — the caller
        is responsible for slicing to only what's new since the last call
        (see class docstring). Returns (quats, accepted, bias), one row
        per input sample."""
        m = len(gx)
        if m == 0:
            return (np.empty((0, 4)), np.empty((0,), dtype=bool), np.empty((0, 3)))

        gxl, gyl, gzl = gx.tolist(), gy.tolist(), gz.tolist()
        axl, ayl, azl = ax.tolist(), ay.tolist(), az.tolist()

        quats = np.empty((m, 4), dtype=np.float64)
        accepted = np.empty(m, dtype=bool)
        bias = np.zeros((m, 3), dtype=np.float64)

        for i in range(m):
            if self.estimator == "O2":
                q = tilt_quat(axl[i], ayl[i], azl[i])
                accepted[i] = True
            elif self.estimator == "O1":
                mahony_step(self._mahony, gxl[i], gyl[i], gzl[i], axl[i], ayl[i], azl[i], dt, 0.0, 0.0, self.g_ref, reject=False)
                q = self._mahony.q
                accepted[i] = False
            elif self.estimator == "O5":
                madgwick_step(
                    self._madgwick, gxl[i], gyl[i], gzl[i], axl[i], ayl[i], azl[i], dt,
                    self.beta, self.g_ref, reject=self.reject, tol_mag=self.tol_mag, tol_ang_deg=self.tol_ang_deg,
                )
                q = self._madgwick.q
                accepted[i] = self._madgwick.accepted
            else:  # O3 (ki=0), O4 -- both go through Mahony
                ki = 0.0 if self.estimator == "O3" else self.ki
                mahony_step(
                    self._mahony, gxl[i], gyl[i], gzl[i], axl[i], ayl[i], azl[i], dt,
                    self.kp, ki, self.g_ref, reject=self.reject, tol_mag=self.tol_mag, tol_ang_deg=self.tol_ang_deg,
                )
                q = self._mahony.q
                accepted[i] = self._mahony.accepted
                bias[i] = (-self._mahony.ix, -self._mahony.iy, -self._mahony.iz)
            quats[i] = q

        return quats, accepted, bias

    def run_full(
        self, gx: np.ndarray, gy: np.ndarray, gz: np.ndarray, ax: np.ndarray, ay: np.ndarray, az: np.ndarray, dt: float
    ) -> OrientationResult:
        """Full non-incremental pass — used for CSV replay, parameter
        changes and tests, where processing the whole buffer once is
        cheap and simplicity beats the incremental bookkeeping."""
        self.reset()
        quats, accepted, bias = self.process_new(gx, gy, gz, ax, ay, az, dt)
        return OrientationResult(quats=quats, accepted=accepted, bias=bias)


# ============================================================
# 5.5 — rest detectors: ARE, SHOE, and everything that hangs off them
# ============================================================


def _box_kernel(window_s: float, fs: float) -> np.ndarray:
    w = max(1, int(round(window_s * fs)))
    return np.ones(w) / w


def are(gyr: np.ndarray, fs: float, sigma_g: float, window_s: float = 0.15) -> np.ndarray:
    """Angular Rate Energy detector (Skog et al. 2010): windowed gyro
    energy normalized by the gyro's own noise variance. `gyr` is (N, 3)
    rad/s. Centered convolution — offline, there's no reason to accept a
    causal window's lag (PLAN-V2.md §5.5, same argument as
    dsp.rolling_rms)."""
    k = _box_kernel(window_s, fs)
    energy = np.convolve((gyr**2).sum(axis=1), k, mode="same")
    return energy / max(sigma_g**2, 1e-12)


def shoe(
    acc: np.ndarray,
    gyr: np.ndarray,
    fs: float,
    sigma_a: float,
    sigma_g: float,
    g_mag: float,
    window_s: float = 0.15,
) -> np.ndarray:
    """SHOE (Stance Hypothesis Optimal Estimator) GLRT statistic (Skog et
    al. 2010): combines the windowed accel-vs-gravity residual with ARE,
    each normalized by its own sensor's noise. See PLAN-V2.md §5.5 for the
    algebraic identity used to avoid re-looping over the window."""
    k = _box_kernel(window_s, fs)
    mean_a = np.stack([np.convolve(acc[:, i], k, mode="same") for i in range(3)], axis=1)
    norm = np.linalg.norm(mean_a, axis=1)
    norm = np.where(norm > 1e-9, norm, 1.0)
    u = mean_a / norm[:, None]
    term_a = (
        np.convolve((acc**2).sum(axis=1), k, mode="same")
        - 2.0 * g_mag * (u * mean_a).sum(axis=1)
        + g_mag * g_mag
    )
    return term_a / max(sigma_a**2, 1e-12) + are(gyr, fs, sigma_g, window_s)


def rest_mask_from_statistic(stat: np.ndarray, gamma: Optional[float] = None, factor: float = 3.0) -> np.ndarray:
    """Turns a rest statistic (ARE or SHOE) into a boolean rest mask using
    a threshold RELATIVE to this capture's own median rather than an
    absolute constant (PLAN-V2.md §5.5): `gamma = factor * median(stat)`
    self-calibrates per board/session instead of assuming another IMU's
    noise floor."""
    if gamma is None:
        gamma = factor * float(np.median(stat)) if len(stat) else 0.0
    return stat <= gamma


def find_rest_intervals(rest_mask: np.ndarray, fs: float, min_duration_s: float = 1.0) -> List[Tuple[int, int]]:
    """Contiguous (start, end-inclusive) index runs where `rest_mask` holds
    for at least `min_duration_s` — the intervals C4 (bias re-estimation),
    O6 (anchors) and I4 (segment detrend) all key off."""
    if len(rest_mask) == 0 or not rest_mask.any():
        return []
    edges = np.flatnonzero(np.diff(np.concatenate(([0], rest_mask.astype(np.int8), [0]))))
    starts, ends = edges[0::2], edges[1::2] - 1
    min_samples = max(1, int(round(min_duration_s * fs)))
    out = []
    for s, e in zip(starts.tolist(), ends.tolist()):
        if e - s + 1 >= min_samples:
            out.append((s, e))
    return out


# ============================================================
# 5.5 (C4) — online gyro bias re-estimation at each detected rest
# ============================================================


@dataclass
class OnlineBias:
    """Re-estimates the gyro bias (and re-anchors tilt) at every rest
    interval of at least 1s with |mean(gyro)| under 3 deg/s -- the same
    "was it actually still" guard Fusion's own bias algorithm uses.
    Exposed as a small stateful helper rather than a bare function because
    the UI wants to show the latest bias estimate continuously."""

    still_gyro_deg_s: float = 3.0
    last_bias: Tuple[float, float, float] = (0.0, 0.0, 0.0)
    last_rest_end: int = -1

    def update(
        self, gyr: np.ndarray, acc: np.ndarray, rest_intervals: Sequence[Tuple[int, int]]
    ) -> List[Tuple[int, Tuple[float, float, float], Tuple[float, float, float, float]]]:
        """Returns a list of (sample_index_at_rest_end, gyro_bias, tilt_quat)
        for every qualifying rest interval — the events an
        OrientationTracker should apply via set_gyro_bias()/reset()."""
        events = []
        for s, e in rest_intervals:
            g_mean = gyr[s : e + 1].mean(axis=0)
            if math.degrees(float(np.linalg.norm(g_mean))) >= self.still_gyro_deg_s:
                continue  # not actually still by the gyro's own account
            a_mean = acc[s : e + 1].mean(axis=0)
            bias = (float(g_mean[0]), float(g_mean[1]), float(g_mean[2]))
            q = tilt_quat(float(a_mean[0]), float(a_mean[1]), float(a_mean[2]))
            self.last_bias = bias
            self.last_rest_end = e
            events.append((e, bias, q))
        return events


# ============================================================
# 5.5 (O6) — anchor-to-anchor reference integration (non-causal)
# ============================================================


def anchor_quaternions(acc: np.ndarray, rest_intervals: Sequence[Tuple[int, int]]) -> List[Tuple[float, float, float, float]]:
    """The tilt_quat() at each rest interval's mean accel — the known-good
    orientation anchors integrate_anchors() below interpolates between."""
    out = []
    for s, e in rest_intervals:
        a_mean = acc[s : e + 1].mean(axis=0)
        out.append(tilt_quat(float(a_mean[0]), float(a_mean[1]), float(a_mean[2])))
    return out


def integrate_between_rest_anchors(
    acc: np.ndarray, gyr: np.ndarray, dt: float, rest_intervals: Sequence[Tuple[int, int]], n: int
) -> np.ndarray:
    """The real, testable O6 entry point: anchors come from the
    ACCELEROMETER at each rest interval (anchor_quaternions), the gyro is
    integrated forward from one anchor to the next, and the accumulated
    error at arrival is slerp-redistributed across the span."""
    out = np.full((n, 4), np.nan, dtype=np.float64)
    if len(rest_intervals) < 2:
        return out
    q_anchors = anchor_quaternions(acc, rest_intervals)

    for k in range(len(rest_intervals) - 1):
        _, ea = rest_intervals[k]
        sb, _ = rest_intervals[k + 1]
        if sb <= ea:
            continue
        q = q_anchors[k]
        qs = [q]
        for i in range(ea, sb):
            gx, gy, gz = gyr[i]
            q = quat_integrate(q, float(gx), float(gy), float(gz), dt)
            qs.append(q)
        q_b_target = q_anchors[k + 1]
        q_b_int = q
        delta = quat_mul(q_b_target, quat_conj(q_b_int))
        span = sb - ea
        for j, i in enumerate(range(ea, sb + 1)):
            t = j / span if span > 0 else 0.0
            correction = quat_slerp((1.0, 0.0, 0.0, 0.0), delta, t)
            out[i] = quat_mul(correction, qs[j])
    return out


# ============================================================
# 5.7 — temperature: thermal bias model
# ============================================================


@dataclass
class ThermalFit:
    slope: float  # bias per degree C
    intercept: float  # bias at T=0 (not T_ref -- that's applied at correction time)
    r2: float
    rms_residual: float


def thermal_fit(temp_c: np.ndarray, bias: np.ndarray, window_s: float = 10.0, fs: float = 100.0) -> Optional[ThermalFit]:
    """C6/A5: fits bias = k*(T - T_ref) + b0 per axis over windowed means of
    a long, undisturbed rest recording (PLAN-V2.md §5.7). Caller passes one
    axis's raw sensor reading as `bias` (still air, so the DC level IS the
    bias) and the matching temp_c; windowing suppresses per-sample noise
    before the linear fit, which is what a straight per-sample polyfit
    would otherwise chase."""
    n = len(temp_c)
    win = max(1, int(round(window_s * fs)))
    if n < win:
        return None
    n_windows = n // win
    if n_windows < 3:
        return None
    t_w = temp_c[: n_windows * win].reshape(n_windows, win).mean(axis=1)
    b_w = bias[: n_windows * win].reshape(n_windows, win).mean(axis=1)
    if np.ptp(t_w) < 1e-6:
        return None  # temperature never moved -- nothing to fit

    slope, intercept = np.polyfit(t_w, b_w, 1)
    pred = slope * t_w + intercept
    residual = b_w - pred
    ss_res = float(np.sum(residual**2))
    ss_tot = float(np.sum((b_w - np.mean(b_w)) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 1e-12 else 0.0
    rms_residual = float(np.sqrt(np.mean(residual**2)))
    return ThermalFit(slope=float(slope), intercept=float(intercept), r2=float(r2), rms_residual=rms_residual)


def apply_thermal_correction(x: np.ndarray, temp_c: np.ndarray, fit: ThermalFit, t_ref: float) -> np.ndarray:
    """x - (poly(T) - poly(T_ref)) — correction is relative to the
    reference temperature the sensor was calibrated at, not absolute bias
    (PLAN-V2.md §5.7 / PX4's convention)."""
    return x - (fit.slope * (temp_c - t_ref))


# ============================================================
# 5.8 — Allan deviation
# ============================================================


def oadev(y: np.ndarray, fs: float, m_list: Optional[Sequence[int]] = None) -> Tuple[np.ndarray, np.ndarray]:
    """Overlapping Allan deviation of a rate signal `y` (PLAN-V2.md §5.8):
    integrate to "phase", then the classic second-difference estimator at
    each averaging factor `m`. `m_list` defaults to an octave sweep. Hand-
    written (~15 lines) rather than pulling in `allantools`, which this
    single formula doesn't justify as a dependency (PLAN-V2.md §1)."""
    n = len(y)
    if m_list is None:
        max_m = max(1, n // 10)
        m_list = []
        m = 1
        while m <= max_m:
            m_list.append(m)
            m *= 2
    theta = np.concatenate(([0.0], np.cumsum(y) / fs))
    taus, out = [], []
    for m in m_list:
        if 2 * m >= len(theta):
            continue
        d = theta[2 * m :] - 2 * theta[m:-m] + theta[: -2 * m]
        tau = m / fs
        taus.append(tau)
        out.append(math.sqrt(float(np.sum(d**2)) / (2.0 * tau * tau * len(d))))
    return np.asarray(taus), np.asarray(out)


def bias_instability(taus: np.ndarray, adev: np.ndarray) -> Tuple[float, float]:
    """(bias_instability, tau_at_min) = (min(ADEV)/0.664, argmin tau) — the
    standard IEEE-STD-952 reading off an Allan deviation curve."""
    if len(adev) == 0:
        return 0.0, 0.0
    idx = int(np.argmin(adev))
    return float(adev[idx] / 0.664), float(taus[idx])


# ============================================================
# 5.9 — lever arm compensation
# ============================================================


def angular_acceleration(gyr: np.ndarray, fs: float) -> np.ndarray:
    """alpha = dω/dt, causal backward difference on gyro already passed
    through a low-pass — the exportable, real-time-viable variant
    (PLAN-V2.md §5.9). The non-causal Savitzky-Golay derivative used for
    offline analysis lives in the UI layer via scipy directly, since it's
    a one-liner over an already-available signal."""
    out = np.zeros_like(gyr)
    out[1:] = (gyr[1:] - gyr[:-1]) * fs
    return out


def lever_arm_correction(
    acc: np.ndarray, gyr: np.ndarray, alpha: np.ndarray, r: Tuple[float, float, float]
) -> np.ndarray:
    """a_axis = a_measured - (alpha x r + omega x (omega x r)) (PLAN-V2.md
    §5.9). `r` is the user-entered sensor->axis vector, meters, body frame."""
    rx, ry, rz = r
    n = len(acc)
    correction = np.empty((n, 3), dtype=np.float64)
    for i in range(n):
        ax_, ay_, az_ = alpha[i]
        wx, wy, wz = gyr[i]
        # alpha x r
        cross_alpha = (ay_ * rz - az_ * ry, az_ * rx - ax_ * rz, ax_ * ry - ay_ * rx)
        # omega x r
        wxr = (wy * rz - wz * ry, wz * rx - wx * rz, wx * ry - wy * rx)
        # omega x (omega x r)
        wxwxr = (wy * wxr[2] - wz * wxr[1], wz * wxr[0] - wx * wxr[2], wx * wxr[1] - wy * wxr[0])
        correction[i, 0] = cross_alpha[0] + wxwxr[0]
        correction[i, 1] = cross_alpha[1] + wxwxr[1]
        correction[i, 2] = cross_alpha[2] + wxwxr[2]
    return acc - correction


def lever_arm_rms(gyr: np.ndarray, r: Tuple[float, float, float]) -> float:
    """RMS of omega x (omega x r) alone, ignoring alpha — the "does this
    even matter" gauge from PLAN-V2.md §5.9: below ~0.05 m/s^2 the UI
    should say the checkbox isn't worth it."""
    rx, ry, rz = r
    wxr = np.stack(
        [
            gyr[:, 1] * rz - gyr[:, 2] * ry,
            gyr[:, 2] * rx - gyr[:, 0] * rz,
            gyr[:, 0] * ry - gyr[:, 1] * rx,
        ],
        axis=1,
    )
    wxwxr = np.stack(
        [
            gyr[:, 1] * wxr[:, 2] - gyr[:, 2] * wxr[:, 1],
            gyr[:, 2] * wxr[:, 0] - gyr[:, 0] * wxr[:, 2],
            gyr[:, 0] * wxr[:, 1] - gyr[:, 1] * wxr[:, 0],
        ],
        axis=1,
    )
    return float(np.sqrt(np.mean(np.sum(wxwxr**2, axis=1))))
