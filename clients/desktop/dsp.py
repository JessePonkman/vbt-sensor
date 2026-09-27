# DSP core: uniform-grid reconstruction, the filter bank, integration to
# velocity, stats, and the two tools (PSD, Winter residual analysis) that
# actually pick a cutoff — plus the C exporter that turns that pick into a
# firmware snippet. See PLAN.md §5 for the reasoning behind every choice
# here; this file implements it without re-arguing it.

from __future__ import annotations

import math
import warnings
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np
from scipy import integrate, signal

from protocol import FLAG_IMU_READ_FAILED, FLAG_SCHED_LATE, FLAG_SCHED_RESYNC, Sample, delta_us

# ============================================================
# 5.1 — uniform grid reconstruction
# ============================================================

# Same threshold and meaning as vbt.ts's VBT_TUNING.DT_MAX_S: a gap this
# large between consecutive RECEIVED samples means a reboot or a link
# stall, not ordinary packet loss. Only the most recent contiguous run
# survives past it — stitching across a reboot would mix two unrelated
# clocks (the ESP32's micros() resets to ~0), and this tool's whole point is
# analyzing one clean capture, not reconciling several.
DT_MAX_S = 0.25


# The per-sample channels carried on the grid. Accel is always present;
# the rest arrive only on v2 packets and stay NaN for v1 data and for CSVs
# recorded before the v2 switch.
_CHANNELS = ("ax", "ay", "az", "gx", "gy", "gz", "temp_c")


@dataclass
class Grid:
    t: np.ndarray  # seconds, starts at 0 at the first kept sample
    ax: np.ndarray
    ay: np.ndarray
    az: np.ndarray
    gx: np.ndarray  # rad/s — all-NaN for v1 data
    gy: np.ndarray
    gz: np.ndarray
    temp_c: np.ndarray  # degrees C — all-NaN for v1 data
    jitter_us: np.ndarray  # NaN where interpolated: invented samples have no real timing
    flags: np.ndarray  # int, the firmware's VBT_FLAG_* bitfield; 0 where interpolated
    filled: np.ndarray  # bool — True where the sample was interpolated (a dropped packet)
    fs: float  # estimated sample rate, Hz — from the firmware's own timestamps, not a nominal constant
    # The kept run's first raw `sequence` value. Grid index k corresponds
    # to absolute sequence `seq0 + k`. Exposed so a stateful consumer
    # (imu.OrientationTracker via app.py) can tell what's genuinely NEW
    # between ticks even though LiveBuffer's deque(maxlen=...) evicts from
    # the front and to_grid rebuilds from scratch every tick — a raw
    # array index means a different sample each time, but seq0 + k does
    # not (PLAN-V2.md §6).
    seq0: int = 0


def to_grid(samples: Sequence[Sample]) -> Optional[Grid]:
    """Reconstructs the uniform grid the firmware actually sampled on.

    The firmware's scheduler (main.cpp: `lastSampleTime += SAMPLE_INTERVAL_US`)
    accumulates rather than reassigning, so it's drift-free by construction,
    and since v2 it transmits that scheduled time directly: every timestamp
    is an exact multiple of the sample interval since boot. The irregular dt
    a client observes comes entirely from packets lost over BLE, and
    `sequence` counts those losses exactly. So `k = sequence - sequence[0]`
    is the exact index into a grid of spacing `1/fs`, and this is what
    legitimates using fixed-coefficient filters (Butterworth,
    Savitzky-Golay) and Welch/PSD below — see PLAN.md §5.1.

    That uniformity is a property of the schedule, not of reality: the read
    itself still lands a little off its slot. v1 conflated the two by
    sending `micros()` taken after the I2C transaction, which made the grid
    claim false. v2 separates them — the scheduled time here, and the
    measured deviation in `jitter_us`, which `timing_stats()` summarises so
    the claim can be checked rather than trusted. See firmware/PLAN.md §3.2.
    """
    if len(samples) < 2:
        return None

    seq = np.fromiter((s.sequence for s in samples), dtype=np.int64, count=len(samples))
    ts = np.fromiter((s.timestamp for s in samples), dtype=np.int64, count=len(samples))
    chan = {
        name: np.fromiter((getattr(s, name) for s in samples), dtype=np.float64, count=len(samples))
        for name in _CHANNELS
    }
    jitter = np.fromiter((s.jitter_us for s in samples), dtype=np.float64, count=len(samples))
    flags = np.fromiter((s.flags for s in samples), dtype=np.int64, count=len(samples))

    # Defensive: BLE notifications are ordered and de-duplicated by the OS
    # stack, so a repeated/out-of-order sequence shouldn't happen — but if
    # one ever slips through, keep the first occurrence rather than let the
    # fancy-indexing assignment below silently overwrite it with the second.
    _, first_idx = np.unique(seq, return_index=True)
    if len(first_idx) != len(seq):
        first_idx = np.sort(first_idx)
        seq, ts, jitter, flags = seq[first_idx], ts[first_idx], jitter[first_idx], flags[first_idx]
        chan = {name: v[first_idx] for name, v in chan.items()}
    if len(seq) < 2:
        return None

    # dt between consecutive RECEIVED samples, wrap-safe (also what catches
    # a reboot: micros() resets near 0, so the wrap-safe delta comes out
    # huge — same mechanism vbt.ts relies on, see its deltaUs comment).
    dt_us = np.array([delta_us(int(ts[i - 1]), int(ts[i])) for i in range(1, len(ts))], dtype=np.float64)
    dt_s = dt_us / 1e6

    breaks = np.nonzero(dt_s >= DT_MAX_S)[0]  # break i sits between sample i and i+1
    start = int(breaks[-1]) + 1 if len(breaks) > 0 else 0
    seq, ts, jitter, flags = seq[start:], ts[start:], jitter[start:], flags[start:]
    chan = {name: v[start:] for name, v in chan.items()}
    dt_us = dt_us[start:]
    if len(seq) < 2:
        return None

    # fs from the median per-firmware-step dt over the kept run: dt between
    # consecutive received samples divided by their sequence gap gives the
    # true per-sample interval even across drops, and the median shrugs off
    # the rare outlier a real radio link produces. If firmware ever changes
    # SAMPLE_INTERVAL_US, this notices on its own instead of assuming 100 Hz.
    seq_gap = np.diff(seq).astype(np.float64)
    seq_gap[seq_gap <= 0] = 1.0  # guard only; dedup above already rules this out
    per_sample_us = dt_us / seq_gap
    fs = 1e6 / float(np.median(per_sample_us))

    k = (seq - seq[0]).astype(np.int64)
    n = int(k[-1]) + 1
    t = np.arange(n, dtype=np.float64) / fs

    filled = np.ones(n, dtype=bool)
    filled[k] = False

    # P4 (PLAN-V2.md §5.1): a transmitted packet can still carry stale
    # sensor values — main.cpp sets IMU_READ_FAILED when mpu.getEvent()
    # fails but the sensors_event_t structs it reads from keep whatever
    # they held before, so the packet arrives real (its seq/timestamp are
    # genuine grid slots) but its ax/ay/az/gx/gy/gz/temp_c are a repeat,
    # not a new reading. Treat those slots as additional gaps for the
    # sensor channels — interpolate through them instead of injecting a
    # false plateau — and mark them in `filled` alongside genuinely
    # dropped packets, since both are "not a real reading here".
    imu_failed_mask = (flags & FLAG_IMU_READ_FAILED) != 0
    failed_idx = k[imu_failed_mask]
    filled[failed_idx] = True
    missing = np.nonzero(filled)[0]

    out = {}
    for name, v in chan.items():
        o = np.full(n, np.nan, dtype=np.float64)
        o[k] = v
        o[failed_idx] = np.nan  # discard the stale reading before interpolating
        # Interpolate from the samples that actually carry a value. For a
        # channel the packet doesn't have at all — gyro and temperature on
        # v1 data — nothing is finite, so the whole column stays NaN instead
        # of being invented. np.interp would happily produce numbers here.
        real = np.isfinite(o)
        if len(missing) > 0 and real.any():
            o[missing] = np.interp(missing, np.nonzero(real)[0], o[real])
        out[name] = o

    # Timing and flags are diagnostics about a specific transmitted packet.
    # Interpolating them would be inventing evidence, so dropped slots get
    # NaN and a zero bitfield, and `filled` says which those are.
    out_jitter = np.full(n, np.nan, dtype=np.float64)
    out_jitter[k] = jitter
    out_flags = np.zeros(n, dtype=np.int64)
    out_flags[k] = flags

    return Grid(t=t, jitter_us=out_jitter, flags=out_flags, filled=filled, fs=fs, seq0=int(seq[0]), **out)


# ============================================================
# 5.2 — the filter bank
# ============================================================


def _clamp_fc(fc: float, fs: float) -> float:
    """Butterworth/notch designs blow up at/above Nyquist. Clamp instead of
    crashing if fs drops (heavy packet loss) below what a UI slider assumed."""
    return min(fc, fs / 2.0 * 0.99)


def apply_onepole(x: np.ndarray, fs: float, fc: float) -> np.ndarray:
    """One-pole IIR, written as the literal per-sample loop from vbt.ts
    (main.cpp / vbt.ts:722-724) rather than its `signal.lfilter` equivalent —
    on a uniform grid `alpha` is constant so the two ARE the same filter,
    and test_dsp.py asserts exactly that. Keeping this version is what makes
    the equivalence checkable instead of assumed."""
    dt = 1.0 / fs
    rc = 1.0 / (2 * np.pi * fc)
    alpha = dt / (dt + rc)
    y = np.empty(len(x), dtype=np.float64)
    prev = 0.0  # correct rest value by construction (see vbt.ts §2.3) — no transient to wait out
    for i, xi in enumerate(x):
        prev = prev + alpha * (xi - prev)
        y[i] = prev
    return y


def apply_butter_lp(x: np.ndarray, fs: float, fc: float, order: int = 2) -> np.ndarray:
    sos = signal.butter(order, _clamp_fc(fc, fs), btype="low", fs=fs, output="sos")
    return signal.sosfilt(sos, x)


def apply_butter_lp_zerophase(x: np.ndarray, fs: float, fc: float, order: int = 2) -> np.ndarray:
    """The reference: what the signal looks like with the causality
    constraint lifted, for measuring how much the causal filters above cost
    in phase delay. Never runnable on the MCU — analysis only."""
    sos = signal.butter(order, _clamp_fc(fc, fs), btype="low", fs=fs, output="sos")
    try:
        return signal.sosfiltfilt(sos, x)
    except ValueError:
        return signal.sosfilt(sos, x)  # buffer too short for filtfilt's edge padding — fall back to causal


def apply_butter_hp(x: np.ndarray, fs: float, fc: float, order: int = 2) -> np.ndarray:
    sos = signal.butter(order, _clamp_fc(fc, fs), btype="high", fs=fs, output="sos")
    return signal.sosfilt(sos, x)


def apply_savgol(x: np.ndarray, window: int, polyorder: int = 3) -> np.ndarray:
    n = len(x)
    window = max(polyorder + 2, window)
    if window % 2 == 0:
        window += 1
    window = min(window, n if n % 2 == 1 else n - 1)
    if window <= polyorder or window < 1:
        return np.asarray(x, dtype=np.float64)  # not enough samples yet to filter meaningfully
    return signal.savgol_filter(x, window_length=window, polyorder=polyorder)


def apply_sma(x: np.ndarray, window: int) -> np.ndarray:
    window = max(1, min(window, len(x)))
    kernel = np.ones(window) / window
    return np.convolve(x, kernel, mode="same")


def apply_median(x: np.ndarray, kernel: int = 5) -> np.ndarray:
    n = len(x)
    kernel = kernel if kernel % 2 == 1 else kernel + 1
    kernel = min(kernel, n if n % 2 == 1 else n - 1)
    if kernel < 3:
        return np.asarray(x, dtype=np.float64)
    return signal.medfilt(x, kernel_size=kernel)


def apply_notch(x: np.ndarray, fs: float, f0: float, q: float = 10.0) -> np.ndarray:
    b, a = signal.iirnotch(_clamp_fc(f0, fs), q, fs=fs)
    return signal.lfilter(b, a, x)


@dataclass
class FilterParam:
    name: str  # kwarg name `apply` reads
    label: str  # UI label
    kind: str  # "float" | "int"
    default: float
    lo: float
    hi: float
    step: float = 1.0


@dataclass
class FilterSpec:
    id: str
    label: str
    causal: bool  # can this run in real time from only past samples?
    exportable: bool  # ... and is it simple enough to hand-translate to C for the MCU?
    params: List[FilterParam]
    apply: Callable[..., np.ndarray]  # apply(x, fs, **param_values) -> y


# Table from PLAN.md §5.2. Every entry but "onepole" is a one-line call into
# scipy.signal — reimplementing Butterworth/Savitzky-Golay/median by hand is
# exactly the kind of arithmetic that gets debugged at 3am, and scipy is
# already a dependency.
FILTER_BANK: Dict[str, FilterSpec] = {
    "passthrough": FilterSpec(
        id="passthrough",
        label="Passthrough (crudo)",
        causal=True,
        exportable=False,
        params=[],
        apply=lambda x, fs, **_: np.asarray(x, dtype=np.float64),
    ),
    "onepole": FilterSpec(
        id="onepole",
        label="Un polo / EMA (igual a vbt.ts)",
        causal=True,
        exportable=True,
        params=[FilterParam("fc", "Corte (Hz)", "float", 10.0, 0.5, 40.0, 0.5)],
        apply=lambda x, fs, fc=10.0, **_: apply_onepole(x, fs, fc),
    ),
    "butter2": FilterSpec(
        id="butter2",
        label="Butterworth LP 2º orden",
        causal=True,
        exportable=True,
        params=[FilterParam("fc", "Corte (Hz)", "float", 6.0, 0.5, 40.0, 0.5)],
        apply=lambda x, fs, fc=6.0, **_: apply_butter_lp(x, fs, fc, order=2),
    ),
    "butter4": FilterSpec(
        id="butter4",
        label="Butterworth LP 4º orden",
        causal=True,
        exportable=True,
        params=[FilterParam("fc", "Corte (Hz)", "float", 6.0, 0.5, 40.0, 0.5)],
        apply=lambda x, fs, fc=6.0, **_: apply_butter_lp(x, fs, fc, order=4),
    ),
    "butter_zerophase": FilterSpec(
        id="butter_zerophase",
        label="Butterworth LP fase cero (referencia)",
        causal=False,
        exportable=False,
        params=[
            FilterParam("fc", "Corte (Hz)", "float", 6.0, 0.5, 40.0, 0.5),
            FilterParam("order", "Orden", "int", 2, 2, 4, 2),
        ],
        apply=lambda x, fs, fc=6.0, order=2, **_: apply_butter_lp_zerophase(x, fs, fc, order=int(order)),
    ),
    "savgol": FilterSpec(
        id="savgol",
        label="Savitzky–Golay",
        causal=False,  # needs lookahead within its window
        exportable=False,
        params=[
            FilterParam("window", "Ventana (muestras)", "int", 11, 5, 51, 2),
            FilterParam("polyorder", "Orden poly", "int", 3, 2, 5, 1),
        ],
        apply=lambda x, fs, window=11, polyorder=3, **_: apply_savgol(x, int(window), int(polyorder)),
    ),
    "sma": FilterSpec(
        id="sma",
        label="Media móvil (SMA)",
        causal=True,
        exportable=True,
        params=[FilterParam("window", "Ventana (muestras)", "int", 5, 2, 51, 1)],
        apply=lambda x, fs, window=5, **_: apply_sma(x, int(window)),
    ),
    "median": FilterSpec(
        id="median",
        label="Mediana",
        causal=True,
        exportable=True,
        params=[FilterParam("kernel", "Kernel (muestras)", "int", 5, 3, 9, 2)],
        apply=lambda x, fs, kernel=5, **_: apply_median(x, int(kernel)),
    ),
    "highpass": FilterSpec(
        id="highpass",
        label="Butterworth HP (quita DC / drift)",
        causal=True,
        exportable=True,
        params=[
            FilterParam("fc", "Corte (Hz)", "float", 0.3, 0.05, 2.0, 0.05),
            FilterParam("order", "Orden", "int", 2, 1, 2, 1),
        ],
        apply=lambda x, fs, fc=0.3, order=2, **_: apply_butter_hp(x, fs, fc, order=int(order)),
    ),
    "notch": FilterSpec(
        id="notch",
        label="Notch (resonancia mecánica)",
        causal=True,
        exportable=True,
        params=[
            FilterParam("f0", "Frecuencia (Hz)", "float", 15.0, 1.0, 45.0, 0.5),
            FilterParam("q", "Q", "float", 10.0, 1.0, 30.0, 0.5),
        ],
        apply=lambda x, fs, f0=15.0, q=10.0, **_: apply_notch(x, fs, f0, q),
    ),
}


def apply_filter(filter_id: str, x: np.ndarray, fs: float, **params) -> np.ndarray:
    return FILTER_BANK[filter_id].apply(x, fs, **params)


# ============================================================
# 5.3 — gravity calibration, integration, drift control
# ============================================================

# Same two guards as vbt.ts's calibrate() (vbt.ts:132) — reject a "rest"
# capture that wasn't actually still, or that measured an implausible |g|
# (wrong sensor range register, dead axis).
CALIB_G_MIN = 8.5
CALIB_G_MAX = 11.0
CALIB_STILL_RMS = 0.12

# PLAN-V2.md §7: a rest capture with the gyro reading anything but near-
# zero wasn't actually still, no matter how quiet the accelerometer looks
# — the same 3 deg/s the C4 online re-bias uses (from Fusion's own bias
# algorithm), applied here to "Capturar reposo" too.
CALIB_GYRO_STILL_DEG_S = 3.0


@dataclass
class Calibration:
    bias: np.ndarray  # [bx, by, bz] — the measured accel rest vector, m/s^2
    g_mag: float
    # v2 additions (PLAN-V2.md §3.2 C2/C5). NaN/nan-filled when the capture
    # has no gyro/temperature (v1) — never fabricated as zero, same rule
    # protocol.Sample already applies to a single sample.
    gyro_bias: np.ndarray = field(default_factory=lambda: np.full(3, math.nan))  # rad/s
    temp_c: float = math.nan  # sensor temperature at calibration time
    sigma_a: float = math.nan  # pooled per-axis accel std at rest, m/s^2 — SHOE's sigma_a
    sigma_g: float = math.nan  # pooled per-axis gyro std at rest, rad/s — SHOE/ARE's sigma_g


def calibrate(
    ax: np.ndarray,
    ay: np.ndarray,
    az: np.ndarray,
    gx: Optional[np.ndarray] = None,
    gy: Optional[np.ndarray] = None,
    gz: Optional[np.ndarray] = None,
    temp_c: Optional[np.ndarray] = None,
) -> Optional[Calibration]:
    """vbt.ts's calibrate(), ported — but keeps the full 3-axis bias rather
    than only its magnitude/unit projection, because this tool needs three
    independent per-axis velocities, not one vertical one.

    gx/gy/gz/temp_c are optional (None or all-NaN for a v1 capture) so this
    one function still serves both packet versions. When gyro is present,
    a third guard applies on top of the original two: the gyro itself has
    to read near-zero, or the "rest" wasn't a rest (PLAN-V2.md §7)."""
    if len(ax) == 0:
        return None
    bias = np.array([float(np.mean(ax)), float(np.mean(ay)), float(np.mean(az))])
    g_mag = float(np.linalg.norm(bias))
    if not (CALIB_G_MIN <= g_mag <= CALIB_G_MAX):
        return None
    dx, dy, dz = ax - bias[0], ay - bias[1], az - bias[2]
    still_rms = float(np.sqrt(np.mean(dx**2 + dy**2 + dz**2)))
    if still_rms > CALIB_STILL_RMS:
        return None
    sigma_a = float(np.std(np.concatenate([dx, dy, dz])))

    gyro_bias = np.full(3, math.nan)
    sigma_g = math.nan
    have_gyro = gx is not None and len(gx) > 0 and bool(np.all(np.isfinite(gx)))
    if have_gyro:
        gyro_bias = np.array([float(np.mean(gx)), float(np.mean(gy)), float(np.mean(gz))])
        gyro_still_deg_s = math.degrees(float(np.linalg.norm(gyro_bias)))
        if gyro_still_deg_s >= CALIB_GYRO_STILL_DEG_S:
            return None  # gyro says this wasn't actually still
        gdx, gdy, gdz = gx - gyro_bias[0], gy - gyro_bias[1], gz - gyro_bias[2]
        sigma_g = float(np.std(np.concatenate([gdx, gdy, gdz])))

    t_cal = math.nan
    if temp_c is not None and len(temp_c) > 0 and bool(np.all(np.isfinite(temp_c))):
        t_cal = float(np.mean(temp_c))

    return Calibration(bias=bias, g_mag=g_mag, gyro_bias=gyro_bias, temp_c=t_cal, sigma_a=sigma_a, sigma_g=sigma_g)


def project_vertical(ax: np.ndarray, ay: np.ndarray, az: np.ndarray, calib: Calibration) -> np.ndarray:
    """a . g_hat - |g| (vbt.ts:716, ported): signed acceleration along the
    gravity axis with the resting bias removed — the one number comparable
    against the mobile app's v_vert."""
    g_hat = calib.bias / calib.g_mag
    return ax * g_hat[0] + ay * g_hat[1] + az * g_hat[2] - calib.g_mag


def integrate_velocity(a: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Trapezoidal integration — same rule as vbt.ts (vbt.ts:530 / firmware
    main.cpp), so numbers are comparable across clients."""
    return integrate.cumulative_trapezoid(a, t, initial=0.0)


def detrend_linear(t: np.ndarray, v: np.ndarray) -> Tuple[np.ndarray, float]:
    """vbt.ts's detrend() (vbt.ts:174), ported: a constant accelerometer
    bias produces a velocity error exactly linear in time, and v(T)/T over a
    clean re-integration from v=0 IS that error — this is its exact inverse,
    not a fudge factor. Returns (corrected_v, bias)."""
    span = t[-1] - t[0] if len(t) > 1 else 0.0
    if span <= 0:
        return v.astype(np.float64, copy=True), 0.0
    bias = v[-1] / span
    corrected = v - bias * (t - t[0])
    return corrected, float(bias)


def detrend_segments(t: np.ndarray, v: np.ndarray, rest_intervals: Sequence[Tuple[int, int]]) -> np.ndarray:
    """I4 (PLAN-V2.md §5.5): the same exact-inverse reasoning as
    detrend_linear, applied per movement segment instead of over the
    whole window. Between two detected rest intervals, re-zero to
    v(t_a) = 0 and subtract the ramp that would bring v(t_b) back to 0 —
    detrend_linear is the single-segment special case of this.

    Unlike apply_zupt's hard clamp, this leaves velocity CONTINUOUS across
    the seams (no discontinuity at a rest boundary), at the cost of being
    non-causal within a segment: it needs to see where the segment ends
    before it can correct its start. `rest_intervals` come from
    imu.find_rest_intervals() over whichever detector (Z1/Z2/Z3) is
    selected."""
    out = v.astype(np.float64, copy=True)
    if len(rest_intervals) < 2:
        return out
    for k in range(len(rest_intervals) - 1):
        _, ea = rest_intervals[k]
        sb, _ = rest_intervals[k + 1]
        if sb <= ea:
            continue
        seg_t = t[ea : sb + 1]
        seg_v = v[ea : sb + 1] - v[ea]  # re-zero to v(t_a) = 0 for this segment
        span = seg_t[-1] - seg_t[0]
        if span > 0:
            bias = seg_v[-1] / span
            seg_v = seg_v - bias * (seg_t - seg_t[0])
        out[ea : sb + 1] = seg_v
    return out


def rms(x: np.ndarray) -> float:
    if len(x) == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.asarray(x, dtype=np.float64) ** 2)))


def rolling_rms(x: np.ndarray, window: int) -> np.ndarray:
    """Windowed RMS, vectorized. Centered (via convolve's "same" mode)
    rather than the trailing-only window vbt.ts's isStill() uses — that
    causal constraint is real for a streaming FSM but doesn't apply here:
    this operates on an already-fully-buffered array, so a centered window
    is simply a better (unbiased, no lag) estimate for this offline/replay
    context, and it's a one-line convolve instead of a per-sample scan."""
    window = max(1, int(window))
    kernel = np.ones(window) / window
    mean_sq = np.convolve(np.asarray(x, dtype=np.float64) ** 2, kernel, mode="same")
    return np.sqrt(np.maximum(mean_sq, 0.0))


def apply_zupt(
    v: np.ndarray,
    a_filtered: np.ndarray,
    fs: float,
    window_ms: float = 300.0,
    acc_rms_thresh: float = 0.15,
    v_max: float = 0.3,
) -> np.ndarray:
    """Zero-velocity update: clamp v to 0 wherever the athlete is provably
    still — both a low acceleration RMS AND an already-small v, the same
    two-discriminator guard as vbt.ts's isStill() + ZUPT_V_MAX (vbt.ts:454),
    ported from its streaming design to this batch context."""
    window = max(1, int(round(window_ms / 1000.0 * fs)))
    still = rolling_rms(a_filtered, window) <= acc_rms_thresh
    out = v.astype(np.float64, copy=True)
    out[still & (np.abs(out) < v_max)] = 0.0
    return out


def apply_zupt_mask(v: np.ndarray, rest_mask: np.ndarray, v_max: float = 0.3) -> np.ndarray:
    """Same clamp as apply_zupt, but taking an externally computed rest
    mask instead of deriving one from |a| RMS internally — the hook that
    lets the Velocity tab's rest-detector selector (Z1/Z2/Z3, PLAN-V2.md
    §5.5/§7) drive the SAME zero-velocity-update action apply_zupt always
    performed. apply_zupt(...) is Z1's specific case of this."""
    out = v.astype(np.float64, copy=True)
    out[rest_mask & (np.abs(out) < v_max)] = 0.0
    return out


def rolling_rms_rest_mask(a_filtered: np.ndarray, fs: float, window_ms: float = 300.0, acc_rms_thresh: float = 0.15) -> np.ndarray:
    """Z1's rest mask on its own (no v_max guard) — exposed so the
    Velocity tab's detector selector can treat Z1 uniformly alongside
    Z2 (imu.are)/Z3 (imu.shoe) for feeding I4/C4/O6, all of which need a
    plain rest mask rather than apply_zupt's already-clamped output."""
    window = max(1, int(round(window_ms / 1000.0 * fs)))
    return rolling_rms(a_filtered, window) <= acc_rms_thresh


# ============================================================
# 5.4 — stats
# ============================================================


@dataclass
class AxisStats:
    max: float = 0.0
    min: float = 0.0
    mean: float = 0.0
    median: float = 0.0
    std: float = 0.0
    rms: float = 0.0
    peak_to_peak: float = 0.0


def axis_stats(x: np.ndarray) -> AxisStats:
    if len(x) == 0:
        return AxisStats()
    x = np.asarray(x, dtype=np.float64)
    return AxisStats(
        max=float(np.max(x)),
        min=float(np.min(x)),
        mean=float(np.mean(x)),
        median=float(np.median(x)),
        std=float(np.std(x)),
        rms=rms(x),
        peak_to_peak=float(np.max(x) - np.min(x)),
    )


@dataclass
class TimingStats:
    n: int = 0  # real (non-interpolated) samples the numbers are drawn from
    median_abs_us: float = 0.0
    p95_abs_us: float = 0.0
    max_abs_us: float = 0.0
    spread_us: float = 0.0  # p95 - p5 of the SIGNED jitter
    late_fraction: float = 0.0
    resync_count: int = 0


def timing_stats(grid: Grid) -> TimingStats:
    """Summarises how far the firmware's reads landed from their scheduled
    slots. This is what makes the uniform grid in `to_grid` an assertion
    that can be checked instead of one that has to be believed.

    `spread_us` is the number that matters, not the median. A constant
    offset — the I2C read always finishing ~400 us after its slot — is a
    pure delay and harmless. It's the variation around it that shows up as
    timing noise on the grid, proportional to the signal's slope.

    Returns zeros for v1 data, where jitter is NaN and unknowable.
    """
    real = ~grid.filled
    j = grid.jitter_us[real]
    j = j[np.isfinite(j)]
    if len(j) == 0:
        return TimingStats()

    fl = grid.flags[real]
    return TimingStats(
        n=len(j),
        median_abs_us=float(np.median(np.abs(j))),
        p95_abs_us=float(np.percentile(np.abs(j), 95)),
        max_abs_us=float(np.max(np.abs(j))),
        spread_us=float(np.percentile(j, 95) - np.percentile(j, 5)),
        late_fraction=float(np.mean((fl & FLAG_SCHED_LATE) != 0)),
        resync_count=int(np.count_nonzero(fl & FLAG_SCHED_RESYNC)),
    )


def gyro_available(grid: Grid) -> bool:
    """False for v1 captures, where the gyro columns are entirely NaN."""
    return bool(np.any(np.isfinite(grid.gx)))


# ============================================================
# 5.5 — the tools that actually pick a filter
# ============================================================


def psd(x: np.ndarray, fs: float) -> Tuple[np.ndarray, np.ndarray]:
    """Welch PSD — where the signal ends and the noise floor begins."""
    n = len(x)
    if n < 8:
        return np.array([]), np.array([])
    nperseg = min(512, n)
    return signal.welch(x, fs=fs, nperseg=nperseg)


@dataclass
class WinterResult:
    fc: np.ndarray  # candidate cutoffs swept, Hz
    residual: np.ndarray  # RMS(raw - filtered(fc)), same units as x
    intercept: float  # extrapolated pure-noise RMS at fc=0
    chosen_fc: float  # last fc still doing real smoothing work before the tail flattens


def winter_residual_analysis(
    x: np.ndarray,
    fs: float,
    fc_range: Optional[np.ndarray] = None,
    tail_frac: float = 0.75,
) -> WinterResult:
    """Winter's residual-analysis method (the standard objective cutoff-
    picker in biomechanics): filter at each candidate fc, take the RMS
    residual against the raw signal, fit a line through the noise-only tail
    (high fc, where the filter barely touches anything left so the residual
    has flattened), and extrapolate that line back to fc=0 — its intercept
    is the estimated pure-noise RMS. The chosen cutoff is the last fc where
    the residual is still above that noise floor, i.e. still doing real
    smoothing work. See PLAN.md §5.5b."""
    if fc_range is None:
        fc_range = np.arange(1.0, min(20.0, fs / 2 * 0.9), 0.5)
    residual = np.array([rms(x - apply_butter_lp(x, fs, fc, order=2)) for fc in fc_range])

    tail_start = max(0, int(len(fc_range) * tail_frac))
    tail_fc, tail_res = fc_range[tail_start:], residual[tail_start:]
    if len(tail_fc) < 2:
        return WinterResult(fc=fc_range, residual=residual, intercept=0.0, chosen_fc=float(fc_range[0]))

    slope, intercept = np.polyfit(tail_fc, tail_res, 1)
    above = np.nonzero(residual >= intercept)[0]
    chosen_idx = int(above[-1]) if len(above) > 0 else 0
    return WinterResult(fc=fc_range, residual=residual, intercept=float(intercept), chosen_fc=float(fc_range[chosen_idx]))


def design_lowpass_sos(fc: float, fs: float, order: int = 2, btype: str = "low") -> np.ndarray:
    """Thin public wrapper around signal.butter — lets the UI's filter
    design readout get an SOS array (for group_delay_ms) without importing
    scipy directly; all scipy usage stays in this module."""
    return signal.butter(order, _clamp_fc(fc, fs), btype=btype, fs=fs, output="sos")


def group_delay_ms(sos: np.ndarray, fs: float, at_hz: float = 0.0) -> float:
    """Group delay of an SOS filter, in ms, at `at_hz` (default ~DC — the
    number that matters, since the VBT signal of interest lives under
    ~10 Hz, see PLAN.md §8). Queries that single frequency directly rather
    than sweeping a grid and picking the nearest point — there's only ever
    one number to read.

    DC itself is nudged a hair positive first: it's a genuine gain-null
    singularity for any highpass/notch design, and scipy warns loudly about
    evaluating on top of it. A few Hz off zero costs nothing for a signal
    that lives under ~10 Hz anyway. The warning suppression below is a
    second layer of the same guard — this filter's poles are nowhere near
    the unit circle at a sane VBT cutoff (verified: see test_dsp.py), so any
    warning scipy still raises is its own boundary heuristic being
    conservative, not a real problem with the design.
    """
    b, a = signal.sos2tf(sos)
    query_hz = max(at_hz, fs / 2000.0)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        _, gd = signal.group_delay((b, a), w=np.array([query_hz]), fs=fs)
    return float(gd[0] / fs * 1000.0)


# ============================================================
# 5.6 — C exporter
# ============================================================
#
# Every number here comes from the exact same scipy call that drew the
# curve on screen — that's what makes the snippet trustworthy instead of a
# hand-transcribed guess. See PLAN.md §5.6.

_BIQUAD_CASCADE_C = """\
// Forma directa II transpuesta. c = [b0, b1, b2, a0, a1, a2] (a0 == 1).
static inline float biquad(float x, const float c[6], float s[2]) {{
    float y = c[0]*x + s[0];
    s[0] = c[1]*x - c[4]*y + s[1];
    s[1] = c[2]*x - c[5]*y;
    return y;
}}

static inline float sos_filter(float x, float state[{n}][2]) {{
    for (int i = 0; i < {n}; i++) x = biquad(x, SOS[i], state[i]);
    return x;
}}"""

_DC_EXPECTED = {"low": 1.0, "high": 0.0, "notch": 1.0}


def _render_biquad_c(sos: np.ndarray, fs: float, kind: str, header: str, gd_at_hz: float = 0.0) -> str:
    n = sos.shape[0]
    # A highpass has zero gain AT DC by design (asserted below) — group
    # delay evaluated right on top of that null is a near-singularity, not
    # a meaningful number (scipy warns about exactly this). Callers report
    # a highpass's delay at a passband frequency instead; DC stays right
    # for low/notch, which have full gain there.
    gd_ms = group_delay_ms(sos, fs, at_hz=gd_at_hz)
    b, a = signal.sos2tf(sos)
    dc = float(np.sum(b) / np.sum(a))
    expected = _DC_EXPECTED[kind]
    assert abs(dc - expected) < 1e-3, f"ganancia DC {dc:.4f}, se esperaba ~{expected} — bug en el exportador"

    gd_label = "@ DC" if abs(gd_at_hz) < 1e-9 else f"@ {gd_at_hz:.1f} Hz (en banda de paso — a DC un HP tiene ganancia nula, el retardo ahí no es significativo)"
    lines = [
        f"// {header} @ fs = {fs:.1f} Hz",
        f"// Generado por clients/desktop — retardo de grupo ~ {gd_ms:.1f} ms {gd_label}. Ganancia DC: {dc:.6f}",
        f"// Costo: {5*n} mul, {4*n} add, {2*n} floats de estado, por eje.",
        f"static const float SOS[{n}][6] = {{",
    ]
    for b0, b1, b2, a0, a1, a2 in sos:
        assert abs(a0 - 1.0) < 1e-9, "scipy siempre normaliza a0=1 en cada sección SOS"
        lines.append(f"    {{ {b0:.8f}f, {b1:.8f}f, {b2:.8f}f, {a0:.1f}f, {a1:.8f}f, {a2:.8f}f }},")
    lines.append("};")
    lines.append(_BIQUAD_CASCADE_C.format(n=n))
    return "\n".join(lines)


def _render_onepole_c(fc: float, fs: float) -> str:
    dt = 1.0 / fs
    rc = 1.0 / (2 * np.pi * fc)
    alpha = dt / (dt + rc)
    # Expressed as a degenerate 1st-order SOS row purely to reuse
    # group_delay_ms — the emitted C below is the true minimal EMA form,
    # not this biquad shape.
    sos = np.array([[alpha, 0.0, 0.0, 1.0, -(1.0 - alpha), 0.0]])
    gd_ms = group_delay_ms(sos, fs)
    return "\n".join(
        [
            f"// Un polo / EMA, fc = {fc:.2f} Hz @ fs = {fs:.1f} Hz — idéntico al de clients/mobile/src/vbt.ts",
            f"// Generado por clients/desktop — retardo de grupo ~ {gd_ms:.1f} ms @ DC.",
            "// Costo: 1 mul, 2 add, 1 float de estado, por eje.",
            f"static const float ALPHA = {alpha:.8f}f;",
            "// dt es fijo en firmware (scheduler de loop(), ver main.cpp) -> alpha es",
            "// constante. A diferencia de vbt.ts, que recalcula alpha por muestra: eso",
            "// es solo para sobrevivir al dt VARIABLE que ve el cliente BLE por paquetes",
            "// perdidos en el aire, algo que no existe dentro del propio firmware.",
            "static inline float onepole(float x, float *y) {",
            "    *y += ALPHA * (x - *y);",
            "    return *y;",
            "}",
        ]
    )


def _render_median_c(kernel: int) -> str:
    kernel = kernel if kernel % 2 == 1 else kernel + 1
    delay_ms = (kernel - 1) / 2  # exact for a length-N median/SMA window, in samples
    return "\n".join(
        [
            f"// Mediana, kernel = {kernel} muestras",
            f"// Generado por clients/desktop. Retardo = {delay_ms:.1f} muestras (exacto).",
            f"// Costo: sort de {kernel} floats, por eje, por muestra.",
            f"#define MEDIAN_KERNEL {kernel}",
            "static inline float median_filter(float x, float ring[MEDIAN_KERNEL], int *idx) {",
            "    ring[*idx] = x;",
            "    *idx = (*idx + 1) % MEDIAN_KERNEL;",
            "    float sorted[MEDIAN_KERNEL];",
            "    memcpy(sorted, ring, sizeof(sorted));",
            "    // insertion sort -- MEDIAN_KERNEL es chico (3-9), gana a qsort() por overhead",
            "    for (int i = 1; i < MEDIAN_KERNEL; i++) {",
            "        float key = sorted[i]; int j = i - 1;",
            "        while (j >= 0 && sorted[j] > key) { sorted[j + 1] = sorted[j]; j--; }",
            "        sorted[j + 1] = key;",
            "    }",
            "    return sorted[MEDIAN_KERNEL / 2];",
            "}",
        ]
    )


def _render_sma_c(window: int) -> str:
    delay_ms = (window - 1) / 2  # exact for a length-N running average
    return "\n".join(
        [
            f"// Media móvil, ventana = {window} muestras",
            f"// Generado por clients/desktop. Retardo = {delay_ms:.1f} muestras (exacto).",
            f"// Costo: 2 flops + ring de {window} floats, por eje.",
            f"#define SMA_WINDOW {window}",
            "static inline float sma_filter(float x, float ring[SMA_WINDOW], int *idx, float *sum) {",
            "    *sum -= ring[*idx];",
            "    ring[*idx] = x;",
            "    *sum += x;",
            "    *idx = (*idx + 1) % SMA_WINDOW;",
            "    return *sum / SMA_WINDOW;",
            "}",
        ]
    )


def export_c_snippet(filter_id: str, fs: float, **params) -> str:
    """Renders the C snippet described in PLAN.md §5.6, ready to paste into
    main.cpp. Only filters simple enough to run causally on the MCU are
    exportable — the zero-phase and Savitzky-Golay bank entries are
    analysis-only references and raise here."""
    spec = FILTER_BANK[filter_id]
    if not spec.exportable:
        raise ValueError(f"{spec.label} no es causal / no corre en el MCU — solo referencia de análisis")

    if filter_id == "onepole":
        return _render_onepole_c(float(params.get("fc", 10.0)), fs)

    if filter_id == "median":
        return _render_median_c(int(params.get("kernel", 5)))

    if filter_id == "sma":
        return _render_sma_c(int(params.get("window", 5)))

    if filter_id == "butter2":
        fc = float(params.get("fc", 6.0))
        sos = signal.butter(2, _clamp_fc(fc, fs), btype="low", fs=fs, output="sos")
        return _render_biquad_c(sos, fs, "low", f"Butterworth LP 2º orden, fc = {fc:.2f} Hz")

    if filter_id == "butter4":
        fc = float(params.get("fc", 6.0))
        sos = signal.butter(4, _clamp_fc(fc, fs), btype="low", fs=fs, output="sos")
        return _render_biquad_c(sos, fs, "low", f"Butterworth LP 4º orden, fc = {fc:.2f} Hz")

    if filter_id == "highpass":
        fc = float(params.get("fc", 0.3))
        order = int(params.get("order", 2))
        sos = signal.butter(order, _clamp_fc(fc, fs), btype="high", fs=fs, output="sos")
        gd_at_hz = min(fs / 4.0, max(fc * 5.0, 2.0))  # comfortably into the passband, clear of both DC and Nyquist
        return _render_biquad_c(sos, fs, "high", f"Butterworth HP {order}º orden, fc = {fc:.2f} Hz", gd_at_hz=gd_at_hz)

    if filter_id == "notch":
        f0 = float(params.get("f0", 15.0))
        q = float(params.get("q", 10.0))
        b, a = signal.iirnotch(_clamp_fc(f0, fs), q, fs=fs)
        sos = signal.tf2sos(b, a)
        return _render_biquad_c(sos, fs, "notch", f"Notch IIR, f0 = {f0:.2f} Hz, Q = {q:.1f}")

    raise ValueError(f"no hay exportador de C para '{filter_id}'")


# ============================================================
# E2 / E3 / E4 — orientation and thermal C exporters (PLAN-V2.md §8)
#
# Same contract as §5.6 above: every constant here is the exact parameter
# the UI's Orientation/Sensor tabs used to draw the curve on screen. The
# per-sample operation sequence in each C function is written to match
# imu.mahony_step / imu.madgwick_step exactly, line for line — test_dsp.py
# checks a Python transliteration of each against those functions, which
# is what makes "what you see is what ships" checkable for these two
# instead of only asserted in a docstring.
# ============================================================


def export_mahony_c(
    fs: float,
    kp: float,
    ki: float,
    g_mag: float,
    q0: Tuple[float, float, float, float],
    tol_mag: float = 1.0,
    tol_ang_deg: float = 10.0,
    reject: bool = True,
) -> str:
    """E2: Mahony (or, with ki == 0, the explicit complementary filter —
    same code, one constant at zero, see PLAN-V2.md §5.3) exported as a
    self-contained C function returning `a_vert` directly, so E1's
    low-pass snippet can be chained straight onto its output."""
    label = "Complementario (Mahony con Ki = 0)" if ki <= 0 else "Mahony (PI, con bias de giro)"
    dt = 1.0 / fs
    q0w, q0x, q0y, q0z = q0
    cos_tol = math.cos(math.radians(tol_ang_deg))

    lines = [
        f"// {label} @ fs = {fs:.1f} Hz — PLAN-V2.md §5.3 / §8 (E2)",
        "// Generado por clients/desktop. Devuelve a_vert = a . g_hat(t) - |g|; encadenar",
        "// con el pasa-bajos exportado en E1 (PLAN.md §5.6) sobre ese resultado.",
        "// Estado: q[4] + bias_i[3] = 7 floats. Costo por muestra: ~55 flops + 2 sqrtf.",
        f"static const float MAHONY_KP = {kp:.8f}f;",
        f"static const float MAHONY_KI = {ki:.8f}f;",
        f"static const float MAHONY_DT = {dt:.8f}f;",
        f"static const float G_MAG = {g_mag:.6f}f;",
    ]
    if reject:
        lines += [
            f"static const float ACC_TOL_MAG = {tol_mag:.6f}f;       // rechazo: | |a| - |g| | < esto",
            f"static const float ACC_TOL_COS_ANG = {cos_tol:.6f}f;   // cos({tol_ang_deg:.1f} deg)",
        ]
    lines += [
        f"static float q[4] = {{ {q0w:.8f}f, {q0x:.8f}f, {q0y:.8f}f, {q0z:.8f}f }};  // desde \"Capturar reposo\"",
        "static float bias_i[3] = { 0.0f, 0.0f, 0.0f };",
        "",
        "// gx/gy/gz en rad/s, ax/ay/az en m/s^2. Devuelve a_vert, m/s^2.",
        "static inline float mahony_step_vert(float gx, float gy, float gz, float ax, float ay, float az) {",
        "    float q0_ = q[0], q1_ = q[1], q2_ = q[2], q3_ = q[3];",
        "    float vx = 2.0f * (q1_*q3_ - q0_*q2_);",
        "    float vy = 2.0f * (q0_*q1_ + q2_*q3_);",
        "    float vz = q0_*q0_ - q1_*q1_ - q2_*q2_ + q3_*q3_;",
        "",
        "    float n = sqrtf(ax*ax + ay*ay + az*az);",
        "    int accept = n > 1e-6f;",
    ]
    if reject:
        lines.append("    if (accept) accept = fabsf(n - G_MAG) < ACC_TOL_MAG;")
    lines += [
        "    float axn = 0.0f, ayn = 0.0f, azn = 0.0f;",
        "    if (accept) { axn = ax / n; ayn = ay / n; azn = az / n; }",
    ]
    if reject:
        lines.append("    if (accept) accept = (axn*vx + ayn*vy + azn*vz) > ACC_TOL_COS_ANG;")
    lines += [
        "    if (accept) {",
        "        float ex = ayn*vz - azn*vy, ey = azn*vx - axn*vz, ez = axn*vy - ayn*vx;",
    ]
    if ki > 0.0:
        lines += [
            "        bias_i[0] += MAHONY_KI * ex * MAHONY_DT;",
            "        bias_i[1] += MAHONY_KI * ey * MAHONY_DT;",
            "        bias_i[2] += MAHONY_KI * ez * MAHONY_DT;",
        ]
    lines += [
        "        gx += MAHONY_KP * ex; gy += MAHONY_KP * ey; gz += MAHONY_KP * ez;",
        "    }",
        "    gx += bias_i[0]; gy += bias_i[1]; gz += bias_i[2];",
        "",
        "    float hx = gx * 0.5f * MAHONY_DT, hy = gy * 0.5f * MAHONY_DT, hz = gz * 0.5f * MAHONY_DT;",
        "    float q0n = q0_ - q1_*hx - q2_*hy - q3_*hz;",
        "    float q1n = q1_ + q0_*hx + q2_*hz - q3_*hy;",
        "    float q2n = q2_ + q0_*hy - q1_*hz + q3_*hx;",
        "    float q3n = q3_ + q0_*hz + q1_*hy - q2_*hx;",
        "    float qn = sqrtf(q0n*q0n + q1n*q1n + q2n*q2n + q3n*q3n);",
        "    q[0] = q0n / qn; q[1] = q1n / qn; q[2] = q2n / qn; q[3] = q3n / qn;",
        "",
        "    float gbx = 2.0f * (q[1]*q[3] - q[0]*q[2]);",
        "    float gby = 2.0f * (q[0]*q[1] + q[2]*q[3]);",
        "    float gbz = q[0]*q[0] - q[1]*q[1] - q[2]*q[2] + q[3]*q[3];",
        "    return ax*gbx + ay*gby + az*gbz - G_MAG;",
        "}",
    ]
    return "\n".join(lines)


def export_madgwick_c(
    fs: float,
    beta: float,
    g_mag: float,
    q0: Tuple[float, float, float, float],
    tol_mag: float = 1.0,
    tol_ang_deg: float = 10.0,
    reject: bool = True,
) -> str:
    """E3: Madgwick's IMU (no-magnetometer) gradient-descent update,
    exported the same way as E2 — see PLAN-V2.md §5.6/§8. No bias state:
    the IMU variant's deriving compensation only exists in the MARG
    (with-magnetometer) form, which this project explicitly doesn't use
    (§10 — no magnetometer)."""
    dt = 1.0 / fs
    q0w, q0x, q0y, q0z = q0
    cos_tol = math.cos(math.radians(tol_ang_deg))

    lines = [
        f"// Madgwick IMU, beta = {beta:.4f} @ fs = {fs:.1f} Hz — PLAN-V2.md §5.6 / §8 (E3)",
        "// Generado por clients/desktop. Devuelve a_vert = a . g_hat(t) - |g|; encadenar",
        "// con el pasa-bajos exportado en E1 (PLAN.md §5.6) sobre ese resultado.",
        "// Estado: q[4] = 4 floats. Costo por muestra: ~100 flops + 2 sqrtf.",
        f"static const float MADGWICK_BETA = {beta:.8f}f;",
        f"static const float MADGWICK_DT = {dt:.8f}f;",
        f"static const float G_MAG = {g_mag:.6f}f;",
    ]
    if reject:
        lines += [
            f"static const float ACC_TOL_MAG = {tol_mag:.6f}f;",
            f"static const float ACC_TOL_COS_ANG = {cos_tol:.6f}f;   // cos({tol_ang_deg:.1f} deg)",
        ]
    lines += [
        f"static float q[4] = {{ {q0w:.8f}f, {q0x:.8f}f, {q0y:.8f}f, {q0z:.8f}f }};  // desde \"Capturar reposo\"",
        "",
        "static inline float madgwick_step_vert(float gx, float gy, float gz, float ax, float ay, float az) {",
        "    float q0_ = q[0], q1_ = q[1], q2_ = q[2], q3_ = q[3];",
        "    float n = sqrtf(ax*ax + ay*ay + az*az);",
        "    int accept = n > 1e-6f;",
    ]
    if reject:
        lines.append("    if (accept) accept = fabsf(n - G_MAG) < ACC_TOL_MAG;")
    lines += [
        "    float axn = 0.0f, ayn = 0.0f, azn = 0.0f;",
        "    if (accept) { axn = ax / n; ayn = ay / n; azn = az / n; }",
    ]
    if reject:
        lines += [
            "    if (accept) {",
            "        float vx = 2.0f*(q1_*q3_ - q0_*q2_), vy = 2.0f*(q0_*q1_ + q2_*q3_);",
            "        float vz = q0_*q0_ - q1_*q1_ - q2_*q2_ + q3_*q3_;",
            "        accept = (axn*vx + ayn*vy + azn*vz) > ACC_TOL_COS_ANG;",
            "    }",
        ]
    lines += [
        "",
        "    float qd0 = -0.5f * (q1_*gx + q2_*gy + q3_*gz);",
        "    float qd1 =  0.5f * (q0_*gx + q2_*gz - q3_*gy);",
        "    float qd2 =  0.5f * (q0_*gy - q1_*gz + q3_*gx);",
        "    float qd3 =  0.5f * (q0_*gz + q1_*gy - q2_*gx);",
        "",
        "    if (accept) {",
        "        float f1 = 2.0f*(q1_*q3_ - q0_*q2_) - axn;",
        "        float f2 = 2.0f*(q0_*q1_ + q2_*q3_) - ayn;",
        "        float f3 = 1.0f - 2.0f*(q1_*q1_ + q2_*q2_) - azn;",
        "        float j11j24 = 2.0f*q2_, j12j23 = 2.0f*q3_, j13j22 = 2.0f*q0_, j14j21 = 2.0f*q1_;",
        "        float j32 = 2.0f*j14j21, j33 = 2.0f*j11j24;",
        "        float g0 = j14j21*f2 - j11j24*f1;",
        "        float g1 = j12j23*f1 + j13j22*f2 - j32*f3;",
        "        float g2 = -j13j22*f1 + j12j23*f2 - j33*f3;",
        "        float g3 = j11j24*f1 + j14j21*f2;",
        "        float gn = sqrtf(g0*g0 + g1*g1 + g2*g2 + g3*g3);",
        "        if (gn > 1e-9f) {",
        "            qd0 -= MADGWICK_BETA * g0 / gn; qd1 -= MADGWICK_BETA * g1 / gn;",
        "            qd2 -= MADGWICK_BETA * g2 / gn; qd3 -= MADGWICK_BETA * g3 / gn;",
        "        }",
        "    }",
        "",
        "    float q0n = q0_ + qd0*MADGWICK_DT, q1n = q1_ + qd1*MADGWICK_DT;",
        "    float q2n = q2_ + qd2*MADGWICK_DT, q3n = q3_ + qd3*MADGWICK_DT;",
        "    float qn2 = sqrtf(q0n*q0n + q1n*q1n + q2n*q2n + q3n*q3n);",
        "    q[0] = q0n/qn2; q[1] = q1n/qn2; q[2] = q2n/qn2; q[3] = q3n/qn2;",
        "",
        "    float gbx = 2.0f * (q[1]*q[3] - q[0]*q[2]);",
        "    float gby = 2.0f * (q[0]*q[1] + q[2]*q[3]);",
        "    float gbz = q[0]*q[0] - q[1]*q[1] - q[2]*q[2] + q[3]*q[3];",
        "    return ax*gbx + ay*gby + az*gbz - G_MAG;",
        "}",
    ]
    return "\n".join(lines)


def export_thermal_c(fits: Dict[str, object], t_ref: float, min_r2: float = 0.8) -> str:
    """E4 (PLAN-V2.md §5.7/§8): per-axis bias-vs-temperature correction,
    `x - slope*(T - T_ref)`. Exported only for axes whose fit's R² clears
    `min_r2`; if none do, the snippet is a comment explaining why —
    hypothesis §9.6 expects this to be the common case once C4's per-rest
    re-bias is running.

    `fits` maps axis name -> an object with `.slope` and `.r2` attributes
    (imu.ThermalFit satisfies this; kept duck-typed so this module doesn't
    need to import imu.py)."""
    good = {name: fit for name, fit in fits.items() if fit is not None and fit.r2 >= min_r2}
    if not good:
        return (
            "// Corrección térmica NO exportada (PLAN-V2.md §8, E4): ningún eje alcanzó\n"
            f"// R² >= {min_r2:.2f} en el ajuste bias-vs-temperatura.\n"
            "// Con el re-bias por reposo (C4) alcanza; un modelo térmico en firmware no\n"
            "// aporta sobre esta captura — ver hipótesis 6 de PLAN-V2.md §9."
        )

    lines = [
        f"// Corrección térmica de bias @ T_ref = {t_ref:.3f} °C — PLAN-V2.md §5.7 / §8 (E4)",
        "// x_corregido = x - pendiente * (T_actual - T_REF). Generado por clients/desktop.",
        f"static const float T_REF = {t_ref:.4f}f;",
    ]
    for name in sorted(fits.keys()):
        fit = fits[name]
        if fit is None:
            continue
        note = "" if fit.r2 >= min_r2 else f"  // R²={fit.r2:.3f} < {min_r2:.2f} -- no aplicar"
        lines.append(f"static const float THERMAL_SLOPE_{name.upper()} = {fit.slope:.10f}f;{note}")
    lines += [
        "",
        "static inline float thermal_correct(float x, float slope, float t_now) {",
        "    return x - slope * (t_now - T_REF);",
        "}",
    ]
    return "\n".join(lines)
