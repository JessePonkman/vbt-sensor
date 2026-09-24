# VBT Protocol v1 — see firmware/src/main.cpp for the source of truth, and
# clients/mobile/src/protocol.ts for the sibling implementation. Keep all
# three in sync if the packet ever changes.
#
# Byte 0       : magic       uint8   (0x56)
# Byte 1       : version     uint8   (0x01)
# Byte 2-5     : timestamp   uint32  LE, microseconds since ESP32 boot
# Byte 6-9     : accel X     float32 LE, m/s^2
# Byte 10-13   : accel Y     float32 LE, m/s^2
# Byte 14-17   : accel Z     float32 LE, m/s^2
# Byte 18-21   : sequence    uint32  LE
# TOTAL = 22 bytes

from __future__ import annotations

import struct
import time
from typing import NamedTuple, Optional

DEVICE_NAME = "VBT-ESP32"
SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8"

_VBT_MAGIC = 0x56
_VBT_VERSION = 0x01

# <  little-endian, no padding
# B  magic       (uint8)
# B  version     (uint8)
# I  timestamp   (uint32)
# f  ax          (float32)
# f  ay          (float32)
# f  az          (float32)
# I  sequence    (uint32)
PACKET = struct.Struct("<BBIfffI")
assert PACKET.size == 22, "VBT packet must be exactly 22 bytes"

_U32_WRAP = 2**32


class Sample(NamedTuple):
    timestamp: int  # microseconds since ESP32 boot, uint32, wraps ~every 71.6 min
    ax: float
    ay: float
    az: float
    sequence: int
    rx_at: float  # time.monotonic() on the client, used to measure the real Hz
    raw: bytes  # the 22 raw bytes, for the hex debug view


def parse_packet(data: bytes, rx_at: Optional[float] = None) -> Optional[Sample]:
    """Parses a VBT v1 packet. Returns None for anything that isn't exactly one
    valid 22-byte packet (wrong length usually means a malformed notify)."""
    if len(data) != PACKET.size:
        return None

    magic, version, timestamp, ax, ay, az, sequence = PACKET.unpack(data)
    if magic != _VBT_MAGIC or version != _VBT_VERSION:
        return None

    return Sample(
        timestamp=timestamp,
        ax=ax,
        ay=ay,
        az=az,
        sequence=sequence,
        rx_at=rx_at if rx_at is not None else time.monotonic(),
        raw=bytes(data),
    )


def delta_us(prev_us: int, curr_us: int) -> int:
    """Wrap-safe microsecond delta between two uint32 micros() readings — the
    C `(uint32_t)(now - last)` trick, portable to Python ints. Ambiguous only
    for true gaps >= 71.6 min, which the DT_MAX_S reset in dsp.py catches
    long before it matters."""
    return (curr_us - prev_us) % _U32_WRAP


def magnitude(ax: float, ay: float, az: float) -> float:
    return (ax**2 + ay**2 + az**2) ** 0.5


def to_hex(raw: bytes) -> str:
    return " ".join(f"{b:02x}" for b in raw)
