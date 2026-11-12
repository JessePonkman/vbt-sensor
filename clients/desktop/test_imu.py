# The runnable check for imu.py. Same style as test_dsp.py: plain asserts,
# no framework, `python test_imu.py` (or pytest). See PLAN-V2.md §11.
#
# Tests that need the optional `ahrs` dependency print SKIP and return
# early instead of failing — it's only installed for this cross-check,
# never required to run the app (PLAN-V2.md §1).

from __future__ import annotations

import math

import numpy as np

import dsp
import imu


def _deg2rad(d):
    return d * math.pi / 180.0


def test_quaternion_integration_and_gravity_body():
    fs = 100.0
    dt = 1.0 / fs
    n = int(round(2.0 * fs))
    q = (1.0, 0.0, 0.0, 0.0)
    for _ in range(n):
        q = imu.quat_integrate(q, 0.5, 0.0, 0.0, dt)

    # Constant 0.5 rad/s about body X for 2s -> total angle 1.0 rad.
    q0 = (1.0, 0.0, 0.0, 0.0)
    angle = imu.tilt_angle(q, q0)
    # tilt_angle only sees the swing of gravity_body, which for a pure
    # X-rotation of theta rad reads acos(cos(theta)) == theta (both in the
    # first half turn) -- exact for theta=1.0 rad.
    assert abs(angle - math.degrees(1.0)) < 0.5, f"expected ~57.3 deg, got {angle:.2f}"

    gx, gy, gz = imu.gravity_body(q)
    # Documented convention: after +90 deg about body X, world-Z expressed
    # in the body frame swings from (0,0,1) towards +Y, i.e. (0, sin(theta), cos(theta)).
    assert abs(gx) < 1e-3
    assert abs(gy - math.sin(1.0)) < 1e-2
    assert abs(gz - math.cos(1.0)) < 1e-2


def test_level_rest_stays_at_identity():
    fs = 100.0
    dt = 1.0 / fs
    g = 9.81
    n = 200
    for estimator in ("O1", "O2", "O3", "O4", "O5"):
        tracker = imu.OrientationTracker(estimator=estimator, g_ref=g)
        gx = np.zeros(n)
        gy = np.zeros(n)
        gz = np.zeros(n)
        ax = np.zeros(n)
        ay = np.zeros(n)
        az = np.full(n, g)
        result = tracker.run_full(gx, gy, gz, ax, ay, az, dt)
        q_last = tuple(result.quats[-1])
        gbx, gby, gbz = imu.gravity_body(q_last)
        assert abs(gbx) < 1e-3 and abs(gby) < 1e-3, f"{estimator}: drifted while level"
        assert abs(gbz - 1.0) < 1e-3, f"{estimator}: drifted while level"

        a_vert = imu.vertical_world(ax, ay, az, imu.gravity_body_array(result.quats), g)
        assert abs(a_vert[-1]) < 1e-3, f"{estimator}: vertical_world nonzero at rest"


def test_gravity_leak_and_its_correction():
    # Pure rotation about body X: 0 -> 20 deg -> 0 over 2s, sensor
    # stationary otherwise. a(t) is set EXACTLY to g * gravity_body(q(t)):
    # a real, noise-free accelerometer on a rotating-but-not-translating
    # rig would read exactly this.
    fs = 100.0
    dt = 1.0 / fs
    g = 9.81
    T = 2.0
    n = int(round(T * fs))
    theta_max = _deg2rad(20.0)

    t = np.arange(n) / fs
    theta = theta_max * (1 - np.cos(2 * np.pi * t / T)) / 2.0
    omega = theta_max * np.pi / T * np.sin(2 * np.pi * t / T)

    ax = np.zeros(n)
    ay = g * np.sin(theta)
    az = g * np.cos(theta)
    gx = omega
    gy = np.zeros(n)
    gz = np.zeros(n)

    # O0: the fixed snapshot. project_vertical formula, ported inline:
    # a . ghat0 - g, with ghat0 = (0,0,1) (identity / level calibration).
    a_vert_fixed = az - g
    expected_leak = -g * (1 - np.cos(theta))
    assert np.allclose(a_vert_fixed, expected_leak, atol=1e-6)
    assert np.max(np.abs(a_vert_fixed)) > 0.5, "20 deg tilt should leak a non-trivial amount into the fixed projection"

    # O1 (gyro-only, no accel correction needed -- the synthetic accel IS
    # exactly the true gravity direction, so O1 alone should track it).
    tracker = imu.OrientationTracker(estimator="O1", g_ref=g)
    result = tracker.run_full(gx, gy, gz, ax, ay, az, dt)
    a_vert_dyn = imu.vertical_world(ax, ay, az, imu.gravity_body_array(result.quats), g)
    assert np.max(np.abs(a_vert_dyn)) < 1e-2, "O1 should cancel the leak almost entirely"

    v_dyn = np.concatenate(([0.0], np.cumsum((a_vert_dyn[1:] + a_vert_dyn[:-1]) * 0.5 * dt)))
    assert abs(v_dyn[-1]) < 0.01


def test_mahony_integral_learns_bias():
    fs = 100.0
    dt = 1.0 / fs
    g = 9.81
    n = int(round(60.0 * fs))
    bias_true = 0.02  # rad/s, injected in the gyro's X reading

    q0 = (1.0, 0.0, 0.0, 0.0)

    def run(ki):
        st = imu.MahonyState(q=q0)
        for _ in range(n):
            imu.mahony_step(st, bias_true, 0.0, 0.0, 0.0, 0.0, g, dt, kp=1.0, ki=ki, g_ref=g, reject=True)
        return st

    st_pi = run(0.05)
    learned = -st_pi.ix
    assert abs(learned - bias_true) / bias_true < 0.10, f"bias estimate off: {learned:.4f} vs {bias_true}"
    angle_pi = imu.tilt_angle(st_pi.q, q0)
    assert angle_pi < 0.5, f"PI Mahony tilt error too large: {angle_pi:.3f} deg"

    st_comp = run(0.0)  # Ki = 0 -> no bias learning -> larger steady-state tilt error
    angle_comp = imu.tilt_angle(st_comp.q, q0)
    assert angle_comp > angle_pi, "the Ki=0 complementary filter should NOT correct the bias as well as full Mahony"


def test_acceleration_rejection_limits_tilt_error():
    fs = 100.0
    dt = 1.0 / fs
    g = 9.81
    theta = _deg2rad(10.0)
    q0 = imu.tilt_quat(0.0, g * math.sin(theta), g * math.cos(theta))
    n_disturb = int(round(1.0 * fs))

    def run(reject):
        st = imu.MahonyState(q=q0)
        for _ in range(n_disturb):
            # Gyro reads zero (sensor isn't actually rotating); accel gets
            # 3 m/s^2 of horizontal disturbance riding on the true tilt.
            ax = 3.0
            ay = g * math.sin(theta)
            az = g * math.cos(theta)
            imu.mahony_step(st, 0.0, 0.0, 0.0, ax, ay, az, dt, kp=1.0, ki=0.0, g_ref=g, reject=reject)
        return imu.tilt_angle(st.q, q0)

    err_reject = run(True)
    err_no_reject = run(False)
    assert err_reject < 1.0, f"rejection should keep tilt error small, got {err_reject:.2f} deg"
    assert err_no_reject > err_reject, "without rejection the disturbance should corrupt the tilt more"


def test_ahrs_equivalence():
    try:
        from ahrs.filters import Mahony as AhrsMahony
    except ImportError:
        print("SKIP test_ahrs_equivalence (ahrs not installed)")
        return

    # ahrs's Mahony.updateIMU (verified by reading its source) computes
    # the exact same error term this module does -- omega_mes = a_hat x
    # v, with v = R(q)^T . [0,0,1] (== gravity_body here) -- and folds it
    # into the gyro rate as `gyro - b + k_P*omega_mes`, with `b` integrating
    # `-k_I*omega_mes*dt`. That's algebraically identical to this file's
    # `gx + kp*ex + ki*integral(ex)`, so k_P/k_I map directly onto kp/ki
    # with no factor-of-two adjustment, and no rejection is involved on
    # either side (ahrs's Mahony has no rejection option).
    fs = 100.0
    dt = 1.0 / fs
    g = 9.81
    n = int(round(3.0 * fs))
    rng = np.random.default_rng(0)
    gx = rng.normal(0, 0.3, n)
    gy = rng.normal(0, 0.3, n)
    gz = rng.normal(0, 0.3, n)
    # A level, noise-free accel: enough signal for both filters to apply
    # their correction term every step, with a known expected effect.
    ax = np.zeros(n)
    ay = np.zeros(n)
    az = np.full(n, g)
    kp, ki = 1.0, 0.3

    q = (1.0, 0.0, 0.0, 0.0)
    quats_own = np.empty((n, 4))
    st = imu.MahonyState(q=q)
    for i in range(n):
        imu.mahony_step(st, gx[i], gy[i], gz[i], ax[i], ay[i], az[i], dt, kp=kp, ki=ki, g_ref=g, reject=False)
        quats_own[i] = st.q

    ahrs_mahony = AhrsMahony(
        gyr=np.stack([gx, gy, gz], axis=1),
        acc=np.stack([ax, ay, az], axis=1),
        frequency=fs,
        k_P=kp,
        k_I=ki,
        q0=np.array([1.0, 0.0, 0.0, 0.0]),
    )
    q_own = np.array(quats_own[-1])
    q_ahrs = np.array(ahrs_mahony.Q[-1])
    same = np.allclose(q_own, q_ahrs, atol=0.02) or np.allclose(q_own, -q_ahrs, atol=0.02)
    assert same, f"own Mahony diverged from ahrs.filters.Mahony: {q_own} vs {q_ahrs}"
    print("OK  test_ahrs_equivalence (ahrs installed, compared)")


def test_rest_detectors_mark_still_windows():
    fs = 100.0
    g = 9.81
    n_still = 200
    n_move = 200
    rng = np.random.default_rng(1)

    def still(n):
        acc = np.tile([0.0, 0.0, g], (n, 1)) + rng.normal(0, 0.02, (n, 3))
        gyr = rng.normal(0, 0.01, (n, 3))
        return acc, gyr

    def moving(n):
        acc = np.tile([0.0, 0.0, g], (n, 1)) + rng.normal(0, 0.02, (n, 3)) + np.column_stack(
            [np.sin(np.linspace(0, 6, n)) * 3.0, np.zeros(n), np.zeros(n)]
        )
        gyr = rng.normal(0, 0.01, (n, 3)) + np.column_stack([np.zeros(n), np.sin(np.linspace(0, 6, n)) * 1.5, np.zeros(n)])
        return acc, gyr

    a1, g1 = still(n_still)
    a2, g2 = moving(n_move)
    a3, g3 = still(n_still)
    acc = np.concatenate([a1, a2, a3])
    gyr = np.concatenate([g1, g2, g3])

    sigma_a, sigma_g = 0.02, 0.01
    are_stat = imu.are(gyr, fs, sigma_g)
    shoe_stat = imu.shoe(acc, gyr, fs, sigma_a, sigma_g, g)

    are_mask = imu.rest_mask_from_statistic(are_stat)
    shoe_mask = imu.rest_mask_from_statistic(shoe_stat)

    # Both should flag most of the two still blocks and little of the
    # moving block, up to about one detector window (0.15s ~ 15 samples)
    # of edge slop.
    edge = 20
    for mask, name in ((are_mask, "ARE"), (shoe_mask, "SHOE")):
        assert mask[edge : n_still - edge].mean() > 0.8, f"{name} missed the first rest block"
        assert mask[n_still + n_move + edge : n_still + n_move + n_still - edge].mean() > 0.8, f"{name} missed the second rest block"
        assert mask[n_still + edge : n_still + n_move - edge].mean() < 0.5, f"{name} over-fired during motion"


def test_detrend_segments_zeroes_at_rest_boundaries():
    fs = 100.0
    dt = 1.0 / fs
    n = 600
    t = np.arange(n) / fs
    # A constant accelerometer bias, integrated raw, produces a ramp.
    a_bias = 0.3
    v_raw = a_bias * t

    rest_intervals = [(0, 49), (300, 349), (550, 599)]
    v_corrected = dsp.detrend_segments(t, v_raw, rest_intervals)

    for s, e in rest_intervals:
        assert abs(v_corrected[s]) < 1e-6 or s == 0
    # Continuous across the seam between the two movement segments -- no
    # apply_zupt-style jump.
    assert abs(v_corrected[300] - 0.0) < 1e-6
    assert abs(v_corrected[349]) < 1e-6


def test_anchors_recover_true_tilt_better_than_gyro_only():
    fs = 100.0
    dt = 1.0 / fs
    g = 9.81
    n = int(round(6.0 * fs))
    bias_true = 0.05  # rad/s constant gyro bias, injected only in the MEASURED gyro
    q0 = (1.0, 0.0, 0.0, 0.0)

    # True motion: identity, briefly tilts, back to identity -- but since
    # this is a bias-only test, keep it perfectly still and let the
    # measured (biased) gyro be the only thing that's wrong.
    gyr_true = np.zeros((n, 3))
    gyr_measured = gyr_true.copy()
    gyr_measured[:, 0] += bias_true
    acc = np.tile([0.0, 0.0, g], (n, 1))  # true accel: sensor never actually moves

    rest_intervals = [(0, 49), (n - 50, n - 1)]

    anchored = imu.integrate_between_rest_anchors(acc, gyr_measured, dt, rest_intervals, n)
    mid = n // 2
    angle_anchored = imu.tilt_angle(tuple(anchored[mid]), q0)
    assert angle_anchored < 0.1, f"O6 should recover the true (near-zero) tilt, got {angle_anchored:.3f} deg"

    # Gyro-only (O1) integrates the bias unopposed and drifts badly by the
    # middle of a 6s run.
    tracker = imu.OrientationTracker(estimator="O1", g_ref=g)
    result = tracker.run_full(gyr_measured[:, 0], gyr_measured[:, 1], gyr_measured[:, 2], acc[:, 0], acc[:, 1], acc[:, 2], dt)
    angle_gyro_only = imu.tilt_angle(tuple(result.quats[mid]), q0)
    assert angle_gyro_only > angle_anchored, "O1 should drift more than the anchored reference"


def test_thermal_fit_recovers_synthetic_slope():
    fs = 100.0
    n = int(round(20.0 * 60.0 * fs))  # 20 minutes
    rng = np.random.default_rng(2)
    t = np.arange(n) / fs
    temp_c = 25.0 + 10.0 * (1 - np.exp(-t / 300.0))  # warm-up curve, 25 -> 35 C
    slope_true = 0.01  # units per degree C
    bias0 = 0.05
    bias = bias0 + slope_true * (temp_c - 25.0) + rng.normal(0, 0.005, n)

    fit = imu.thermal_fit(temp_c, bias, window_s=10.0, fs=fs)
    assert fit is not None
    assert abs(fit.slope - slope_true) / slope_true < 0.05, f"slope off: {fit.slope} vs {slope_true}"
    assert fit.r2 > 0.9, f"R^2 too low: {fit.r2}"


def test_allan_deviation_white_noise():
    fs = 100.0
    n = 20000
    rng = np.random.default_rng(3)
    sigma = 0.02
    y = rng.normal(0, sigma, n)

    taus, adev = imu.oadev(y, fs)
    assert len(taus) > 3

    # White (angle random walk) noise: log-log slope should be -1/2.
    log_tau = np.log(taus)
    log_adev = np.log(adev)
    slope, _ = np.polyfit(log_tau, log_adev, 1)
    assert abs(slope - (-0.5)) < 0.15, f"expected slope ~ -0.5, got {slope:.3f}"

    # ADEV at tau ~= 1/fs (m=1) should be close to sigma.
    idx = int(np.argmin(np.abs(taus - 1.0 / fs)))
    assert abs(adev[idx] - sigma) / sigma < 0.25


def test_lever_arm_compensation():
    fs = 100.0
    n = 500
    t = np.arange(n) / fs
    omega_mag = 3.0  # rad/s, constant rotation about Z
    r = (0.03, 0.0, 0.0)  # 30mm offset along body X

    gyr = np.tile([0.0, 0.0, omega_mag], (n, 1))
    alpha = imu.angular_acceleration(gyr, fs)  # ~0 for constant omega, after the first sample

    # Measured accel at a point offset by r under pure rotation:
    # a_measured = omega x (omega x r) (no linear acceleration of the true
    # axis point, alpha ~= 0 away from the discretization edge).
    wxr = np.cross(gyr, np.tile(r, (n, 1)))
    a_measured = np.cross(gyr, wxr)

    a_compensated = imu.lever_arm_correction(a_measured, gyr, alpha, r)
    # Away from the first sample (where the finite-difference alpha has
    # its one-sided edge error), the correction should cancel almost all
    # of the centripetal term.
    assert np.sqrt(np.mean(np.sum(a_compensated[5:] ** 2, axis=1))) < 0.05

    rms = imu.lever_arm_rms(gyr, r)
    # a_measured above IS exactly omega x (omega x r), so its RMS is the
    # ground truth lever_arm_rms is supposed to reproduce.
    expected_rms = float(np.sqrt(np.mean(np.sum(a_measured**2, axis=1))))
    assert abs(rms - expected_rms) < 1e-6


def test_incremental_tracker_matches_full_pass():
    fs = 100.0
    dt = 1.0 / fs
    g = 9.81
    n = 300
    rng = np.random.default_rng(4)
    gx = rng.normal(0, 0.2, n)
    gy = rng.normal(0, 0.2, n)
    gz = rng.normal(0, 0.2, n)
    ax = rng.normal(0, 0.1, n)
    ay = rng.normal(0, 0.1, n)
    az = g + rng.normal(0, 0.1, n)

    full_tracker = imu.OrientationTracker(estimator="O4", g_ref=g)
    full_result = full_tracker.run_full(gx, gy, gz, ax, ay, az, dt)

    chunked_tracker = imu.OrientationTracker(estimator="O4", g_ref=g)
    chunks = []
    for start in range(0, n, 3):
        end = min(start + 3, n)
        q, _acc, _bias = chunked_tracker.process_new(
            gx[start:end], gy[start:end], gz[start:end], ax[start:end], ay[start:end], az[start:end], dt
        )
        chunks.append(q)
    chunked_quats = np.concatenate(chunks, axis=0)

    assert np.allclose(full_result.quats, chunked_quats, atol=1e-9)


def _run_all():
    tests = [obj for name, obj in globals().items() if name.startswith("test_") and callable(obj)]
    for test in tests:
        test()
        print(f"OK  {test.__name__}")
    print(f"\n{len(tests)} tests passed.")


if __name__ == "__main__":
    _run_all()
