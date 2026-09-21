// Thin BLE layer over react-native-ble-plx: permissions, connect+MTU, and
// characteristic monitoring. Scanning and the adapter-state subscription are
// already one-liners on `manager` — no point wrapping those too.

import { Linking, PermissionsAndroid, Platform } from 'react-native';
import { BleError, BleManager, Device, Subscription } from 'react-native-ble-plx';
import { CHARACTERISTIC_UUID, SERVICE_UUID } from './protocol';

export const manager = new BleManager();

// 22-byte packet + 3-byte ATT header. Below this, notifications get truncated.
const MIN_USABLE_MTU = 25;
const REQUESTED_MTU = 247;

export async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;

  if (Platform.Version >= 31) {
    const granted = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return (
      granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED &&
      granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED
    );
  }

  const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  return granted === PermissionsAndroid.RESULTS.GRANTED;
}

export function openAppSettings(): void {
  Linking.openSettings();
}

/** Connects, negotiates MTU, and discovers services/characteristics.
 * Throws if the negotiated MTU can't fit a 22-byte packet (see PLAN.md §1.2a). */
export async function connectAndPrepare(deviceId: string): Promise<Device> {
  const connected = await manager.connectToDevice(deviceId, { requestMTU: REQUESTED_MTU });

  if (connected.mtu < MIN_USABLE_MTU) {
    await connected.cancelConnection().catch(() => {});
    throw new Error(`MTU negotiation failed (got ${connected.mtu}). Packets will be truncated.`);
  }

  return connected.discoverAllServicesAndCharacteristics();
}

/** Subscribes to the VBT data characteristic. `onPacket` receives the raw
 * decoded bytes — parsing/validation happens in protocol.ts. */
export function monitorSamples(
  device: Device,
  onPacket: (bytes: Uint8Array) => void,
  onError: (error: BleError) => void
): Subscription {
  return device.monitorCharacteristicForService(SERVICE_UUID, CHARACTERISTIC_UUID, (error, characteristic) => {
    if (error) {
      onError(error);
      return;
    }
    if (characteristic?.value) {
      onPacket(base64ToBytes(characteristic.value));
    }
  });
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// react-native-ble-plx hands back characteristic values as base64 strings.
// React Native has no global `atob`/`Buffer`, so decode by hand rather than
// pull in a dependency for it.
function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of clean) {
    const value = BASE64_CHARS.indexOf(char);
    if (value === -1) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return Uint8Array.from(bytes);
}
