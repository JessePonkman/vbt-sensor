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
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

import dsp
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
        for label in ["Vx (m/s)", "Vy (m/s)", "Vz (m/s)", "V vertical (m/s)"]:
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

        side.addWidget(QLabel("Corrección de drift:"))
        self.drift_combo = QComboBox()
        self.drift_combo.addItem("Detrend (lineal)", "detrend")
        self.drift_combo.addItem("High-pass 0.3 Hz", "highpass")
        self.drift_combo.addItem("Ninguno", "none")
        side.addWidget(self.drift_combo)

        self.zupt_check = QCheckBox("ZUPT (zero-velocity update)")
        side.addWidget(self.zupt_check)

        self.raw_integration_check = QCheckBox("Integración cruda (sin correcciones)")
        side.addWidget(self.raw_integration_check)

        side.addStretch()
        outer.addLayout(side, stretch=1)
        return w

    def _on_capture_rest(self) -> None:
        grid = self._current_grid
        if grid is None:
            return
        n = max(1, int(round(1.0 * grid.fs)))  # trailing 1s, matching vbt.ts's CALIB_MS
        calib = dsp.calibrate(grid.ax[-n:], grid.ay[-n:], grid.az[-n:])
        if calib is None:
            self.calib_label.setText("Calibración rechazada: no estaba quieto, o |g| fuera de rango.")
            return
        self.calib = calib
        self.calib_label.setText(
            f"Calibrado: bias=({calib.bias[0]:.3f}, {calib.bias[1]:.3f}, {calib.bias[2]:.3f}) m/s²  |g|={calib.g_mag:.3f}"
        )

    def _apply_drift_correction(self, t: np.ndarray, v: np.ndarray, a_used: np.ndarray, fs: float) -> np.ndarray:
        mode = self.drift_combo.currentData()
        if mode == "detrend":
            v, _bias = dsp.detrend_linear(t, v)
        elif mode == "highpass":
            v = dsp.apply_butter_hp(v, fs, fc=0.3, order=1)
        if self.zupt_check.isChecked():
            v = dsp.apply_zupt(v, a_used, fs)
        return v

    def _refresh_velocity(self) -> None:
        grid = self._current_grid
        if grid is None:
            return
        filter_id = self._current_filter_id()
        params = self._current_filter_params()
        fs = grid.fs
        raw_mode = self.raw_integration_check.isChecked()
        sl = self._visible_slice(fs, len(grid.t))

        for curve, axis_key, bias_idx in zip(self.velocity_curves[:3], ("ax", "ay", "az"), (0, 1, 2)):
            a_filt = dsp.apply_filter(filter_id, getattr(grid, axis_key), fs, **params)
            if not raw_mode and self.gravity_check.isChecked() and self.calib is not None:
                a_used = a_filt - self.calib.bias[bias_idx]
            else:
                a_used = a_filt
            v = dsp.integrate_velocity(a_used, grid.t)
            if not raw_mode:
                v = self._apply_drift_correction(grid.t, v, a_used, fs)
            curve.setData(grid.t[sl], v[sl])

        if self.calib is not None:
            # a . g_hat - |g| is linear, so filtering this scalar projection
            # is identical to projecting the filtered vector, at a third of
            # the arithmetic (vbt.ts:716's own reasoning, reused as-is).
            a_vert = dsp.project_vertical(grid.ax, grid.ay, grid.az, self.calib)
            a_vert_filt = dsp.apply_filter(filter_id, a_vert, fs, **params)
            v_vert = dsp.integrate_velocity(a_vert_filt, grid.t)
            if not raw_mode:
                v_vert = self._apply_drift_correction(grid.t, v_vert, a_vert_filt, fs)
            self.velocity_curves[3].setData(grid.t[sl], v_vert[sl])
        else:
            self.velocity_curves[3].setData([], [])

    # -- tab 4: Stats -----------------------------------------------------

    STAT_FIELDS = ("max", "min", "mean", "median", "std", "rms", "peak_to_peak")
    STAT_LABELS = ("Max", "Min", "Media", "Mediana", "Std", "RMS", "P2P")
    STAT_ROWS = ("X", "Y", "Z", "|a|", "gX", "gY", "gZ", "|ω|")

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

        rows = triple(("ax", "ay", "az"))
        if dsp.gyro_available(grid):
            rows += triple(("gx", "gy", "gz"))

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

    # -- tab 5: Filters -----------------------------------------------------

    def _build_filters_tab(self) -> QWidget:
        w = QWidget()
        outer = QHBoxLayout(w)

        side = QVBoxLayout()
        side.addWidget(QLabel("Filtro activo (aplica a Accel, Velocity y Stats):"))
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
        self.filter_axis_combo.setCurrentIndex(2)  # Z default -- most mounts land close to vertical; switch if not
        side.addWidget(self.filter_axis_combo)

        self.export_btn = QPushButton("Export firmware snippet")
        self.export_btn.clicked.connect(self._on_export_clicked)
        side.addWidget(self.export_btn)

        self.winter_label = QLabel("")
        self.winter_label.setWordWrap(True)
        side.addWidget(self.winter_label)

        side.addStretch()
        outer.addLayout(side, stretch=1)

        plots_col = QVBoxLayout()
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
        outer.addLayout(plots_col, stretch=3)

        self._on_filter_changed()  # populate the param form for the initial selection
        return w

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
        raw = getattr(grid, axis_key)

        self.filter_design_label.setText(self._design_readout(filter_id, fs, params))

        # Welch and the Winter sweep both return silent garbage on NaN
        # input, so refuse the gyro axes on a v1 capture instead of drawing
        # an empty plot that looks like a result.
        if not np.any(np.isfinite(raw)):
            self.psd_raw_curve.setData([], [])
            self.psd_filt_curve.setData([], [])
            self.winter_curve.setData([], [])
            self.winter_label.setText("Esta captura no trae giroscopio (paquete v1): elegí un eje de aceleración.")
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

        dialog = QDialog(self)
        dialog.setWindowTitle("Firmware snippet")
        dialog.resize(720, 520)
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
            default = str(Path(__file__).parent / f"{filter_id}_filter.h")
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


def main() -> None:
    pg.setConfigOptions(antialias=True)
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
