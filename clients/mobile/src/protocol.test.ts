import assert from 'node:assert/strict';
import { test } from 'node:test';
// Node's built-in TS runner needs the explicit extension for ESM resolution;
// Metro (which bundles the app itself) resolves extensionless imports fine.
import { parsePacket } from './protocol.ts';

function buildPacket(overrides: {
  magic?: number;
  version?: number;
  timestamp?: number;
  ax?: number;
  ay?: number;
  az?: number;
  sequence?: number;
}): Uint8Array {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);

  view.setUint8(0, overrides.magic ?? 0x56);
  view.setUint8(1, overrides.version ?? 0x01);
  view.setUint32(2, overrides.timestamp ?? 123456, true);
  view.setFloat32(6, overrides.ax ?? 0.12, true);
  view.setFloat32(10, overrides.ay ?? -0.34, true);
  view.setFloat32(14, overrides.az ?? 9.79, true);
  view.setUint32(18, overrides.sequence ?? 42, true);

  return bytes;
}

test('parses a valid 22-byte packet', () => {
  const sample = parsePacket(buildPacket({}), 1000);

  assert.ok(sample);
  assert.equal(sample.timestamp, 123456);
  assert.ok(Math.abs(sample.ax - 0.12) < 1e-5);
  assert.ok(Math.abs(sample.ay - -0.34) < 1e-5);
  assert.ok(Math.abs(sample.az - 9.79) < 1e-5);
  assert.equal(sample.sequence, 42);
  assert.equal(sample.rxAt, 1000);
});

test('rejects a truncated packet (the MTU-not-negotiated case)', () => {
  const truncated = buildPacket({}).slice(0, 20);
  assert.equal(parsePacket(truncated), null);
});

test('rejects a packet with the wrong magic byte', () => {
  assert.equal(parsePacket(buildPacket({ magic: 0x00 })), null);
});

test('rejects a packet with an unknown version byte', () => {
  assert.equal(parsePacket(buildPacket({ version: 0x03 })), null);
});

function buildPacketV2(o: { jitterUs?: number; flags?: number; txDropped?: number } = {}): Uint8Array {
  const bytes = new Uint8Array(42);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 0x56);
  view.setUint8(1, 0x02);
  view.setUint8(2, o.flags ?? 0x08);
  view.setUint8(3, o.txDropped ?? 3);
  view.setUint32(4, 5_000_000, true);
  view.setUint32(8, 777, true);
  view.setInt16(12, o.jitterUs ?? -250, true);
  [0.12, -0.34, 9.79, 0.01, -0.02, 0.03, 26.5].forEach((v, i) => view.setFloat32(14 + 4 * i, v, true));
  return bytes;
}

test('parses a valid 42-byte v2 packet, all 14 fields', () => {
  const s = parsePacket(buildPacketV2(), 1000);
  assert.ok(s);
  assert.equal(s.version, 2);
  assert.equal(s.flags, 0x08);
  assert.equal(s.txDropped, 3);
  assert.equal(s.timestamp, 5_000_000);
  assert.equal(s.sequence, 777);
  assert.equal(s.jitterUs, -250); // signed: a read can finish early
  assert.ok(Math.abs(s.ax - 0.12) < 1e-5 && Math.abs(s.az - 9.79) < 1e-5);
  assert.ok(Math.abs(s.gx! - 0.01) < 1e-5 && Math.abs(s.gz! - 0.03) < 1e-5);
  assert.ok(Math.abs(s.tempC! - 26.5) < 1e-4);
  assert.equal(s.rxAt, 1000);
});

test('v1 samples carry no gyro/temperature (undefined, never 0)', () => {
  const s = parsePacket(buildPacket({}));
  assert.ok(s);
  assert.equal(s.version, 1);
  assert.equal(s.gx, undefined);
  assert.equal(s.tempC, undefined);
});

test('rejects wrong lengths for each version', () => {
  assert.equal(parsePacket(buildPacketV2().slice(0, 41)), null);
  assert.equal(parsePacket(buildPacketV2().slice(0, 22)), null); // v2 header, v1 length
  assert.equal(parsePacket(new Uint8Array([0x56])), null);
  assert.equal(parsePacket(new Uint8Array(0)), null);
});
