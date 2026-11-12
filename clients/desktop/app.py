# The oscilloscope: PySide6 + pyqtgraph window over dsp.py/ble.py. Five
# tabs (Stream, Accel, Velocity, Stats, Filters) sharing one buffer and one
# active filter selection — see PLAN.md §6 for the layout this implements
# and the reasoning behind the refresh strategy below.

from __future__ import annotations

import csv
import math
import queue
import sys
import time
from collections import deque
from pathlib import Path
from typing import Deque, Dict, List, Optional, Tuple

import numpy as np
import pyqtgraph as pg
from PySide6.QtCore import QObject, Qt, QTimer, Signal
from PySide6.QtGui import QFontDatabase
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

import dsp
import imu
from ble import BleWorker
from protocol import (
    FLAG_ACCEL_CLIPPED,
    FLAG_GYRO_CLIPPED,
    FLAG_IMU_READ_FAILED,
    Sample,
    delta_us,
    describe_flags,
    magnitude,
    to_hex,
)

# PLAN-V2.md §3.4 — the orientation estimator bank. O0 (fixed snapshot) is
# handled entirely by the existing project_vertical path and never touches
# imu.OrientationTracker.
ORIENTATION_ESTIMATORS = [
    ("O0", "O0 — Snapshot fijo (proyección de vbt.ts)"),
    ("O1", "O1 — Solo giro (integración pura)"),
    ("O2", "O2 — Solo acelerómetro (tilt por muestra)"),
    ("O3", "O3 — Complementario (Mahony, Ki=0)"),
    ("O4", "O4 — Mahony (PI, con bias) — default"),
    ("O5", "O5 — Madgwick IMU"),
]

REST_DETECTORS = [
    ("Z1", "Z1 — RMS |a| (vbt.ts)"),
    ("Z2", "Z2 — ARE (energía de giro)"),
    ("Z3", "Z3 — SHOE (acelerómetro + giro)"),
]

BUFFER_MAXLEN = 6000  # 60s at 100Hz — PLAN.md §6
VISIBLE_WINDOW_S = 10.0
TICK_MS = 33  # ~30 FPS
RATE_WINDOW_S = 1.0
SESSIONS_DIR = Path(__file__).parent / "sessions"

_MONO_FONT = None  # lazily grabbed after QApplication exists — see _mono_font()


def _mono_font():
    global _MONO_FONT
    if _MONO_FONT is None:
        _MONO_FONT = QFontDatabase.systemFont(QFontDatabase.SystemFont.FixedFont)
    return _MONO_FONT


# ============================================================
# buffering, recording, replay
# ============================================================


class LiveBuffer:
    """Rolling sample buffer + running link-health counters. Mirrors
    clients/mobile/src/stream.tsx's freshBuffer(): same counters, same gap
    semantics (a sequence rewind means an ESP32 reboot, not loss) — reused
    here for both live streaming and CSV replay (see _load_csv)."""

    def __init__(self, maxlen: Optional[int] = BUFFER_MAXLEN):
        self.samples: Deque[Sample] = deque(maxlen=maxlen)
        self.last_seq: Optional[int] = None
        self.packets = 0
        self.lost = 0
        self.rx_times: Deque[float] = deque(maxlen=4000)
        # v2 health counters, cumulative over the session rather than over
        # the rolling window — a clipped sample 40s ago still invalidates
        # conclusions drawn from the capture.
        self.clipped = 0
        self.imu_failed = 0
        self.tx_dropped = 0

    def add(self, sample: Sample) -> int:
        """Appends the sample and returns how many packets were lost
        immediately before it (0 if none)."""
        gap = 0
        if self.last_seq is not None and sample.sequence > self.last_seq + 1:
            gap = sample.sequence - self.last_seq - 1
            self.lost += gap
        # sample.sequence <= last_seq means the ESP32 rebooted (its counter
        # restarted at 0) — just resync instead of counting it as loss.
        self.last_seq = sample.sequence
        self.packets += 1

        if sample.flags & (FLAG_ACCEL_CLIPPED | FLAG_GYRO_CLIPPED):
            self.clipped += 1
        if sample.flags & FLAG_IMU_READ_FAILED:
            self.imu_failed += 1
        # Each arriving packet reports the drops since the PREVIOUS arrival,
        # so these intervals are disjoint and the plain sum is the true
        # total — no double counting.
        self.tx_dropped += sample.tx_dropped

        self.samples.append(sample)
        self.rx_times.append(sample.rx_at)
        return gap

    def arrival_hz(self, now: float) -> float:
        cutoff = now - RATE_WINDOW_S
        while self.rx_times and self.rx_times[0] < cutoff:
            self.rx_times.popleft()
        return len(self.rx_times) / RATE_WINDOW_S


class SessionRecorder:
    """Writes each sample to CSV as it arrives, flushed immediately — a
    crash mid-session loses at most the in-flight sample, never the whole
    recording (PLAN.md §6)."""

    COLUMNS = ["seq", "t_us", "ax", "ay", "az", "gx", "gy", "gz", "temp_c", "flags", "tx_dropped", "jitter_us", "rx_at_ms"]

    def __init__(self, path: Path):
        self._file = open(path, "w", newline="")
        self._writer = csv.writer(self._file)
        self._writer.writerow(self.COLUMNS)

    def write(self, sample: Sample) -> None:
        self._writer.writerow(
            [
                sample.sequence,
                sample.timestamp,
                sample.ax,
                sample.ay,
                sample.az,
                sample.gx,
                sample.gy,
                sample.gz,
                sample.temp_c,
                sample.flags,
                sample.tx_dropped,
                sample.jitter_us,
                sample.rx_at * 1000.0,
            ]
        )
        self._file.flush()

    def close(self) -> None:
        self._file.close()


def _csv_float(row: Dict[str, str], key: str) -> float:
    value = row.get(key)
    if value is None or value == "":
        return math.nan
    return float(value)


def _csv_int(row: Dict[str, str], key: str) -> int:
    value = row.get(key)
    if value is None or value == "":
        return 0
    return int(float(value))


def _load_csv(path: Path) -> List[Sample]:
    """Reads a session CSV. Columns the file doesn't have come back as NaN
    (or 0 for the counters), so recordings made before the v2 packet still
    open — they just have no gyro, temperature or timing to show."""
    samples = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            samples.append(
                Sample(
                    timestamp=int(row["t_us"]),
                    ax=float(row["ax"]),
                    ay=float(row["ay"]),
                    az=float(row["az"]),
                    sequence=int(row["seq"]),
                    rx_at=float(row["rx_at_ms"]) / 1000.0,
                    raw=b"",
                    gx=_csv_float(row, "gx"),
                    gy=_csv_float(row, "gy"),
                    gz=_csv_float(row, "gz"),
                    temp_c=_csv_float(row, "temp_c"),
                    jitter_us=_csv_float(row, "jitter_us"),
                    flags=_csv_int(row, "flags"),
                    tx_dropped=_csv_int(row, "tx_dropped"),
                )
            )
    return samples


def _find_runs(mask: np.ndarray) -> List[Tuple[int, int]]:
    """Contiguous (start, end-inclusive) index pairs where `mask` is True —
    used to shade interpolated (gap-filled) stretches on the Accel plots."""
    if len(mask) == 0 or not mask.any():
        return []
    edges = np.flatnonzero(np.diff(np.concatenate(([0], mask.astype(np.int8), [0]))))
    starts, ends = edges[0::2], edges[1::2] - 1
    return list(zip(starts.tolist(), ends.tolist()))


class BleSignals(QObject):
    """BleWorker calls `on_state` from its own background thread. Routing
    it through a Qt signal marshals the call back onto the GUI thread
    automatically (Qt auto-queues a cross-thread emit to a slot owned by a
    main-thread object) — nothing here ever touches a widget directly from
    that thread."""

    state_changed = Signal(str, str)


# ============================================================
# main window
# ============================================================


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("VBT Sensor — Desktop Debug")
        self.resize(1320, 880)

        self.ble: Optional[BleWorker] = None
        self.recorder: Optional[SessionRecorder] = None
        self.buf = LiveBuffer()
        self.is_live = True
        self.calib: Optional[dsp.Calibration] = None
        self.ble_state = "disconnected"
        self.status_notice: Optional[str] = None
        self._integrity_warning: Optional[str] = None
        self._current_grid: Optional[dsp.Grid] = None
        self._timing: Optional[dsp.TimingStats] = None
        self._last_stream_ts: Optional[int] = None

        # PLAN-V2.md §4/§6 — orientation fusion state. The tracker is
        # persistent across ticks (recreated only when its config or the
        # calibration changes); `_orient_cache` is what makes advancing it
        # incremental instead of a full O(buffer) pass every 33ms tick —
        # see _advance_orientation().
        self.orientation_tracker: Optional[imu.OrientationTracker] = None
        self._orient_cache: dict = {}  # seq0, quats, accepted, bias, config key
        self.online_bias = imu.OnlineBias()
        self._last_applied_rest_end: int = -1  # C4: last rest interval already folded into the tracker's bias
        self._thermal_fits: Dict[str, imu.ThermalFit] = {}  # per-axis A5/C6 fits, keyed by axis name

        self._ble_signals = BleSignals()
        self._ble_signals.state_changed.connect(self._on_ble_state)

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.addLayout(self._build_toolbar())

        self.tabs = QTabWidget()
        self.tabs.addTab(self._build_stream_tab(), "Stream")
        self.tabs.addTab(self._build_accel_tab(), "Accel")
        self.tabs.addTab(self._build_velocity_tab(), "Velocity")
        self.tabs.addTab(self._build_stats_tab(), "Stats")
        self.tabs.addTab(self._build_filters_tab(), "Filters")
        self.tabs.currentChanged.connect(lambda _idx: self._on_tick())
        root.addWidget(self.tabs)

        self.timer = QTimer(self)
        self.timer.timeout.connect(self._on_tick)
        self.timer.start(TICK_MS)

    def closeEvent(self, event) -> None:
        if self.ble is not None:
            self.ble.stop()
        if self.recorder is not None:
            self.recorder.close()
        super().closeEvent(event)

    # -- toolbar ---------------------------------------------------------

    def _build_toolbar(self) -> QHBoxLayout:
        bar = QHBoxLayout()
        self.connect_btn = QPushButton("Conectar")
        self.connect_btn.clicked.connect(self._on_connect_clicked)
        bar.addWidget(self.connect_btn)

        self.rec_btn = QPushButton("● Rec")
        self.rec_btn.clicked.connect(self._on_rec_clicked)
        bar.addWidget(self.rec_btn)

        open_btn = QPushButton("Abrir…")
        open_btn.clicked.connect(self._on_open_clicked)
        bar.addWidget(open_btn)

        bar.addStretch()

        self.status_label = QLabel("Desconectado")
        self.status_label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        bar.addWidget(self.status_label)
        return bar

    # -- BLE / recording / replay wiring ---------------------------------

    def _on_connect_clicked(self) -> None:
        if self.ble is not None:
            self._disconnect_ble()
            self.status_notice = None
            self._update_status_label()
            return

        self.buf = LiveBuffer()
        self.calib = None
        self.is_live = True
        self._last_stream_ts = None
        self.stream_text.clear()
        self.ble_state = "scanning"
        self.ble = BleWorker(on_state=self._ble_signals.state_changed.emit)
        self.ble.start()
        self.connect_btn.setText("Desconectar")
        self._update_status_label()

    def _disconnect_ble(self) -> None:
        if self.ble is not None:
            self.ble.stop()
            self.ble = None
            self.connect_btn.setText("Conectar")
            self.ble_state = "disconnected"

    def _on_ble_state(self, state: str, detail: str) -> None:
        self.ble_state = state
        if state == "error":
            self.status_notice = detail
        self._update_status_label()

    def _on_rec_clicked(self) -> None:
        if self.recorder is not None:
            self._stop_recording()
            self._update_status_label()
            return
        SESSIONS_DIR.mkdir(exist_ok=True)
        path = SESSIONS_DIR / f"{time.strftime('%Y-%m-%d_%H%M%S')}.csv"
        self.recorder = SessionRecorder(path)
        self.rec_btn.setText("■ Stop")
        self.status_notice = f"Grabando en {path.name}"
        self._update_status_label()

    def _stop_recording(self) -> None:
        if self.recorder is not None:
            self.recorder.close()
            self.recorder = None
            self.rec_btn.setText("● Rec")

    def _on_open_clicked(self) -> None:
        SESSIONS_DIR.mkdir(exist_ok=True)
        path_str, _ = QFileDialog.getOpenFileName(self, "Abrir sesión", str(SESSIONS_DIR), "CSV (*.csv)")
        if not path_str:
            return

        samples = _load_csv(Path(path_str))
        if len(samples) < 2:
            QMessageBox.warning(self, "Abrir sesión", "El archivo no tiene muestras suficientes.")
            return

        self._disconnect_ble()
        self._stop_recording()

        self.buf = LiveBuffer(maxlen=None)  # full file, not truncated to the live 60s window
        self.calib = None
        self.is_live = False
        self._last_stream_ts = None
        self.stream_text.clear()
        for s in samples:
            gap = self.buf.add(s)
            if gap > 0:
                self._append_stream_line(f"── {gap} paquetes perdidos tras seq {s.sequence - gap - 1} ──")
            self._append_stream_line(self._format_stream_line(s))

        self.status_notice = f"Cargado: {Path(path_str).name} ({len(samples)} muestras)"
        self._on_tick()

    # -- per-tick refresh --------------------------------------------------

    def _drain_queue(self) -> None:
        if self.ble is None:
            return
        for _ in range(2000):  # guard: never let one tick's drain loop run unbounded
            try:
                sample = self.ble.queue.get_nowait()
            except queue.Empty:
                break
            gap = self.buf.add(sample)
            if self.recorder is not None:
                self.recorder.write(sample)
            if gap > 0:
                self._append_stream_line(f"── {gap} paquetes perdidos tras seq {sample.sequence - gap - 1} ──")
            self._append_stream_line(self._format_stream_line(sample))

    def _on_tick(self) -> None:
        self._drain_queue()

        self._current_grid = dsp.to_grid(list(self.buf.samples)) if len(self.buf.samples) >= 2 else None
        self._timing = dsp.timing_stats(self._current_grid) if self._current_grid is not None else None

        if self._current_grid is not None and len(self._current_grid.filled) > 0:
            frac = float(np.mean(self._current_grid.filled))
            self._integrity_warning = (
                f"⚠ {frac*100:.1f}% de las muestras son interpoladas (huecos de BLE) — cuidado con conclusiones de filtro"
                if frac > 0.05
                else None
            )
        else:
            self._integrity_warning = None

        self._update_status_label()

        idx = self.tabs.currentIndex()
        if idx == 1:
            self._refresh_accel()
        elif idx == 2:
            self._refresh_velocity()
        elif idx == 3:
            self._refresh_stats()
        elif idx == 4:
            self._refresh_filters()

    def _update_status_label(self) -> None:
        if self.ble is not None:
            conn = {"scanning": "buscando…", "connected": "conectado", "error": "error"}.get(self.ble_state, self.ble_state)
            rssi = f"RSSI {self.ble.rssi}" if self.ble.rssi is not None else "RSSI ?"
            line1 = f"VBT-ESP32 · {conn} · {rssi}"
        elif not self.is_live and len(self.buf.samples) > 0:
            line1 = "Reproduciendo grabación (sin BLE)"
        else:
            line1 = "Desconectado"

        fw_hz = self._current_grid.fs if self._current_grid is not None else 0.0
        total = self.buf.packets + self.buf.lost
        pct_lost = 100.0 * self.buf.lost / max(1, total)

        if self.is_live:
            arrival_hz = self.buf.arrival_hz(time.monotonic())
            malformed = self.ble.malformed if self.ble is not None else 0
            line2 = (
                f"{fw_hz:.1f} Hz firmware · {arrival_hz:.1f} Hz llegada · {self.buf.packets} pkts · "
                f"{self.buf.lost} perdidos ({pct_lost:.2f}%) · {malformed} malformados"
            )
        else:
            line2 = f"{fw_hz:.1f} Hz firmware · {self.buf.packets} pkts · {self.buf.lost} perdidos ({pct_lost:.2f}%)"

        # Timing. The spread, not the median, is what says whether the
        # uniform grid holds — see dsp.timing_stats.
        if self._timing is not None and self._timing.n > 0:
            line2 += f" · jitter p95 {self._timing.p95_abs_us:.0f} µs (spread {self._timing.spread_us:.0f})"
            if self._timing.resync_count:
                line2 += f" · {self._timing.resync_count} resync"

        # Health counters, shown only when non-zero: in a clean session all
        # three stay at 0 and there is nothing worth the screen space.
        health = []
        if self.buf.clipped:
            health.append(f"{self.buf.clipped} clip")
        if self.buf.imu_failed:
            health.append(f"{self.buf.imu_failed} fallo I²C")
        if self.buf.tx_dropped:
            health.append(f"{self.buf.tx_dropped} descartados en el ESP32")
        if health:
            line2 += " · ⚠ " + " · ".join(health)

        # PLAN-V2.md §7 — current temperature and drift from the
        # calibration temperature (C5b): the guard the same section
        # requires, so a stale calibration is visible without opening
        # the Sensor tab.
        if self._current_grid is not None and dsp.gyro_available(self._current_grid):
            t_now = self._current_grid.temp_c[-1]
            if np.isfinite(t_now):
                line2 += f" · T={t_now:.1f}°C"
                if self.calib is not None and np.isfinite(self.calib.temp_c):
                    dT = t_now - self.calib.temp_c
                    if abs(dT) > 2.0:
                        line2 += f" ⚠ ΔT={dT:+.1f}°C desde calibración"

        if self.status_notice:
            line2 += f"   [{self.status_notice}]"
        if self._integrity_warning:
            line2 += f"   {self._integrity_warning}"

        self.status_label.setText(f"{line1}\n{line2}")

    def _current_filter_id(self) -> str:
        return self.filter_combo.currentData()

    def _current_filter_params(self) -> dict:
        return {name: box.value() for name, box in self.filter_param_widgets.items()}

    def _visible_slice(self, fs: float, n: int) -> slice:
        n_visible = min(n, int(VISIBLE_WINDOW_S * fs) + 1)
        return slice(-n_visible, None)

    # -- tab 1: Stream ------------------------------------------------------

    def _build_stream_tab(self) -> QWidget:
        w = QWidget()
        layout = QVBoxLayout(w)

        top = QHBoxLayout()
        self.hex_check = QCheckBox("Mostrar hex")
        top.addWidget(self.hex_check)
        top.addStretch()
        layout.addLayout(top)

        self.stream_text = QPlainTextEdit()
        self.stream_text.setReadOnly(True)
        self.stream_text.setMaximumBlockCount(500)  # self-pruning — PLAN.md §6
        self.stream_text.setFont(_mono_font())
        layout.addWidget(self.stream_text)
        return w

    def _format_stream_line(self, sample: Sample) -> str:
        dt_ms = None
        if self._last_stream_ts is not None:
            dt_ms = delta_us(self._last_stream_ts, sample.timestamp) / 1000.0
        self._last_stream_ts = sample.timestamp
        a = magnitude(sample.ax, sample.ay, sample.az)
        dt_str = f"{dt_ms:5.1f}" if dt_ms is not None else " --- "
        line = (
            f"{sample.sequence:>8d}  dt={dt_str}ms  "
            f"ax={sample.ax:>7.3f} ay={sample.ay:>7.3f} az={sample.az:>7.3f}  |a|={a:>6.3f}"
        )
        if not math.isnan(sample.gx):
            line += f"  gx={sample.gx:>7.3f} gy={sample.gy:>7.3f} gz={sample.gz:>7.3f}  T={sample.temp_c:>5.1f}°C"
        # This is the tab where an I2C glitch or a railed sample is meant to
        # be caught (PLAN.md §8.4), so the flags go inline rather than in a
        # counter somewhere else.
        marks = describe_flags(sample.flags)
        if marks:
            line += f"  ⚠[{marks}]"
        if self.hex_check.isChecked() and sample.raw:
            line += f"  [{to_hex(sample.raw)}]"
        return line

    def _append_stream_line(self, line: str) -> None:
        self.stream_text.appendPlainText(line)

    # -- tab 2: Accel ---------------------------------------------------------

    # The gyro panels sit on the same tab and the same X axis as accel:
    # the point of having them is reading them against each other.
    ACCEL_TAB_AXES = (
        ("ax", "Aceleración X (m/s²)"),
        ("ay", "Aceleración Y (m/s²)"),
        ("az", "Aceleración Z (m/s²)"),
        ("gx", "Giro X (rad/s)"),
        ("gy", "Giro Y (rad/s)"),
        ("gz", "Giro Z (rad/s)"),
    )
    N_ACCEL_AXES = 3

    def _build_accel_tab(self) -> QWidget:
        w = QWidget()
        layout = QVBoxLayout(w)

        top = QHBoxLayout()
        self.gyro_check = QCheckBox("Mostrar giroscopio")
        self.gyro_check.toggled.connect(self._on_gyro_toggled)
        top.addWidget(self.gyro_check)
        top.addStretch()
        layout.addLayout(top)

        self.accel_plots: List[pg.PlotWidget] = []
        self.accel_raw_curves = []
        self.accel_filt_curves = []
        self.accel_regions: List[list] = []

        for _key, label in self.ACCEL_TAB_AXES:
            plot = pg.PlotWidget()
            plot.setLabel("left", label)
            plot.setLabel("bottom", "t (s)")
            plot.showGrid(x=True, y=True, alpha=0.2)
            if self.accel_plots:
                plot.setXLink(self.accel_plots[0])
            raw_curve = plot.plot([], [], pen=pg.mkPen((130, 130, 130), width=1))
            filt_curve = plot.plot([], [], pen=pg.mkPen((0, 200, 255), width=2))
            self.accel_plots.append(plot)
            self.accel_raw_curves.append(raw_curve)
            self.accel_filt_curves.append(filt_curve)
            self.accel_regions.append([])
            layout.addWidget(plot)

        self._on_gyro_toggled(False)
        return w

    def _on_gyro_toggled(self, checked: bool) -> None:
        for plot in self.accel_plots[self.N_ACCEL_AXES :]:
            plot.setVisible(checked)

    def _refresh_accel(self) -> None:
        grid = self._current_grid
        if grid is None:
            return
        filter_id = self._current_filter_id()
        params = self._current_filter_params()
        fs = grid.fs
        sl = self._visible_slice(fs, len(grid.t))

        has_gyro = dsp.gyro_available(grid)
        self.gyro_check.setEnabled(has_gyro)
        self.gyro_check.setToolTip("" if has_gyro else "Esta captura no trae giroscopio (paquete v1)")
        show_gyro = has_gyro and self.gyro_check.isChecked()
        self._on_gyro_toggled(show_gyro)

        n_axes = len(self.ACCEL_TAB_AXES) if show_gyro else self.N_ACCEL_AXES
        for axis_key, plot, raw_curve, filt_curve, regions in zip(
            (key for key, _label in self.ACCEL_TAB_AXES[:n_axes]),
            self.accel_plots,
            self.accel_raw_curves,
            self.accel_filt_curves,
            self.accel_regions,
        ):
            raw = getattr(grid, axis_key)
            # Filter the FULL buffer, slice only for display — the IIR's
            # startup transient lands off-screen instead of on the left
            # edge (PLAN.md §6).
            filt = dsp.apply_filter(filter_id, raw, fs, **params)

            raw_curve.setData(grid.t[sl], raw[sl])
            filt_curve.setData(grid.t[sl], filt[sl])

            for item in regions:
                plot.removeItem(item)
            regions.clear()
            t_vis, filled_vis = grid.t[sl], grid.filled[sl]
            for start, end in _find_runs(filled_vis):
                region = pg.LinearRegionItem(values=(t_vis[start], t_vis[end]), movable=False, brush=pg.mkBrush(255, 150, 0, 60))
                region.setZValue(-10)
                plot.addItem(region)
                regions.append(region)

    # -- tab 3: Velocity ---------------------------------------------------

    def _build_velocity_tab(self) -> QWidget:
        w = QWidget()
        outer = QHBoxLayout(w)

        plots_col = QVBoxLayout()
        self.velocity_plots: List[pg.PlotWidget] = []
        self.velocity_curves = []
        for label in ["Vx (m/s)", "Vy (m/s)", "Vz (m/s)"]:
            plot = pg.PlotWidget()
            plot.setLabel("left", label)
            plot.setLabel("bottom", "t (s)")
            plot.showGrid(x=True, y=True, alpha=0.2)
            if self.velocity_plots:
                plot.setXLink(self.velocity_plots[0])
            curve = plot.plot([], [], pen=pg.mkPen((0, 220, 120), width=2))
            self.velocity_plots.append(plot)
            self.velocity_curves.append(curve)
            plots_col.addWidget(plot)

        # V vertical carries TWO curves (PLAN-V2.md §7): the fixed-snapshot
        # projection (grey, always the vbt.ts-comparable number) and the
        # dynamic orientation-based one (color) — the contrast between them
        # IS the demonstration of §4.3's gravity leak (PLAN-V2.md §12.2).
        vvert_plot = pg.PlotWidget()
        vvert_plot.setLabel("left", "V vertical (m/s)")
        vvert_plot.setLabel("bottom", "t (s)")
        vvert_plot.showGrid(x=True, y=True, alpha=0.2)
        vvert_plot.setXLink(self.velocity_plots[0])
        self.v_vert_fixed_curve = vvert_plot.plot([], [], pen=pg.mkPen((150, 150, 150), width=2), name="fija (O0)")
        self.v_vert_dynamic_curve = vvert_plot.plot([], [], pen=pg.mkPen((0, 220, 120), width=2), name="dinámica")
        vvert_plot.addLegend()
        self.velocity_plots.append(vvert_plot)
        self.velocity_curves.append(self.v_vert_fixed_curve)  # kept for _visible_slice-style code that expects 4 entries
        plots_col.addWidget(vvert_plot)

        self.v_leak_label = QLabel("")
        self.v_leak_label.setWordWrap(True)
        plots_col.addWidget(self.v_leak_label)
        outer.addLayout(plots_col, stretch=4)

        side = QVBoxLayout()
        self.calib_button = QPushButton("Capturar reposo (1 s)")
        self.calib_button.clicked.connect(self._on_capture_rest)
        side.addWidget(self.calib_button)
        self.calib_label = QLabel("Sin calibrar")
        self.calib_label.setWordWrap(True)
        side.addWidget(self.calib_label)

        self.gravity_check = QCheckBox("Quitar bias de gravedad")
        self.gravity_check.setChecked(True)
        side.addWidget(self.gravity_check)

        side.addWidget(QLabel("Fuente de V vertical:"))
        self.vvert_source_combo = QComboBox()
        self.vvert_source_combo.addItem("Proyección fija (O0, vbt.ts)", "fixed")
        self.vvert_source_combo.addItem("Orientación dinámica (pestaña Orientation)", "dynamic")
        side.addWidget(self.vvert_source_combo)

        side.addWidget(QLabel("Corrección de drift:"))
        self.drift_combo = QComboBox()
        self.drift_combo.addItem("Detrend (lineal)", "detrend")
        self.drift_combo.addItem("Detrend por segmentos (I4)", "segments")
        self.drift_combo.addItem("High-pass 0.3 Hz", "highpass")
        self.drift_combo.addItem("Ninguno", "none")
        side.addWidget(self.drift_combo)

        side.addWidget(QLabel("Detector de reposo (ZUPT / I4 / C4 / O6):"))
        self.rest_detector_combo = QComboBox()
        for det_id, label in REST_DETECTORS:
            self.rest_detector_combo.addItem(label, det_id)
        side.addWidget(self.rest_detector_combo)

        self.zupt_check = QCheckBox("ZUPT (zero-velocity update)")
        side.addWidget(self.zupt_check)

        self.raw_integration_check = QCheckBox("Integración cruda (sin correcciones)")
        side.addWidget(self.raw_integration_check)

        side.addWidget(QLabel("Brazo de palanca (G5, PLAN-V2.md §5.9):"))
        self.lever_arm_check = QCheckBox("Compensar brazo de palanca")
        side.addWidget(self.lever_arm_check)
        lever_form = QFormLayout()
        self.lever_r_spins = {}
        for axis in ("rx", "ry", "rz"):
            box = QDoubleSpinBox()
            box.setRange(-200.0, 200.0)
            box.setSingleStep(1.0)
            box.setSuffix(" mm")
            self.lever_r_spins[axis] = box
            lever_form.addRow(f"{axis} (sensor→eje)", box)
        side.addLayout(lever_form)
        self.lever_rms_label = QLabel("")
        self.lever_rms_label.setWordWrap(True)
        side.addWidget(self.lever_rms_label)

        side.addStretch()
        outer.addLayout(side, stretch=1)
        return w

    def _on_capture_rest(self) -> None:
        grid = self._current_grid
        if grid is None:
            return
        n = max(1, int(round(1.0 * grid.fs)))  # trailing 1s, matching vbt.ts's CALIB_MS
        calib = dsp.calibrate(
            grid.ax[-n:], grid.ay[-n:], grid.az[-n:], grid.gx[-n:], grid.gy[-n:], grid.gz[-n:], grid.temp_c[-n:]
        )
        if calib is None:
            self.calib_label.setText(
                "Calibración rechazada: no estaba quieto (accel o giro), o |g| fuera de rango."
            )
            return
        self.calib = calib
        # Re-seed the orientation tracker from the same rest vector that
        # calibrates project_vertical (PLAN-V2.md §5.2 C3) so O0 and the
        # dynamic estimators agree exactly while the barbell hasn't tilted.
        self.orientation_tracker = None
        self._orient_cache = {}
        self.online_bias = imu.OnlineBias()
        self._last_applied_rest_end = -1

        label = f"Calibrado: bias=({calib.bias[0]:.3f}, {calib.bias[1]:.3f}, {calib.bias[2]:.3f}) m/s²  |g|={calib.g_mag:.3f}"
        if np.all(np.isfinite(calib.gyro_bias)):
            label += (
                f"\nGiro bias=({math.degrees(calib.gyro_bias[0]):.2f}, {math.degrees(calib.gyro_bias[1]):.2f}, "
                f"{math.degrees(calib.gyro_bias[2]):.2f}) °/s  σa={calib.sigma_a:.3f} m/s²  σg={math.degrees(calib.sigma_g):.3f} °/s"
            )
            if np.isfinite(calib.temp_c):
                label += f"  T_cal={calib.temp_c:.1f}°C"
        self.calib_label.setText(label)

    def _apply_drift_correction(
        self, t: np.ndarray, v: np.ndarray, a_used: np.ndarray, fs: float, rest_intervals: Optional[List[Tuple[int, int]]] = None
    ) -> np.ndarray:
        mode = self.drift_combo.currentData()
        if mode == "detrend":
            v, _bias = dsp.detrend_linear(t, v)
        elif mode == "segments" and rest_intervals is not None:
            # I4 (PLAN-V2.md §5.5): needs the rest intervals up front, so
            # this branch is skipped (falls through to no correction) if
            # the caller couldn't compute them (no gyro, no calibration).
            v = dsp.detrend_segments(t, v, rest_intervals)
        elif mode == "highpass":
            v = dsp.apply_butter_hp(v, fs, fc=0.3, order=1)
        if self.zupt_check.isChecked():
            if rest_intervals is not None:
                mask = np.zeros(len(v), dtype=bool)
                for s, e in rest_intervals:
                    mask[s : e + 1] = True
                v = dsp.apply_zupt_mask(v, mask)
            else:
                v = dsp.apply_zupt(v, a_used, fs)
        return v

    # -- orientation fusion: shared by Velocity, Orientation and Filters --

    def _orientation_config_key(self) -> tuple:
        return (
            self.orientation_estimator_combo.currentData(),
            round(self.orientation_kp_spin.value(), 4),
            round(self.orientation_ki_spin.value(), 4),
            round(self.orientation_beta_spin.value(), 4),
            self.orientation_reject_check.isChecked(),
            round(self.orientation_tol_mag_spin.value(), 3),
            round(self.orientation_tol_ang_spin.value(), 2),
            id(self.calib),
        )

    def _compute_rest_mask(self, grid: dsp.Grid, a_for_rms: np.ndarray) -> np.ndarray:
        """The rest mask feeding ZUPT/I4/C4/O6, per PLAN-V2.md §5.5's
        selector. Z1 is Z1's own dsp helper; Z2/Z3 need per-sensor noise
        (sigma_a/sigma_g), preferring the values measured at "Capturar
        reposo" over a same-capture fallback so a short/noisy visible
        window doesn't distort the very calibration it's meant to use."""
        detector = self.rest_detector_combo.currentData()
        if detector == "Z1" or not dsp.gyro_available(grid):
            return dsp.rolling_rms_rest_mask(a_for_rms, grid.fs)

        sigma_a = self.calib.sigma_a if self.calib is not None and np.isfinite(self.calib.sigma_a) else float(np.nanstd(a_for_rms))
        sigma_g = (
            self.calib.sigma_g
            if self.calib is not None and np.isfinite(self.calib.sigma_g)
            else float(np.nanstd(grid.gx))
        )
        sigma_a = sigma_a if sigma_a > 1e-6 else 0.02
        sigma_g = sigma_g if sigma_g > 1e-6 else 0.01
        gyr = np.stack([grid.gx, grid.gy, grid.gz], axis=1)
        if detector == "Z2":
            stat = imu.are(gyr, grid.fs, sigma_g)
        else:  # Z3
            acc = np.stack([grid.ax, grid.ay, grid.az], axis=1)
            g_mag = self.calib.g_mag if self.calib is not None else 9.81
            stat = imu.shoe(acc, gyr, grid.fs, sigma_a, sigma_g, g_mag)
        return imu.rest_mask_from_statistic(stat)

    def _rest_intervals(self, grid: dsp.Grid, a_for_rms: np.ndarray) -> List[Tuple[int, int]]:
        mask = self._compute_rest_mask(grid, a_for_rms)
        return imu.find_rest_intervals(mask, grid.fs)

    def _advance_orientation(self, grid: dsp.Grid) -> Optional[Tuple[np.ndarray, np.ndarray, np.ndarray]]:
        """Advances (or recreates) the persistent OrientationTracker and
        returns (quats, accepted, bias) aligned 1:1 with `grid`. Caches by
        `grid.seq0` rather than array position, since LiveBuffer's
        deque(maxlen=...) evicts from the front and to_grid rebuilds from
        scratch every tick (PLAN-V2.md §6) -- see Grid.seq0's docstring."""
        if not dsp.gyro_available(grid) or self.calib is None:
            return None

        n = len(grid.t)
        dt = 1.0 / grid.fs
        key = self._orientation_config_key()

        if self.orientation_tracker is None or self._orient_cache.get("key") != key:
            estimator, kp, ki, beta, reject, tol_mag, tol_ang, _calib_id = key
            q0 = imu.tilt_quat(*self.calib.bias)
            self.orientation_tracker = imu.OrientationTracker(
                estimator=estimator, q0=q0, kp=kp, ki=ki, beta=beta, g_ref=self.calib.g_mag,
                reject=reject, tol_mag=tol_mag, tol_ang_deg=tol_ang,
            )
            self._orient_cache = {
                "key": key, "seq0": None,
                "quats": np.empty((0, 4)), "accepted": np.empty((0,), dtype=bool), "bias": np.empty((0, 3)),
            }
            self._last_applied_rest_end = -1
            self.online_bias = imu.OnlineBias()

        cache = self._orient_cache
        prev_seq0 = cache["seq0"]
        prev_quats, prev_accepted, prev_bias = cache["quats"], cache["accepted"], cache["bias"]

        prefix_len = 0
        if prev_seq0 is not None:
            offset = grid.seq0 - prev_seq0
            if 0 <= offset <= len(prev_quats):
                prefix_len = len(prev_quats) - offset
            else:
                # A segment cut/reboot/non-monotonic jump broke the overlap
                # assumption -- restart at the calibration's orientation
                # rather than propagate state across a discontinuity.
                self.orientation_tracker.reset()

        quats_prefix = prev_quats[len(prev_quats) - prefix_len :] if prefix_len else np.empty((0, 4))
        accepted_prefix = prev_accepted[len(prev_accepted) - prefix_len :] if prefix_len else np.empty((0,), dtype=bool)
        bias_prefix = prev_bias[len(prev_bias) - prefix_len :] if prefix_len else np.empty((0, 3))

        start = len(quats_prefix)
        if start < n:
            new_q, new_acc, new_bias = self.orientation_tracker.process_new(
                grid.gx[start:], grid.gy[start:], grid.gz[start:], grid.ax[start:], grid.ay[start:], grid.az[start:], dt
            )
        else:
            new_q, new_acc, new_bias = np.empty((0, 4)), np.empty((0,), dtype=bool), np.empty((0, 3))

        quats = np.concatenate([quats_prefix, new_q], axis=0)
        accepted = np.concatenate([accepted_prefix, new_acc], axis=0)
        bias = np.concatenate([bias_prefix, new_bias], axis=0)

        # C4: fold a freshly completed rest interval's gyro bias/tilt into
        # the tracker so it applies starting next tick (tick-granularity
        # approximation of "right when the rest ends" -- fine since rests
        # last seconds and ticks are 33ms).
        if self.online_bias_check.isChecked() and len(quats) == n and self.orientation_estimator_combo.currentData() in ("O3", "O4"):
            a_vert_fixed = dsp.project_vertical(grid.ax, grid.ay, grid.az, self.calib)
            rest_intervals = self._rest_intervals(grid, a_vert_fixed)
            new_intervals = [iv for iv in rest_intervals if iv[1] > self._last_applied_rest_end]
            if new_intervals:
                gyr = np.stack([grid.gx, grid.gy, grid.gz], axis=1)
                acc = np.stack([grid.ax, grid.ay, grid.az], axis=1)
                for end_idx, bias_est, _q_anchor in self.online_bias.update(gyr, acc, new_intervals):
                    self.orientation_tracker.set_gyro_bias(*bias_est)
                    self._last_applied_rest_end = end_idx

        cache.update(seq0=grid.seq0, quats=quats, accepted=accepted, bias=bias)
        if len(quats) != n:
            return None
        return quats, accepted, bias

    def _lever_arm_compensated(self, grid: dsp.Grid) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        """G5: applies the checkbox's r-vector compensation if enabled and
        gyro is available; otherwise returns the raw axes unchanged."""
        if not self.lever_arm_check.isChecked() or not dsp.gyro_available(grid):
            return grid.ax, grid.ay, grid.az
        r = tuple(self.lever_r_spins[k].value() / 1000.0 for k in ("rx", "ry", "rz"))  # mm -> m
        gyr = np.stack([grid.gx, grid.gy, grid.gz], axis=1)
        alpha = imu.angular_acceleration(gyr, grid.fs)
        acc = np.stack([grid.ax, grid.ay, grid.az], axis=1)
        compensated = imu.lever_arm_correction(acc, gyr, alpha, r)
        return compensated[:, 0], compensated[:, 1], compensated[:, 2]

    def _refresh_velocity(self) -> None:
        grid = self._current_grid
        if grid is None:
            return
        filter_id = self._current_filter_id()
        params = self._current_filter_params()
        fs = grid.fs
        raw_mode = self.raw_integration_check.isChecked()
        sl = self._visible_slice(fs, len(grid.t))

        ax, ay, az = self._lever_arm_compensated(grid)
        if dsp.gyro_available(grid):
            gyr = np.stack([grid.gx, grid.gy, grid.gz], axis=1)
            r = tuple(self.lever_r_spins[k].value() / 1000.0 for k in ("rx", "ry", "rz"))
            lever_rms = imu.lever_arm_rms(gyr, r)
            note = "" if lever_rms > 0.05 else "  (por debajo de 0.05 m/s² — probablemente no vale la pena)"
            self.lever_rms_label.setText(f"RMS de ω×(ω×r): {lever_rms:.3f} m/s²{note}")
        else:
            self.lever_rms_label.setText("")

        raw_axes = {"ax": ax, "ay": ay, "az": az}
        rest_intervals = None
        if self.calib is not None:
            a_vert_for_rest = dsp.project_vertical(ax, ay, az, self.calib)
            rest_intervals = self._rest_intervals(grid, a_vert_for_rest)

        for curve, axis_key, bias_idx in zip(self.velocity_curves[:3], ("ax", "ay", "az"), (0, 1, 2)):
            a_filt = dsp.apply_filter(filter_id, raw_axes[axis_key], fs, **params)
            if not raw_mode and self.gravity_check.isChecked() and self.calib is not None:
                a_used = a_filt - self.calib.bias[bias_idx]
            else:
                a_used = a_filt
            v = dsp.integrate_velocity(a_used, grid.t)
            if not raw_mode:
                v = self._apply_drift_correction(grid.t, v, a_used, fs, rest_intervals)
            curve.setData(grid.t[sl], v[sl])

        if self.calib is None:
            self.v_vert_fixed_curve.setData([], [])
            self.v_vert_dynamic_curve.setData([], [])
            self.v_leak_label.setText("")
            return

        # Fixed (O0): a . g_hat0 - |g| is linear, so filtering this scalar
        # projection equals projecting the filtered vector, at a third of
        # the arithmetic (vbt.ts:716's own reasoning, reused as-is).
        a_vert_fixed = dsp.project_vertical(ax, ay, az, self.calib)
        a_vert_fixed_filt = dsp.apply_filter(filter_id, a_vert_fixed, fs, **params)
        v_vert_fixed = dsp.integrate_velocity(a_vert_fixed_filt, grid.t)
        if not raw_mode:
            v_vert_fixed = self._apply_drift_correction(grid.t, v_vert_fixed, a_vert_fixed_filt, fs, rest_intervals)
        self.v_vert_fixed_curve.setData(grid.t[sl], v_vert_fixed[sl])

        orient = self._advance_orientation(grid)
        source = self.vvert_source_combo.currentData()
        if orient is None or source != "dynamic":
            self.v_vert_dynamic_curve.setData([], [])
            self.v_leak_label.setText("Fuente dinámica no disponible: sin giroscopio o sin calibración." if orient is None else "")
            return

        quats, _accepted, _bias = orient
        gb = imu.gravity_body_array(quats)
        a_vert_dyn = imu.vertical_world(ax, ay, az, gb, self.calib.g_mag)
        a_vert_dyn_filt = dsp.apply_filter(filter_id, a_vert_dyn, fs, **params)
        v_vert_dyn = dsp.integrate_velocity(a_vert_dyn_filt, grid.t)
        if not raw_mode:
            v_vert_dyn = self._apply_drift_correction(grid.t, v_vert_dyn, a_vert_dyn_filt, fs, rest_intervals)
        self.v_vert_dynamic_curve.setData(grid.t[sl], v_vert_dyn[sl])

        # G3 — the gravity leak, over the visible window (PLAN-V2.md §5.4).
        v_leak = v_vert_fixed[sl] - v_vert_dyn[sl] if not raw_mode else None
        if v_leak is not None and len(v_leak):
            self.v_leak_label.setText(f"Fuga de gravedad (v_leak) al final de la ventana: {v_leak[-1]:+.3f} m/s")
        else:
            self.v_leak_label.setText("")

    # -- tab 4: Stats -----------------------------------------------------

    STAT_FIELDS = ("max", "min", "mean", "median", "std", "rms", "peak_to_peak")
    STAT_LABELS = ("Max", "Min", "Media", "Mediana", "Std", "RMS", "P2P")
    STAT_ROWS = ("X", "Y", "Z", "|a|", "gX", "gY", "gZ", "|ω|", "a_vert (mundo)", "θ inclinación (°)", "|a_h| (mundo)")

    def _build_stats_tab(self) -> QWidget:
        w = QWidget()
        layout = QVBoxLayout(w)

        top = QHBoxLayout()
        top.addWidget(QLabel("Ámbito:"))
        self.stats_scope_combo = QComboBox()
        self.stats_scope_combo.addItem("Ventana visible", "visible")
        self.stats_scope_combo.addItem("Grabación completa", "full")
        top.addWidget(self.stats_scope_combo)
        top.addStretch()
        self.stats_clip_label = QLabel("")
        top.addWidget(self.stats_clip_label)
        layout.addLayout(top)

        columns = []
        for label in self.STAT_LABELS:
            columns += [f"{label} (crudo)", f"{label} (filtrado)"]

        self.stats_table = QTableWidget()
        self.stats_table.setColumnCount(len(columns))
        self.stats_table.setHorizontalHeaderLabels(columns)
        self.stats_table.setRowCount(len(self.STAT_ROWS))
        self.stats_table.setVerticalHeaderLabels(list(self.STAT_ROWS))
        self.stats_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        layout.addWidget(self.stats_table)
        return w

    def _refresh_stats(self) -> None:
        grid = self._current_grid
        if grid is None:
            return
        filter_id = self._current_filter_id()
        params = self._current_filter_params()
        fs = grid.fs
        sl = self._visible_slice(fs, len(grid.t)) if self.stats_scope_combo.currentData() == "visible" else slice(None)

        def triple(keys: Tuple[str, str, str]) -> List[Tuple[np.ndarray, np.ndarray]]:
            raw = [getattr(grid, k)[sl] for k in keys]
            filt = [dsp.apply_filter(filter_id, getattr(grid, k), fs, **params)[sl] for k in keys]
            return list(zip(raw, filt)) + [(magnitude(*raw), magnitude(*filt))]

        clipped_in_scope = int(np.count_nonzero(grid.flags[sl] & (FLAG_ACCEL_CLIPPED | FLAG_GYRO_CLIPPED)))
        self.stats_clip_label.setText(f"{clipped_in_scope} muestras clippeadas en el ámbito" if clipped_in_scope else "")

        rows = triple(("ax", "ay", "az"))
        if dsp.gyro_available(grid):
            rows += triple(("gx", "gy", "gz"))

            # PLAN-V2.md §7 — a_vert(mundo)/θ/|a_h| rows, only once
            # orientation is actually available (calibrated + gyro).
            if self.calib is not None:
                orient = self._advance_orientation(grid)
                if orient is not None:
                    quats, _accepted, _bias = orient
                    q0 = imu.tilt_quat(*self.calib.bias)
                    gb = imu.gravity_body_array(quats)
                    a_vert_dyn = imu.vertical_world(grid.ax, grid.ay, grid.az, gb, self.calib.g_mag)
                    theta = np.array([imu.tilt_angle(tuple(q), q0) for q in quats])
                    a_h = imu.horizontal_world_mag(grid.ax, grid.ay, grid.az, quats, self.calib.g_mag)

                    a_vert_filt = dsp.apply_filter(filter_id, a_vert_dyn, fs, **params)
                    theta_filt = dsp.apply_filter(filter_id, theta, fs, **params)
                    a_h_filt = dsp.apply_filter(filter_id, a_h, fs, **params)
                    rows += [
                        (a_vert_dyn[sl], a_vert_filt[sl]),
                        (theta[sl], theta_filt[sl]),
                        (a_h[sl], a_h_filt[sl]),
                    ]

        for row_idx in range(len(self.STAT_ROWS)):
            if row_idx >= len(rows):
                # v1 capture: no gyro to report. An em dash rather than
                # zeros or NaN, which both read as measurements.
                for col in range(self.stats_table.columnCount()):
                    self.stats_table.setItem(row_idx, col, QTableWidgetItem("—"))
                continue
            raw_x, filt_x = rows[row_idx]
            raw_stats = dsp.axis_stats(raw_x)
            filt_stats = dsp.axis_stats(filt_x)
            col = 0
            for field in self.STAT_FIELDS:
                self.stats_table.setItem(row_idx, col, QTableWidgetItem(f"{getattr(raw_stats, field):.4f}"))
                col += 1
                self.stats_table.setItem(row_idx, col, QTableWidgetItem(f"{getattr(filt_stats, field):.4f}"))
                col += 1

    # -- tab 5: Filters (signal filter + orientation + sensor/thermal) --------

    def _build_filters_tab(self) -> QWidget:
        w = QWidget()
        outer = QHBoxLayout(w)

        # Everything that used to be spread across Filters/Orientation/Sensor
        # tabs lives here now, as stacked sections in one scrollable side
        # panel — so you can combine a signal filter with an orientation
        # estimator and a thermal correction without switching tabs.
        side_content = QWidget()
        side = QVBoxLayout(side_content)
        side.addWidget(self._build_signal_filter_group())
        side.addWidget(self._build_orientation_group())
        side.addWidget(self._build_sensor_group())
        side.addStretch()

        side_scroll = QScrollArea()
        side_scroll.setWidgetResizable(True)
        side_scroll.setWidget(side_content)
        side_scroll.setMinimumWidth(340)
        outer.addWidget(side_scroll, stretch=1)

        plots_content = QWidget()
        plots_col = QVBoxLayout(plots_content)
        self.psd_plot = pg.PlotWidget()
        self.psd_plot.setLogMode(x=True, y=True)
        self.psd_plot.setLabel("left", "PSD (m²s⁻⁴/Hz)")
        self.psd_plot.setLabel("bottom", "Frecuencia (Hz)")
        self.psd_plot.showGrid(x=True, y=True, alpha=0.2)
        self.psd_raw_curve = self.psd_plot.plot([], [], pen=pg.mkPen((130, 130, 130), width=1), name="crudo")
        self.psd_filt_curve = self.psd_plot.plot([], [], pen=pg.mkPen((0, 200, 255), width=2), name="filtrado")
        self.psd_plot.addLegend()
        plots_col.addWidget(self.psd_plot)

        self.winter_plot = pg.PlotWidget()
        self.winter_plot.setLabel("left", "Residuo RMS (m/s²)")
        self.winter_plot.setLabel("bottom", "fc candidato (Hz)")
        self.winter_plot.showGrid(x=True, y=True, alpha=0.2)
        self.winter_curve = self.winter_plot.plot([], [], pen=pg.mkPen((255, 180, 0), width=2))
        self.winter_intercept_line = pg.InfiniteLine(pos=0, angle=0, pen=pg.mkPen((255, 80, 80), style=Qt.PenStyle.DashLine))
        self.winter_chosen_line = pg.InfiniteLine(pos=0, angle=90, pen=pg.mkPen((80, 255, 120), style=Qt.PenStyle.DashLine))
        self.winter_plot.addItem(self.winter_intercept_line)
        self.winter_plot.addItem(self.winter_chosen_line)
        plots_col.addWidget(self.winter_plot)

        self._build_orientation_plots(plots_col)
        self._build_sensor_plots(plots_col)

        plots_scroll = QScrollArea()
        plots_scroll.setWidgetResizable(True)
        plots_scroll.setWidget(plots_content)
        outer.addWidget(plots_scroll, stretch=3)

        self._on_filter_changed()  # populate the param form for the initial selection
        return w

    def _build_signal_filter_group(self) -> QGroupBox:
        box = QGroupBox("Filtro de señal (Accel / Velocity / Stats)")
        side = QVBoxLayout(box)
        side.addWidget(QLabel("Filtro activo:"))
        self.filter_combo = QComboBox()
        for fid, spec in dsp.FILTER_BANK.items():
            self.filter_combo.addItem(spec.label, fid)
        self.filter_combo.currentIndexChanged.connect(self._on_filter_changed)
        side.addWidget(self.filter_combo)

        self.filter_params_form = QFormLayout()
        self.filter_param_widgets: Dict[str, QWidget] = {}
        side.addLayout(self.filter_params_form)

        self.filter_design_label = QLabel("")
        self.filter_design_label.setWordWrap(True)
        side.addWidget(self.filter_design_label)

        side.addWidget(QLabel("Eje a analizar (PSD / Winter):"))
        self.filter_axis_combo = QComboBox()
        self.filter_axis_combo.addItem("Accel X", "ax")
        self.filter_axis_combo.addItem("Accel Y", "ay")
        self.filter_axis_combo.addItem("Accel Z", "az")
        self.filter_axis_combo.addItem("Giro X", "gx")
        self.filter_axis_combo.addItem("Giro Y", "gy")
        self.filter_axis_combo.addItem("Giro Z", "gz")
        self.filter_axis_combo.addItem("a_vert (mundo, orientación dinámica)", "a_vert_world")
        self.filter_axis_combo.setCurrentIndex(2)  # Z default -- most mounts land close to vertical; switch if not
        side.addWidget(self.filter_axis_combo)

        self.export_btn = QPushButton("Export firmware snippet (filtro)")
        self.export_btn.clicked.connect(self._on_export_clicked)
        side.addWidget(self.export_btn)

        self.winter_label = QLabel("")
        self.winter_label.setWordWrap(True)
        side.addWidget(self.winter_label)
        return box

    def _on_filter_changed(self) -> None:
        filter_id = self._current_filter_id()
        spec = dsp.FILTER_BANK[filter_id]

        while self.filter_params_form.rowCount() > 0:
            self.filter_params_form.removeRow(0)
        self.filter_param_widgets = {}

        for p in spec.params:
            if p.kind == "int":
                box: QWidget = QSpinBox()
                box.setRange(int(p.lo), int(p.hi))
                box.setSingleStep(int(p.step))
                box.setValue(int(p.default))
            else:
                box = QDoubleSpinBox()
                box.setRange(p.lo, p.hi)
                box.setSingleStep(p.step)
                box.setDecimals(2)
                box.setValue(p.default)
            self.filter_param_widgets[p.name] = box
            self.filter_params_form.addRow(p.label, box)

        self.export_btn.setEnabled(spec.exportable)
        self._on_tick()  # redraw immediately instead of waiting for the next 33ms tick

    def _design_readout(self, filter_id: str, fs: float, params: dict) -> str:
        spec = dsp.FILTER_BANK[filter_id]
        if filter_id == "passthrough":
            return "Sin filtro — señal cruda."
        if filter_id == "onepole":
            fc = params.get("fc", 10.0)
            rc_ms = 1000.0 / (2 * np.pi * fc)
            return f"-3dB @ {fc:.2f} Hz · orden 1 · retardo de grupo ≈ {rc_ms:.1f} ms @ DC · 1 mul / 2 add por eje"
        if filter_id in ("butter2", "butter4", "butter_zerophase"):
            order = 4 if filter_id == "butter4" else int(params.get("order", 2))
            fc = params.get("fc", 6.0)
            sos = dsp.design_lowpass_sos(fc, fs, order=order, btype="low")
            gd_ms = dsp.group_delay_ms(sos, fs)
            n = sos.shape[0]
            note = "" if spec.causal else "  ·  NO CAUSAL (referencia, no corre en el MCU)"
            return f"-3dB @ {fc:.2f} Hz · orden {order} · retardo de grupo ≈ {gd_ms:.1f} ms @ DC · {5*n} mul / {4*n} add por eje{note}"
        if filter_id == "highpass":
            fc, order = params.get("fc", 0.3), int(params.get("order", 2))
            return f"-3dB @ {fc:.2f} Hz (HP) · orden {order} · quita DC/drift, no suaviza ruido de alta frecuencia"
        if filter_id == "notch":
            f0, q = params.get("f0", 15.0), params.get("q", 10.0)
            return f"Notch @ {f0:.2f} Hz · Q={q:.1f} · atenúa solo esa banda, el resto pasa igual"
        if filter_id == "savgol":
            return (
                f"Ventana {int(params.get('window', 11))} muestras · orden poly {int(params.get('polyorder', 3))} · "
                "mejor preservación de picos · NO CAUSAL (necesita lookahead)"
            )
        if filter_id == "sma":
            win = int(params.get("window", 5))
            return f"Ventana {win} muestras · retardo = {(win-1)/2/fs*1000:.1f} ms · banda de rechazo dentada (línea base)"
        if filter_id == "median":
            k = int(params.get("kernel", 5))
            return f"Kernel {k} muestras · retardo = {(k-1)/2/fs*1000:.1f} ms · único que elimina spikes impulsivos"
        return ""

    def _refresh_filters(self) -> None:
        grid = self._current_grid
        if grid is None:
            return
        filter_id = self._current_filter_id()
        params = self._current_filter_params()
        fs = grid.fs
        axis_key = self.filter_axis_combo.currentData()
        if axis_key == "a_vert_world":
            orient = self._advance_orientation(grid) if self.calib is not None else None
            if orient is None:
                raw = np.full(len(grid.t), np.nan)
            else:
                quats, _accepted, _bias = orient
                gb = imu.gravity_body_array(quats)
                raw = imu.vertical_world(grid.ax, grid.ay, grid.az, gb, self.calib.g_mag)
        else:
            raw = getattr(grid, axis_key)

        self.filter_design_label.setText(self._design_readout(filter_id, fs, params))

        # Welch and the Winter sweep both return silent garbage on NaN
        # input, so refuse an axis with nothing real on it (gyro on a v1
        # capture, or a_vert(mundo) without a calibration yet) instead of
        # drawing an empty plot that looks like a result.
        if not np.any(np.isfinite(raw)):
            self.psd_raw_curve.setData([], [])
            self.psd_filt_curve.setData([], [])
            self.winter_curve.setData([], [])
            if axis_key == "a_vert_world":
                self.winter_label.setText("a_vert(mundo) necesita giroscopio y \"Capturar reposo\" en la pestaña Velocity.")
            else:
                self.winter_label.setText("Esta captura no trae giroscopio (paquete v1): elegí un eje de aceleración.")
            self._refresh_orientation()
            self._refresh_sensor()
            return

        filt = dsp.apply_filter(filter_id, raw, fs, **params)

        f_raw, pxx_raw = dsp.psd(raw, fs)
        f_filt, pxx_filt = dsp.psd(filt, fs)
        # Skip the DC bin -- a log axis can't show f=0.
        self.psd_raw_curve.setData(f_raw[1:], pxx_raw[1:])
        self.psd_filt_curve.setData(f_filt[1:], pxx_filt[1:])

        winter = dsp.winter_residual_analysis(raw, fs)
        self.winter_curve.setData(winter.fc, winter.residual)
        self.winter_intercept_line.setPos(winter.intercept)
        self.winter_chosen_line.setPos(winter.chosen_fc)
        self.winter_label.setText(
            f"Corte sugerido (Winter): {winter.chosen_fc:.1f} Hz  ·  piso de ruido estimado: {winter.intercept:.4f} m/s²"
        )

        # Orientation and Sensor used to be separate tabs; they're now
        # sections of this same tab (no more tab-switching to combine
        # filters with orientation/thermal), so one refresh drives all of it.
        self._refresh_orientation()
        self._refresh_sensor()

    def _on_export_clicked(self) -> None:
        grid = self._current_grid
        if grid is None:
            QMessageBox.warning(self, "Export", "No hay datos suficientes todavía.")
            return
        filter_id = self._current_filter_id()
        params = self._current_filter_params()
        try:
            code = dsp.export_c_snippet(filter_id, grid.fs, **params)
        except ValueError as exc:
            QMessageBox.warning(self, "Export", str(exc))
            return
        self._show_code_dialog(code, f"{filter_id}_filter.h")

    def _on_export_mahony_clicked(self) -> None:
        grid, calib = self._current_grid, self.calib
        if grid is None or calib is None:
            QMessageBox.warning(self, "Export", "Hace falta una captura y \"Capturar reposo\" primero.")
            return
        q0 = imu.tilt_quat(*calib.bias)
        code = dsp.export_mahony_c(
            grid.fs,
            kp=self.orientation_kp_spin.value(),
            ki=self.orientation_ki_spin.value(),
            g_mag=calib.g_mag,
            q0=q0,
            tol_mag=self.orientation_tol_mag_spin.value(),
            tol_ang_deg=self.orientation_tol_ang_spin.value(),
            reject=self.orientation_reject_check.isChecked(),
        )
        self._show_code_dialog(code, "mahony_orientation.h")

    def _on_export_madgwick_clicked(self) -> None:
        grid, calib = self._current_grid, self.calib
        if grid is None or calib is None:
            QMessageBox.warning(self, "Export", "Hace falta una captura y \"Capturar reposo\" primero.")
            return
        q0 = imu.tilt_quat(*calib.bias)
        code = dsp.export_madgwick_c(
            grid.fs,
            beta=self.orientation_beta_spin.value(),
            g_mag=calib.g_mag,
            q0=q0,
            tol_mag=self.orientation_tol_mag_spin.value(),
            tol_ang_deg=self.orientation_tol_ang_spin.value(),
            reject=self.orientation_reject_check.isChecked(),
        )
        self._show_code_dialog(code, "madgwick_orientation.h")

    def _on_export_thermal_clicked(self) -> None:
        if self.calib is None or not np.isfinite(self.calib.temp_c):
            QMessageBox.warning(self, "Export", "Hace falta \"Capturar reposo\" con temperatura disponible (paquete v2).")
            return
        fits = getattr(self, "_thermal_fits", None)
        if not fits:
            QMessageBox.warning(
                self, "Export", "Todavía no se ajustó el modelo térmico -- abrí la pestaña Sensor y apretá \"Ajustar térmica\"."
            )
            return
        code = dsp.export_thermal_c(fits, t_ref=self.calib.temp_c)
        self._show_code_dialog(code, "thermal_correction.h")

    def _show_code_dialog(self, code: str, default_filename: str) -> None:
        dialog = QDialog(self)
        dialog.setWindowTitle("Firmware snippet")
        dialog.resize(760, 560)
        layout = QVBoxLayout(dialog)

        text = QPlainTextEdit()
        text.setReadOnly(True)
        text.setFont(_mono_font())
        text.setPlainText(code)
        layout.addWidget(text)

        buttons = QHBoxLayout()
        copy_btn = QPushButton("Copiar al portapapeles")
        copy_btn.clicked.connect(lambda: QApplication.clipboard().setText(code))
        save_btn = QPushButton("Guardar como…")

        def save() -> None:
            default = str(Path(__file__).parent / default_filename)
            path_str, _ = QFileDialog.getSaveFileName(dialog, "Guardar snippet", default, "C header (*.h);;Todos (*)")
            if path_str:
                Path(path_str).write_text(code)

        save_btn.clicked.connect(save)
        close_btn = QPushButton("Cerrar")
        close_btn.clicked.connect(dialog.accept)
        buttons.addWidget(copy_btn)
        buttons.addWidget(save_btn)
        buttons.addStretch()
        buttons.addWidget(close_btn)
        layout.addLayout(buttons)

        dialog.exec()

    # -- Orientation group (merged into the Filters tab) ----------------------

    def _build_orientation_group(self) -> QGroupBox:
        box = QGroupBox("Orientación (necesita giroscopio + \"Capturar reposo\")")
        side = QVBoxLayout(box)
        side.addWidget(QLabel("Estimador de orientación:"))
        self.orientation_estimator_combo = QComboBox()
        for est_id, label in ORIENTATION_ESTIMATORS[1:]:  # O0 lives entirely in Velocity's "fixed" source
            self.orientation_estimator_combo.addItem(label, est_id)
        self.orientation_estimator_combo.setCurrentIndex(3)  # O4 (Mahony PI) — PLAN-V2.md §1 default
        side.addWidget(self.orientation_estimator_combo)

        form = QFormLayout()
        self.orientation_kp_spin = QDoubleSpinBox()
        self.orientation_kp_spin.setRange(0.0, 10.0)
        self.orientation_kp_spin.setSingleStep(0.1)
        self.orientation_kp_spin.setValue(imu.MAHONY_KP_DEFAULT)
        form.addRow("Kp (Mahony, τ≈1/Kp s)", self.orientation_kp_spin)

        self.orientation_ki_spin = QDoubleSpinBox()
        self.orientation_ki_spin.setRange(0.0, 2.0)
        self.orientation_ki_spin.setSingleStep(0.01)
        self.orientation_ki_spin.setDecimals(3)
        self.orientation_ki_spin.setValue(imu.MAHONY_KI_DEFAULT)
        form.addRow("Ki (Mahony; 0 = complementario O3)", self.orientation_ki_spin)

        self.orientation_beta_spin = QDoubleSpinBox()
        self.orientation_beta_spin.setRange(0.0, 1.0)
        self.orientation_beta_spin.setSingleStep(0.01)
        self.orientation_beta_spin.setDecimals(3)
        self.orientation_beta_spin.setValue(imu.MADGWICK_BETA_DEFAULT)
        form.addRow("β (Madgwick)", self.orientation_beta_spin)
        side.addLayout(form)

        self.orientation_reject_check = QCheckBox("Rechazo de aceleración (§5.3)")
        self.orientation_reject_check.setChecked(True)
        side.addWidget(self.orientation_reject_check)

        reject_form = QFormLayout()
        self.orientation_tol_mag_spin = QDoubleSpinBox()
        self.orientation_tol_mag_spin.setRange(0.1, 10.0)
        self.orientation_tol_mag_spin.setSingleStep(0.1)
        self.orientation_tol_mag_spin.setValue(imu.ACC_REJECT_TOL_MAG_DEFAULT)
        reject_form.addRow("Tolerancia ||a|-|g|| (m/s²)", self.orientation_tol_mag_spin)

        self.orientation_tol_ang_spin = QDoubleSpinBox()
        self.orientation_tol_ang_spin.setRange(1.0, 45.0)
        self.orientation_tol_ang_spin.setSingleStep(1.0)
        self.orientation_tol_ang_spin.setValue(imu.ACC_REJECT_TOL_ANG_DEFAULT)
        reject_form.addRow("Tolerancia ángulo (°)", self.orientation_tol_ang_spin)
        side.addLayout(reject_form)

        self.online_bias_check = QCheckBox("Re-bias automático en reposo (C4)")
        self.online_bias_check.setChecked(True)
        side.addWidget(self.online_bias_check)

        self.o6_reference_check = QCheckBox("Superponer referencia O6 (anclas, no causal)")
        side.addWidget(self.o6_reference_check)

        self.orientation_status_label = QLabel("")
        self.orientation_status_label.setWordWrap(True)
        side.addWidget(self.orientation_status_label)

        # E2/E3 (PLAN-V2.md §8) -- alongside the filter-bank exporter in
        # the "Filtro de señal" section above.
        export_row = QHBoxLayout()
        self.export_mahony_btn = QPushButton("Export Mahony/Compl. (E2)")
        self.export_mahony_btn.clicked.connect(self._on_export_mahony_clicked)
        export_row.addWidget(self.export_mahony_btn)
        self.export_madgwick_btn = QPushButton("Export Madgwick (E3)")
        self.export_madgwick_btn.clicked.connect(self._on_export_madgwick_clicked)
        export_row.addWidget(self.export_madgwick_btn)
        side.addLayout(export_row)
        return box

    def _build_orientation_plots(self, plots_col: QVBoxLayout) -> None:
        self.orientation_plots: List[pg.PlotWidget] = []
        specs = [
            ("roll", "Roll (°)"),
            ("pitch", "Pitch (°)"),
            ("yaw", "Yaw (°, no observable — deriva)"),
            ("theta", "θ inclinación total (°)"),
            ("leak", "Fuga de gravedad g(1-cosθ) (m/s²)"),
            ("bias", "Bias de giro estimado (°/s)"),
        ]
        for _key, label in specs:
            plot = pg.PlotWidget()
            plot.setLabel("left", label)
            plot.setLabel("bottom", "t (s)")
            plot.showGrid(x=True, y=True, alpha=0.2)
            if self.orientation_plots:
                plot.setXLink(self.orientation_plots[0])
            self.orientation_plots.append(plot)
            plots_col.addWidget(plot)

        self.orientation_curves = {
            "roll": self.orientation_plots[0].plot([], [], pen=pg.mkPen((0, 200, 255), width=2)),
            "pitch": self.orientation_plots[1].plot([], [], pen=pg.mkPen((0, 220, 120), width=2)),
            "yaw": self.orientation_plots[2].plot([], [], pen=pg.mkPen((160, 160, 160), width=2)),
            "theta": self.orientation_plots[3].plot([], [], pen=pg.mkPen((255, 180, 0), width=2), name="causal"),
            "theta_o6": self.orientation_plots[3].plot(
                [], [], pen=pg.mkPen((255, 80, 255), width=2, style=Qt.PenStyle.DotLine), name="O6 (referencia)"
            ),
            "leak": self.orientation_plots[4].plot([], [], pen=pg.mkPen((255, 80, 80), width=2)),
            "bias_x": self.orientation_plots[5].plot([], [], pen=pg.mkPen((255, 80, 80), width=1), name="x"),
            "bias_y": self.orientation_plots[5].plot([], [], pen=pg.mkPen((80, 255, 80), width=1), name="y"),
            "bias_z": self.orientation_plots[5].plot([], [], pen=pg.mkPen((80, 80, 255), width=1), name="z"),
        }
        self.orientation_plots[3].addLegend()
        self.orientation_plots[5].addLegend()
        self.orientation_reject_regions: list = []

    def _refresh_orientation(self) -> None:
        grid = self._current_grid
        if grid is None:
            return
        sl = self._visible_slice(grid.fs, len(grid.t))
        t_vis = grid.t[sl]

        if not dsp.gyro_available(grid) or self.calib is None:
            for curve in self.orientation_curves.values():
                curve.setData([], [])
            self.orientation_status_label.setText(
                "Sin giroscopio (paquete v1)." if not dsp.gyro_available(grid) else 'Falta "Capturar reposo" en la pestaña Velocity.'
            )
            return

        orient = self._advance_orientation(grid)
        if orient is None:
            for curve in self.orientation_curves.values():
                curve.setData([], [])
            self.orientation_status_label.setText("Orientación no disponible todavía.")
            return

        quats, accepted, bias = orient
        q0 = imu.tilt_quat(*self.calib.bias)

        n = len(quats)
        roll = np.empty(n)
        pitch = np.empty(n)
        yaw = np.empty(n)
        theta = np.empty(n)
        for i in range(n):
            q = tuple(quats[i])
            roll[i], pitch[i], yaw[i] = imu.quat_to_euler_deg(q)
            theta[i] = imu.tilt_angle(q, q0)
        leak = -self.calib.g_mag * (1.0 - np.cos(np.radians(theta)))

        self.orientation_curves["roll"].setData(t_vis, roll[sl])
        self.orientation_curves["pitch"].setData(t_vis, pitch[sl])
        self.orientation_curves["yaw"].setData(t_vis, yaw[sl])
        self.orientation_curves["theta"].setData(t_vis, theta[sl])
        self.orientation_curves["leak"].setData(t_vis, leak[sl])
        self.orientation_curves["bias_x"].setData(t_vis, np.degrees(bias[sl, 0]))
        self.orientation_curves["bias_y"].setData(t_vis, np.degrees(bias[sl, 1]))
        self.orientation_curves["bias_z"].setData(t_vis, np.degrees(bias[sl, 2]))

        # Shade where the accel measurement was rejected (PLAN-V2.md §5.3),
        # same treatment as Accel's interpolated regions.
        for item in self.orientation_reject_regions:
            self.orientation_plots[3].removeItem(item)
        self.orientation_reject_regions.clear()
        for start, end in _find_runs(~accepted[sl]):
            region = pg.LinearRegionItem(values=(t_vis[start], t_vis[end]), movable=False, brush=pg.mkBrush(255, 80, 80, 40))
            region.setZValue(-10)
            self.orientation_plots[3].addItem(region)
            self.orientation_reject_regions.append(region)

        if self.o6_reference_check.isChecked():
            a_vert_fixed = dsp.project_vertical(grid.ax, grid.ay, grid.az, self.calib)
            rest_intervals = self._rest_intervals(grid, a_vert_fixed)
            gyr = np.stack([grid.gx, grid.gy, grid.gz], axis=1)
            acc = np.stack([grid.ax, grid.ay, grid.az], axis=1)
            anchored = imu.integrate_between_rest_anchors(acc, gyr, 1.0 / grid.fs, rest_intervals, len(grid.t))
            theta_o6 = np.full(len(grid.t), np.nan)
            for i in np.nonzero(np.all(np.isfinite(anchored), axis=1))[0]:
                theta_o6[i] = imu.tilt_angle(tuple(anchored[i]), q0)
            self.orientation_curves["theta_o6"].setData(t_vis, theta_o6[sl])
        else:
            self.orientation_curves["theta_o6"].setData([], [])

        n_rejected = int(np.count_nonzero(~accepted))
        self.orientation_status_label.setText(
            f"θ actual: {theta[-1]:.2f}°  ·  bias giro: ({math.degrees(bias[-1, 0]):.2f}, "
            f"{math.degrees(bias[-1, 1]):.2f}, {math.degrees(bias[-1, 2]):.2f}) °/s  ·  "
            f"{n_rejected}/{len(accepted)} muestras con aceleración rechazada"
        )

    # -- Sensor / thermal group (merged into the Filters tab) -----------------

    def _build_sensor_group(self) -> QGroupBox:
        box = QGroupBox("Sensor / térmica")
        side = QVBoxLayout(box)
        self.sensor_status_label = QLabel("")
        self.sensor_status_label.setWordWrap(True)
        side.addWidget(self.sensor_status_label)

        side.addWidget(QLabel("Eje a ajustar (bias vs T):"))
        self.thermal_axis_combo = QComboBox()
        for axis in ("ax", "ay", "az", "gx", "gy", "gz"):
            self.thermal_axis_combo.addItem(axis, axis)
        side.addWidget(self.thermal_axis_combo)

        self.thermal_fit_btn = QPushButton("Ajustar térmica (C6/A5, grabación completa)")
        self.thermal_fit_btn.clicked.connect(self._on_thermal_fit_clicked)
        side.addWidget(self.thermal_fit_btn)
        self.thermal_fit_label = QLabel("")
        self.thermal_fit_label.setWordWrap(True)
        side.addWidget(self.thermal_fit_label)

        self.allan_fit_btn = QPushButton("Calcular Allan (A4, grabación completa)")
        self.allan_fit_btn.clicked.connect(self._on_allan_clicked)
        side.addWidget(self.allan_fit_btn)
        self.allan_label = QLabel("")
        self.allan_label.setWordWrap(True)
        side.addWidget(self.allan_label)

        self.export_thermal_btn = QPushButton("Export corrección térmica (E4)")
        self.export_thermal_btn.clicked.connect(self._on_export_thermal_clicked)
        side.addWidget(self.export_thermal_btn)
        return box

    def _build_sensor_plots(self, plots_col: QVBoxLayout) -> None:
        self.temp_plot = pg.PlotWidget()
        self.temp_plot.setLabel("left", "T (°C)")
        self.temp_plot.setLabel("bottom", "t (s)")
        self.temp_plot.showGrid(x=True, y=True, alpha=0.2)
        self.temp_curve = self.temp_plot.plot([], [], pen=pg.mkPen((255, 150, 0), width=2))
        plots_col.addWidget(self.temp_plot)

        self.thermal_scatter_plot = pg.PlotWidget()
        self.thermal_scatter_plot.setLabel("left", "Bias (unidad del eje elegido)")
        self.thermal_scatter_plot.setLabel("bottom", "T (°C)")
        self.thermal_scatter_plot.showGrid(x=True, y=True, alpha=0.2)
        self.thermal_scatter_curve = self.thermal_scatter_plot.plot(
            [], [], pen=None, symbol="o", symbolSize=5, symbolBrush=(0, 200, 255)
        )
        self.thermal_fit_curve = self.thermal_scatter_plot.plot([], [], pen=pg.mkPen((255, 80, 80), width=2))
        plots_col.addWidget(self.thermal_scatter_plot)

        self.allan_plot = pg.PlotWidget()
        self.allan_plot.setLogMode(x=True, y=True)
        self.allan_plot.setLabel("left", "ADEV")
        self.allan_plot.setLabel("bottom", "τ (s)")
        self.allan_plot.showGrid(x=True, y=True, alpha=0.2)
        colors = {
            "ax": (255, 80, 80), "ay": (80, 255, 80), "az": (80, 80, 255),
            "gx": (255, 180, 0), "gy": (0, 220, 255), "gz": (220, 0, 220),
        }
        self.allan_curves = {axis: self.allan_plot.plot([], [], pen=pg.mkPen(color, width=2), name=axis) for axis, color in colors.items()}
        self.allan_plot.addLegend()
        plots_col.addWidget(self.allan_plot)

    def _refresh_sensor(self) -> None:
        grid = self._current_grid
        if grid is None:
            return
        sl = self._visible_slice(grid.fs, len(grid.t))
        if not dsp.gyro_available(grid):
            self.temp_curve.setData([], [])
            self.sensor_status_label.setText("Esta captura no trae temperatura (paquete v1).")
            return

        self.temp_curve.setData(grid.t[sl], grid.temp_c[sl])

        # C5a — warm-up guard: dT/dt over the trailing 10s.
        window = max(1, int(round(10.0 * grid.fs)))
        if len(grid.temp_c) > window:
            dTdt_c_per_min = (grid.temp_c[-1] - grid.temp_c[-window]) / (window / grid.fs) * 60.0
            status = f"T actual: {grid.temp_c[-1]:.2f}°C  ·  dT/dt: {dTdt_c_per_min:+.2f} °C/min"
            if abs(dTdt_c_per_min) > 0.2:
                status += "  ⚠ sensor en calentamiento — la calibración va a envejecer rápido"
        else:
            status = f"T actual: {grid.temp_c[-1]:.2f}°C"
        self.sensor_status_label.setText(status)

    def _on_thermal_fit_clicked(self) -> None:
        grid = self._current_grid
        if grid is None or not dsp.gyro_available(grid):
            QMessageBox.warning(self, "Ajuste térmico", "Hace falta una captura v2 con temperatura.")
            return
        axis = self.thermal_axis_combo.currentData()
        x = getattr(grid, axis)
        fit = imu.thermal_fit(grid.temp_c, x, fs=grid.fs)
        if fit is None:
            self.thermal_fit_label.setText(
                "No se pudo ajustar: hace falta una grabación larga (varios minutos) con la temperatura variando de verdad."
            )
            self.thermal_scatter_curve.setData([], [])
            self.thermal_fit_curve.setData([], [])
            return

        self._thermal_fits[axis] = fit

        window = max(1, int(round(10.0 * grid.fs)))
        n_windows = len(grid.temp_c) // window
        t_w = grid.temp_c[: n_windows * window].reshape(n_windows, window).mean(axis=1)
        x_w = x[: n_windows * window].reshape(n_windows, window).mean(axis=1)
        self.thermal_scatter_curve.setData(t_w, x_w)
        t_line = np.linspace(float(np.min(t_w)), float(np.max(t_w)), 50)
        self.thermal_fit_curve.setData(t_line, fit.slope * t_line + fit.intercept)
        self.thermal_fit_label.setText(
            f"{axis}: pendiente={fit.slope:.6f}/°C  ·  R²={fit.r2:.3f}  ·  RMS residuo={fit.rms_residual:.4f}"
            + ("" if fit.r2 >= 0.8 else "  (R² < 0.8 -- no se recomienda exportar E4 para este eje)")
        )

    def _on_allan_clicked(self) -> None:
        grid = self._current_grid
        if grid is None or not dsp.gyro_available(grid):
            QMessageBox.warning(self, "Allan", "Hace falta una captura v2 con giroscopio.")
            return
        lines = []
        for axis, curve in self.allan_curves.items():
            y = getattr(grid, axis)
            taus, adev = imu.oadev(y, grid.fs)
            curve.setData(taus, adev)
            if len(adev):
                bias_inst, tau_min = imu.bias_instability(taus, adev)
                lines.append(f"{axis}: ADEV(τ_min)={adev[int(np.argmin(adev))]:.5f}  ·  inestabilidad≈{bias_inst:.5f} @ τ={tau_min:.1f}s")
        self.allan_label.setText("\n".join(lines))


def main() -> None:
    pg.setConfigOptions(antialias=True)
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
