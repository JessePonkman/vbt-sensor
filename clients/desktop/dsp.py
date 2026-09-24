# DSP core: uniform-grid reconstruction, the filter bank, integration to
# velocity, stats, and the two tools (PSD, Winter residual analysis) that
# actually pick a cutoff — plus the C exporter that turns that pick into a
# firmware snippet. See PLAN.md §5 for the reasoning behind every choice
# here; this file implements it without re-arguing it.

from __future__ import annotations

import warnings
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np
from scipy import integrate, signal

from protocol import Sample, delta_us

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


@dataclass
class Grid:
    t: np.ndarray  # seconds, starts at 0 at the first kept sample
    ax: np.ndarray
    ay: np.ndarray
    az: np.ndarray
    filled: np.ndarray  # bool — True where the sample was interpolated (a dropped packet)
    fs: float  # estimated sample rate, Hz — from the firmware's own timestamps, not a nominal constant


def to_grid(samples: Sequence[Sample]) -> Optional[Grid]:
    """Reconstructs the uniform grid the firmware actually sampled on.

    The firmware's scheduler (main.cpp: `lastSampleTime += SAMPLE_INTERVAL_US`)
    accumulates rather than reassigning, so it's drift-free by construction —
    every timestamp it emits is an exact multiple of the sample interval
    since boot. The irregular dt a client observes comes entirely from
    packets lost over BLE, and `sequence` counts those losses exactly. So
    `k = sequence - sequence[0]` is the exact index into a grid of spacing
    `1/fs`, and this is what legitimates using fixed-coefficient filters
    (Butterworth, Savitzky-Golay) and Welch/PSD below — see PLAN.md §5.1.
    """
    if len(samples) < 2:
        return None

    seq = np.fromiter((s.sequence for s in samples), dtype=np.int64, count=len(samples))
    ts = np.fromiter((s.timestamp for s in samples), dtype=np.int64, count=len(samples))
    ax = np.fromiter((s.ax for s in samples), dtype=np.float64, count=len(samples))
    ay = np.fromiter((s.ay for s in samples), dtype=np.float64, count=len(samples))
    az = np.fromiter((s.az for s in samples), dtype=np.float64, count=len(samples))

    # Defensive: BLE notifications are ordered and de-duplicated by the OS
    # stack, so a repeated/out-of-order sequence shouldn't happen — but if
    # one ever slips through, keep the first occurrence rather than let the
    # fancy-indexing assignment below silently overwrite it with the second.
    _, first_idx = np.unique(seq, return_index=True)
    if len(first_idx) != len(seq):
        first_idx = np.sort(first_idx)
        seq, ts, ax, ay, az = seq[first_idx], ts[first_idx], ax[first_idx], ay[first_idx], az[first_idx]
    if len(seq) < 2:
        return None

    # dt between consecutive RECEIVED samples, wrap-safe (also what catches
    # a reboot: micros() resets near 0, so the wrap-safe delta comes out
    # huge — same mechanism vbt.ts relies on, see its deltaUs comment).
    dt_us = np.array([delta_us(int(ts[i - 1]), int(ts[i])) for i in range(1, len(ts))], dtype=np.float64)
    dt_s = dt_us / 1e6

    breaks = np.nonzero(dt_s >= DT_MAX_S)[0]  # break i sits between sample i and i+1
    start = int(breaks[-1]) + 1 if len(breaks) > 0 else 0
    seq, ts, ax, ay, az = seq[start:], ts[start:], ax[start:], ay[start:], az[start:]
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
    out_ax = np.empty(n, dtype=np.float64)
    out_ay = np.empty(n, dtype=np.float64)
    out_az = np.empty(n, dtype=np.float64)

    filled[k] = False
    out_ax[k] = ax
    out_ay[k] = ay
    out_az[k] = az

    missing = np.nonzero(filled)[0]
    if len(missing) > 0:
        present = np.nonzero(~filled)[0]
        out_ax[missing] = np.interp(missing, present, out_ax[present])
        out_ay[missing] = np.interp(missing, present, out_ay[present])
        out_az[missing] = np.interp(missing, present, out_az[present])

    return Grid(t=t, ax=out_ax, ay=out_ay, az=out_az, filled=filled, fs=fs)


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


@dataclass
class Calibration:
    bias: np.ndarray  # [bx, by, bz] — the measured rest vector, m/s^2
    g_mag: float


def calibrate(ax: np.ndarray, ay: np.ndarray, az: np.ndarray) -> Optional[Calibration]:
    """vbt.ts's calibrate(), ported — but keeps the full 3-axis bias rather
    than only its magnitude/unit projection, because this tool needs three
    independent per-axis velocities, not one vertical one."""
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
    return Calibration(bias=bias, g_mag=g_mag)


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
