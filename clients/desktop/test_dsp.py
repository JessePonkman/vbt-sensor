# The runnable check for dsp.py and protocol.py. Plain asserts, no
# framework — run with `python test_dsp.py` or under pytest, either works
# since everything here is a top-level `test_*` function. See PLAN.md §7.

from __future__ import annotations

import numpy as np
from scipy import signal

import dsp
from protocol import (
    FLAG_ACCEL_CLIPPED,
    FLAG_IMU_READ_FAILED,
    FLAG_SCHED_LATE,
    PACKET_V1,
    PACKET_V2,
    Sample,
    delta_us,
    describe_flags,
    parse_packet,
)


def test_v1_packet_roundtrip():
    raw = PACKET_V1.pack(0x56, 0x01, 123456, 1.5, -2.25, 9.81, 42)
    sample = parse_packet(raw, rx_at=0.0)
    assert sample is not None
    assert sample.timestamp == 123456
    assert sample.sequence == 42
    assert abs(sample.ax - 1.5) < 1e-6
    assert abs(sample.ay - (-2.25)) < 1e-6
    assert abs(sample.az - 9.81) < 1e-6

    # v1 carries no gyro. It must come back as NaN, never 0.0 — a gyro at
    # rest reads almost exactly zero, so the two would be indistinguishable.
    assert np.isnan(sample.gx) and np.isnan(sample.gy) and np.isnan(sample.gz)
    assert np.isnan(sample.temp_c)
    assert np.isnan(sample.jitter_us), "v1 reports no timing, which is not the same as perfect timing"
    assert sample.flags == 0 and sample.tx_dropped == 0

    assert parse_packet(raw[:-1]) is None, "wrong length must be rejected"


def test_v2_packet_roundtrip():
    assert PACKET_V2.size == 42

    # jitter is deliberately NEGATIVE here: a read that finished early. This
    # is the only place a '<h' mistyped as '<H' shows up.
    raw = PACKET_V2.pack(
        0x56,
        0x02,
        FLAG_ACCEL_CLIPPED | FLAG_SCHED_LATE,
        7,
        123456,
        42,
        -1234,
        1.5,
        -2.25,
        9.81,
        0.125,
        -0.25,
        0.5,
        31.25,
    )
    sample = parse_packet(raw, rx_at=0.0)
    assert sample is not None
    assert sample.timestamp == 123456
    assert sample.sequence == 42
    assert sample.flags == FLAG_ACCEL_CLIPPED | FLAG_SCHED_LATE
    assert sample.tx_dropped == 7
    assert sample.jitter_us == -1234, "jitterUs must be signed"
    assert abs(sample.ax - 1.5) < 1e-6
    assert abs(sample.ay - (-2.25)) < 1e-6
    assert abs(sample.az - 9.81) < 1e-6
    assert abs(sample.gx - 0.125) < 1e-6
    assert abs(sample.gy - (-0.25)) < 1e-6
    assert abs(sample.gz - 0.5) < 1e-6
    assert abs(sample.temp_c - 31.25) < 1e-6
    assert len(sample.raw) == 42

    assert parse_packet(raw[:-1]) is None, "wrong length must be rejected"
    # A v1-length payload claiming to be v2 must not be parsed as a short v2.
    assert parse_packet(PACKET_V1.pack(0x56, 0x02, 0, 0.0, 0.0, 0.0, 0)) is None


def test_packet_version_dispatch():
    bad_magic = PACKET_V1.pack(0x00, 0x01, 0, 0.0, 0.0, 0.0, 0)
    assert parse_packet(bad_magic) is None, "wrong magic must be rejected"

    unknown = bytearray(PACKET_V2.pack(0x56, 0x02, 0, 0, 0, 0, 0, *([0.0] * 7)))
    unknown[1] = 0x03
    assert parse_packet(bytes(unknown)) is None, "unknown version must be rejected"

    assert parse_packet(b"\x56") is None, "a runt too short to dispatch must be rejected"


def test_describe_flags():
    assert describe_flags(0) == ""
    assert describe_flags(FLAG_ACCEL_CLIPPED) == "CLIP"
    assert describe_flags(FLAG_ACCEL_CLIPPED | FLAG_IMU_READ_FAILED) == "CLIP|I2C"


def test_timestamp_wraparound():
    assert delta_us(2**32 - 5, 5) == 10
    assert delta_us(100, 110) == 10
    assert delta_us(50, 50) == 0


def _make_samples(sequences, timestamps_us, ax=None, ay=None, az=None, gx=None, jitter=None, flags=None):
    """Synthetic samples. Leaving `gx` out builds v1-shaped samples, whose
    gyro/temperature stay at their NaN defaults — that's the "old CSV" path."""
    n = len(sequences)
    ax = ax if ax is not None else [0.0] * n
    ay = ay if ay is not None else [0.0] * n
    az = az if az is not None else [9.81] * n

    samples = []
    for i in range(n):
        extra = {}
        if gx is not None:
            extra.update(gx=gx[i], gy=-gx[i], gz=0.5, temp_c=30.0)
        if jitter is not None:
            extra["jitter_us"] = jitter[i]
        if flags is not None:
            extra["flags"] = flags[i]
        samples.append(
            Sample(
                timestamp=timestamps_us[i],
                ax=ax[i],
                ay=ay[i],
                az=az[i],
                sequence=sequences[i],
                rx_at=float(i),
                raw=b"",
                **extra,
            )
        )
    return samples


def test_grid_reconstruction_fills_gaps():
    # 10 nominal samples at 100 Hz (10_000 us apart), with sequence 3, 4, 5
    # dropped — so the received run is seq [0,1,2, 6,7,8,9].
    fs_nominal = 100.0
    dt_us = int(1_000_000 / fs_nominal)
    kept_seq = [0, 1, 2, 6, 7, 8, 9]
    ts = [s * dt_us for s in kept_seq]
    ax = [float(s) for s in kept_seq]  # ax[k] == k by construction, so interpolation is checkable exactly
    samples = _make_samples(kept_seq, ts, ax=ax)

    grid = dsp.to_grid(samples)
    assert grid is not None
    assert len(grid.t) == 10, "grid must span sequence 0..9 inclusive"
    assert abs(grid.fs - fs_nominal) < 0.5

    expected_filled = np.array([i in (3, 4, 5) for i in range(10)])
    assert np.array_equal(grid.filled, expected_filled)

    # ax is linear in the sequence index by construction, so linear
    # interpolation over the gap must reproduce it exactly.
    assert np.allclose(grid.ax, np.arange(10), atol=1e-9)


def test_grid_reconstruction_cuts_at_reboot():
    fs_nominal = 100.0
    dt_us = int(1_000_000 / fs_nominal)
    # A clean run of 5, then a reboot (micros() resets near 0), then 5 more.
    seq = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    ts = [i * dt_us for i in range(5)] + [dt_us * i for i in range(5)]  # timestamps restart at sample 5
    samples = _make_samples(seq, ts)

    grid = dsp.to_grid(samples)
    assert grid is not None
    # Only the post-reboot run (5 samples) should survive.
    assert len(grid.t) == 5


def test_grid_interpolates_gyro_on_the_same_indices():
    dt_us = 10_000
    kept_seq = [0, 1, 2, 6, 7, 8, 9]
    ts = [s * dt_us for s in kept_seq]
    # Both accel and gyro are linear in the sequence index, so interpolation
    # over the gap has an exact expected answer.
    ax = [float(s) for s in kept_seq]
    gx = [2.0 * s for s in kept_seq]
    grid = dsp.to_grid(_make_samples(kept_seq, ts, ax=ax, gx=gx))

    assert grid is not None
    assert dsp.gyro_available(grid)
    assert np.allclose(grid.ax, np.arange(10), atol=1e-9)
    assert np.allclose(grid.gx, 2.0 * np.arange(10), atol=1e-9)
    assert np.allclose(grid.gy, -2.0 * np.arange(10), atol=1e-9)
    assert np.allclose(grid.temp_c, 30.0, atol=1e-9)


def test_grid_leaves_absent_gyro_as_nan():
    # The v1 path: a capture (or an old CSV) with no gyro at all. The
    # columns must stay NaN rather than be interpolated into zeros, which
    # would read as "the sensor was perfectly still".
    dt_us = 10_000
    kept_seq = [0, 1, 2, 6, 7, 8, 9]
    grid = dsp.to_grid(_make_samples(kept_seq, [s * dt_us for s in kept_seq]))

    assert grid is not None
    assert not dsp.gyro_available(grid)
    assert np.all(np.isnan(grid.gx)), "absent gyro must not be invented"
    assert np.all(np.isnan(grid.temp_c))
    # Accel on the same grid is unaffected.
    assert np.all(np.isfinite(grid.ax))

    # And the timing summary degrades to zeros instead of raising.
    assert dsp.timing_stats(grid).n == 0


def test_grid_timestamp_and_sequence_agree():
    # With v2 the firmware sends the SCHEDULED time, so timestamp and
    # sequence are two views of the same grid index and must never
    # disagree. t0 is deliberately non-zero: the grid is relative.
    dt_us = 10_000
    kept_seq = [4, 5, 6, 10, 11, 12, 13]
    ts = [777_000 + s * dt_us for s in kept_seq]
    grid = dsp.to_grid(_make_samples(kept_seq, ts))

    assert grid is not None
    for i, seq in enumerate(kept_seq):
        k = seq - kept_seq[0]
        assert abs(grid.t[k] - (ts[i] - ts[0]) / 1e6) < 1e-9, f"grid index {k} disagrees with its timestamp"
        assert not grid.filled[k]


def test_timing_stats_ignores_interpolated_samples():
    dt_us = 10_000
    kept_seq = [0, 1, 2, 6, 7, 8, 9]
    ts = [s * dt_us for s in kept_seq]
    # A constant 400 us offset plus a +-100 us wobble: a pure delay with
    # real variation around it. spread is what matters, not the median.
    jitter = [400, 500, 300, 400, 500, 300, 400]
    flags = [0, 0, 0, FLAG_SCHED_LATE, 0, 0, 0]
    grid = dsp.to_grid(_make_samples(kept_seq, ts, gx=[0.0] * 7, jitter=jitter, flags=flags))

    stats = dsp.timing_stats(grid)
    assert stats.n == 7, "the 3 interpolated slots must not count as timing evidence"
    assert abs(stats.median_abs_us - 400.0) < 1e-9
    assert stats.max_abs_us == 500.0
    assert abs(stats.late_fraction - 1.0 / 7.0) < 1e-9
    assert stats.resync_count == 0


def test_integration_matches_analytic_sine():
    # a(t) = sin(2*pi*f*t)  =>  v(t) = (1 - cos(2*pi*f*t)) / (2*pi*f)
    fs = 100.0
    f = 1.0
    t = np.arange(0, 2.0, 1.0 / fs)
    a = np.sin(2 * np.pi * f * t)
    v = dsp.integrate_velocity(a, t)
    v_analytic = (1 - np.cos(2 * np.pi * f * t)) / (2 * np.pi * f)
    assert np.allclose(v, v_analytic, atol=1e-3)


def test_onepole_matches_vbt_ts_formula():
    fs = 100.0
    fc = 10.0
    dt = 1.0 / fs
    rc = 1.0 / (2 * np.pi * fc)
    alpha = dt / (dt + rc)

    rng = np.random.default_rng(0)
    x = rng.normal(size=500)

    y_loop = dsp.apply_onepole(x, fs, fc)
    # y[n] = alpha*x[n] + (1-alpha)*y[n-1] -- the lfilter form of the exact
    # same recurrence, valid because alpha is constant on a uniform grid.
    y_lfilter = signal.lfilter([alpha], [1.0, -(1.0 - alpha)], x)

    assert np.allclose(y_loop, y_lfilter, atol=1e-9), "Python onepole must equal its lfilter form (== vbt.ts's filter)"


def test_lowpass_rejects_high_frequency_keeps_low():
    fs = 200.0
    t = np.arange(0, 4.0, 1.0 / fs)
    low = np.sin(2 * np.pi * 2.0 * t)
    high = np.sin(2 * np.pi * 30.0 * t)
    x = low + high

    y = dsp.apply_butter_lp(x, fs, fc=6.0, order=2)

    # Compare power in a band around each tone, raw vs filtered.
    f, pxx_raw = signal.welch(x, fs=fs, nperseg=512)
    _, pxx_filt = signal.welch(y, fs=fs, nperseg=512)

    def band_power(f, pxx, center, half_width=0.5):
        mask = (f >= center - half_width) & (f <= center + half_width)
        return float(np.sum(pxx[mask]))

    low_raw, low_filt = band_power(f, pxx_raw, 2.0), band_power(f, pxx_filt, 2.0)
    high_raw, high_filt = band_power(f, pxx_raw, 30.0), band_power(f, pxx_filt, 30.0)

    low_drop_db = 10 * np.log10(low_filt / low_raw)
    high_drop_db = 10 * np.log10(high_filt / high_raw)

    assert low_drop_db > -1.0, f"2 Hz tone should survive a 6 Hz LP within 1 dB, got {low_drop_db:.2f} dB"
    assert high_drop_db < -20.0, f"30 Hz tone should be down >20 dB through a 6 Hz LP, got {high_drop_db:.2f} dB"


def test_exported_c_snippet_dc_gain_sane():
    # The exporter asserts its own DC-gain sanity internally; this just
    # exercises every exportable filter so a broken one fails loudly here
    # instead of silently in the UI.
    fs = 100.0
    assert "ALPHA" in dsp.export_c_snippet("onepole", fs, fc=10.0)
    assert "SOS" in dsp.export_c_snippet("butter2", fs, fc=6.0)
    assert "SOS" in dsp.export_c_snippet("butter4", fs, fc=6.0)
    assert "SOS" in dsp.export_c_snippet("highpass", fs, fc=0.3, order=2)
    assert "SOS" in dsp.export_c_snippet("notch", fs, f0=15.0, q=10.0)
    assert "MEDIAN_KERNEL" in dsp.export_c_snippet("median", fs, kernel=5)
    assert "SMA_WINDOW" in dsp.export_c_snippet("sma", fs, window=5)

    try:
        dsp.export_c_snippet("savgol", fs, window=11, polyorder=3)
        assert False, "savgol needs lookahead and must not be exportable"
    except ValueError:
        pass


def _run_all():
    tests = [obj for name, obj in globals().items() if name.startswith("test_") and callable(obj)]
    for test in tests:
        test()
        print(f"OK  {test.__name__}")
    print(f"\n{len(tests)} tests passed.")


if __name__ == "__main__":
    _run_all()
