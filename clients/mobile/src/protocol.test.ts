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

test('rejects a packet with the wrong version byte', () => {
  assert.equal(parsePacket(buildPacket({ version: 0x02 })), null);
});
