// VBT Protocol v1 — see firmware/src/main.cpp for the source of truth.
//
// Byte 0       : magic       uint8   (0x56)
// Byte 1       : version     uint8   (0x01)
// Byte 2-5     : timestamp   uint32  LE, microseconds since ESP32 boot
// Byte 6-9     : accel X     float32 LE, m/s^2
// Byte 10-13   : accel Y     float32 LE, m/s^2
// Byte 14-17   : accel Z     float32 LE, m/s^2
// Byte 18-21   : sequence    uint32  LE
// TOTAL = 22 bytes

export const DEVICE_NAME = 'VBT-ESP32';
export const SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
export const CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';

const VBT_MAGIC = 0x56;
const VBT_VERSION = 0x01;
const PACKET_LENGTH = 22;

export type VbtSample = {
  timestamp: number; // microseconds since ESP32 boot, overflows ~every 71.6 min
  ax: number;
  ay: number;
  az: number;
  sequence: number;
  rxAt: number; // Date.now() on the client, used to measure the real Hz
  raw: Uint8Array; // the 22 raw bytes, for the hex debug toggle
};

/** Parses a VBT v1 packet. Returns null for anything that isn't exactly one
 * valid 22-byte packet (wrong length usually means the MTU wasn't negotiated). */
export function parsePacket(bytes: Uint8Array, rxAt: number = Date.now()): VbtSample | null {
  if (bytes.length !== PACKET_LENGTH) return null;
  if (bytes[0] !== VBT_MAGIC || bytes[1] !== VBT_VERSION) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return {
    timestamp: view.getUint32(2, true),
    ax: view.getFloat32(6, true),
    ay: view.getFloat32(10, true),
    az: view.getFloat32(14, true),
    sequence: view.getUint32(18, true),
    rxAt,
    raw: bytes,
  };
}

export function magnitude(sample: Pick<VbtSample, 'ax' | 'ay' | 'az'>): number {
  return Math.sqrt(sample.ax ** 2 + sample.ay ** 2 + sample.az ** 2);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}
