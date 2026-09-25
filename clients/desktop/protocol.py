# VBT Protocol — see firmware/src/main.cpp for the source of truth, and
# clients/mobile/src/protocol.ts for the sibling implementation. Keep all
# three in sync if the packet ever changes.
#
# v1 — 22 bytes (accel only). The firmware no longer emits this, but every
# CSV recorded before the v2 switch is v1 data, so the parser keeps it.
#
# Byte 0       : magic       uint8   (0x56)
# Byte 1       : version     uint8   (0x01)
# Byte 2-5     : timestamp   uint32  LE, microseconds since ESP32 boot
# Byte 6-9     : accel X     float32 LE, m/s^2
# Byte 10-13   : accel Y     float32 LE, m/s^2
# Byte 14-17   : accel Z     float32 LE, m/s^2
# Byte 18-21   : sequence    uint32  LE
#
# v2 — 42 bytes. See firmware/PLAN.md §3. Adds the gyroscope and temperature
# the driver was already reading and discarding, a flags byte, and the two
# fields that make the sample clock honest: `timestamp` is now the SCHEDULED
# grid time (an exact multiple of the sample interval since boot) and
# `jitter_us` is how far the actual read ran behind it.
#
# Byte 0       : magic       uint8   (0x56)
# Byte 1       : version     uint8   (0x02)
# Byte 2       : flags       uint8   bitfield, see FLAG_* below
# Byte 3       : txDropped   uint8   notifies dropped since the last success
# Byte 4-7     : timestamp   uint32  LE, scheduled grid time in us since boot
# Byte 8-11    : sequence    uint32  LE
# Byte 12-13   : jitterUs    int16   LE, actual read time minus scheduled
# Byte 14-25   : accel X/Y/Z float32 LE, m/s^2
# Byte 26-37   : gyro  X/Y/Z float32 LE, rad/s
# Byte 38-41   : tempC       float32 LE, degrees Celsius

from __future__ import annotations

import math
import struct
import time
from typing import NamedTuple, Optional

DEVICE_NAME = "VBT-ESP32"
SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8"

_VBT_MAGIC = 0x56
_VBT_VERSION_V1 = 0x01
_VBT_VERSION_V2 = 0x02

# <  little-endian, no padding
# B  magic       (uint8)
# B  version     (uint8)
# I  timestamp   (uint32)
# f  ax          (float32)
# f  ay          (float32)
# f  az          (float32)
# I  sequence    (uint32)
PACKET_V1 = struct.Struct("<BBIfffI")
assert PACKET_V1.size == 22, "VBT v1 packet must be exactly 22 bytes"

# <  little-endian, no padding
# B  magic       (uint8)
# B  version     (uint8)
# B  flags       (uint8)
# B  txDropped   (uint8)
# I  timestamp   (uint32)
# I  sequence    (uint32)
# h  jitterUs    (int16, SIGNED — a read can finish early)
# 7f ax ay az gx gy gz tempC
PACKET_V2 = struct.Struct("<BBBBIIh7f")
assert PACKET_V2.size == 42, "VBT v2 packet must be exactly 42 bytes"

# Mirror of the VBT_FLAG_* defines in firmware/src/main.cpp.
FLAG_ACCEL_CLIPPED = 0x01  # an accel axis hit the +-8 g rail
FLAG_GYRO_CLIPPED = 0x02  # a gyro axis hit the +-500 dps rail
FLAG_IMU_READ_FAILED = 0x04  # mpu.getEvent() returned false: the values are stale
FLAG_SCHED_LATE = 0x08  # the read ran a full sample interval or more behind
FLAG_SCHED_RESYNC = 0x10  # the firmware abandoned its schedule and jumped to now

_FLAG_LABELS = (
    (FLAG_ACCEL_CLIPPED, "CLIP"),
    (FLAG_GYRO_CLIPPED, "GCLIP"),
    (FLAG_IMU_READ_FAILED, "I2C"),
    (FLAG_SCHED_LATE, "LATE"),
    (FLAG_SCHED_RESYNC, "RESYNC"),
)

_U32_WRAP = 2**32


class Sample(NamedTuple):
    timestamp: int  # microseconds since ESP32 boot, uint32, wraps ~every 71.6 min
    ax: float
    ay: float
    az: float
    sequence: int
    rx_at: float  # time.monotonic() on the client, used to measure the real Hz
    raw: bytes  # the raw packet bytes, for the hex debug view
    # v2 only. The defaults are NaN and not 0.0 on purpose: a gyro at rest
    # reads almost exactly zero, so "no data" and "the sensor read zero" have
    # to stay distinguishable. Anything downstream must be NaN-tolerant.
    gx: float = math.nan  # rad/s
    gy: float = math.nan
    gz: float = math.nan
    temp_c: float = math.nan
    # NaN for the same reason as the gyro: 0 us is a real, excellent timing
    # measurement, so it can't double as "this packet never reported one".
    jitter_us: float = math.nan
    # These two stay 0 rather than NaN — they're counters, and "none
    # reported" is the honest reading of a v1 packet for both.
    flags: int = 0
    tx_dropped: int = 0


def parse_packet(data: bytes, rx_at: Optional[float] = None) -> Optional[Sample]:
    """Parses a VBT packet, dispatching on the version byte. Returns None for
    anything that isn't exactly one valid packet of a known version.

    Dispatch reads only bytes 0-1, which is why the firmware keeps magic and
    version at offset 0/1 no matter how the rest of the packet grows."""
    if len(data) < 2 or data[0] != _VBT_MAGIC:
        return None

    rx = rx_at if rx_at is not None else time.monotonic()
    version = data[1]

    if version == _VBT_VERSION_V1:
        return _parse_v1(data, rx)
    if version == _VBT_VERSION_V2:
        return _parse_v2(data, rx)
    return None


def _parse_v1(data: bytes, rx_at: float) -> Optional[Sample]:
    if len(data) != PACKET_V1.size:
        return None

    _, _, timestamp, ax, ay, az, sequence = PACKET_V1.unpack(data)

    return Sample(
        timestamp=timestamp,
        ax=ax,
        ay=ay,
        az=az,
        sequence=sequence,
        rx_at=rx_at,
        raw=bytes(data),
    )


def _parse_v2(data: bytes, rx_at: float) -> Optional[Sample]:
    if len(data) != PACKET_V2.size:
        return None

    (
        _,
        _,
        flags,
        tx_dropped,
        timestamp,
        sequence,
        jitter_us,
        ax,
        ay,
        az,
        gx,
        gy,
        gz,
        temp_c,
    ) = PACKET_V2.unpack(data)

    return Sample(
        timestamp=timestamp,
        ax=ax,
        ay=ay,
        az=az,
        sequence=sequence,
        rx_at=rx_at,
        raw=bytes(data),
        gx=gx,
        gy=gy,
        gz=gz,
        temp_c=temp_c,
        jitter_us=float(jitter_us),
        flags=flags,
        tx_dropped=tx_dropped,
    )


def describe_flags(flags: int) -> str:
    """Short pipe-joined labels for the Stream view, e.g. "CLIP|I2C".
    Empty string when nothing is set, which is the normal case."""
    return "|".join(label for bit, label in _FLAG_LABELS if flags & bit)


def delta_us(prev_us: int, curr_us: int) -> int:
    """Wrap-safe microsecond delta between two uint32 micros() readings — the
    C `(uint32_t)(now - last)` trick, portable to Python ints. Ambiguous only
    for true gaps >= 71.6 min, which the DT_MAX_S reset in dsp.py catches
    long before it matters."""
    return (curr_us - prev_us) % _U32_WRAP


def magnitude(x: float, y: float, z: float) -> float:
    return (x**2 + y**2 + z**2) ** 0.5


def to_hex(raw: bytes) -> str:
    return " ".join(f"{b:02x}" for b in raw)
