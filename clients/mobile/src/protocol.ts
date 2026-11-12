// VBT Protocol — see firmware/src/main.cpp for the source of truth, and
// clients/desktop/protocol.py for the sibling implementation. Keep all three
// in sync if the packet ever changes. The parser dispatches on the version
// byte (offset 1), so both generations of firmware keep working.
//
// v1 — 22 bytes (accelerometer only)
// Byte 0       : magic       uint8   (0x56)
// Byte 1       : version     uint8   (0x01)
// Byte 2-5     : timestamp   uint32  LE, microseconds since ESP32 boot
// Byte 6-9     : accel X     float32 LE, m/s^2
// Byte 10-13   : accel Y     float32 LE, m/s^2
// Byte 14-17   : accel Z     float32 LE, m/s^2
// Byte 18-21   : sequence    uint32  LE
//
// v2 — 42 bytes (adds gyroscope, temperature, flags and timing diagnostics)
// Byte 0       : magic       uint8   (0x56)
// Byte 1       : version     uint8   (0x02)
// Byte 2       : flags       uint8   bitfield, see FLAG_* below
// Byte 3       : txDropped   uint8   notifies dropped since the last success
// Byte 4-7     : timestamp   uint32  LE, scheduled grid time in us since boot
// Byte 8-11    : sequence    uint32  LE
// Byte 12-13   : jitterUs    int16   LE, actual read time minus scheduled
// Byte 14-25   : accel X/Y/Z float32 LE, m/s^2
// Byte 26-37   : gyro  X/Y/Z float32 LE, rad/s
// Byte 38-41   : tempC       float32 LE, degrees Celsius

export const DEVICE_NAME = 'VBT-ESP32';
export const SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
export const CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';

const VBT_MAGIC = 0x56;
const VBT_VERSION_V1 = 0x01;
const VBT_VERSION_V2 = 0x02;
const PACKET_LENGTH_V1 = 22;
const PACKET_LENGTH_V2 = 42;

/** Bytes a notification needs on the wire: the largest packet plus the
 *  3-byte ATT header. ble.ts rejects a connection whose MTU is below this. */
export const MIN_PACKET_MTU = PACKET_LENGTH_V2 + 3;

// Mirror of the VBT_FLAG_* defines in firmware/src/main.cpp.
export const FLAG_ACCEL_CLIPPED = 0x01;
export const FLAG_GYRO_CLIPPED = 0x02;
export const FLAG_IMU_READ_FAILED = 0x04; // the values in this packet are stale
export const FLAG_SCHED_LATE = 0x08;
export const FLAG_SCHED_RESYNC = 0x10;

export type VbtSample = {
  timestamp: number; // microseconds since ESP32 boot, overflows ~every 71.6 min
  ax: number;
  ay: number;
  az: number;
  sequence: number;
  rxAt: number; // Date.now() on the client, used to measure the real Hz
  raw: Uint8Array; // the raw packet bytes, for the hex debug toggle
  version: 1 | 2;
  // v2 only. Optional (not NaN) so a v1 sample is unambiguous: a gyro at
  // rest reads almost exactly zero, so "no data" must not look like a zero.
  gx?: number; // rad/s
  gy?: number;
  gz?: number;
  tempC?: number;
  flags?: number;
  txDropped?: number;
  jitterUs?: number;
};

/** Parses a VBT packet, dispatching on the version byte. Returns null for
 * anything that isn't exactly one valid packet of a known version (a wrong
 * length usually means the MTU wasn't negotiated). */
export function parsePacket(bytes: Uint8Array, rxAt: number = Date.now()): VbtSample | null {
  if (bytes.length < 2 || bytes[0] !== VBT_MAGIC) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes[1] === VBT_VERSION_V1) {
    if (bytes.length !== PACKET_LENGTH_V1) return null;
    return {
      version: 1,
      timestamp: view.getUint32(2, true),
      ax: view.getFloat32(6, true),
      ay: view.getFloat32(10, true),
      az: view.getFloat32(14, true),
      sequence: view.getUint32(18, true),
      rxAt,
      raw: bytes,
    };
  }

  if (bytes[1] === VBT_VERSION_V2) {
    if (bytes.length !== PACKET_LENGTH_V2) return null;
    return {
      version: 2,
      flags: view.getUint8(2),
      txDropped: view.getUint8(3),
      timestamp: view.getUint32(4, true),
      sequence: view.getUint32(8, true),
      jitterUs: view.getInt16(12, true),
      ax: view.getFloat32(14, true),
      ay: view.getFloat32(18, true),
      az: view.getFloat32(22, true),
      gx: view.getFloat32(26, true),
      gy: view.getFloat32(30, true),
      gz: view.getFloat32(34, true),
      tempC: view.getFloat32(38, true),
      rxAt,
      raw: bytes,
    };
  }

  return null;
}

export function magnitude(sample: Pick<VbtSample, 'ax' | 'ay' | 'az'>): number {
  return Math.sqrt(sample.ax ** 2 + sample.ay ** 2 + sample.az ** 2);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}
