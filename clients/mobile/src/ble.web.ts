// Browser stand-in for ble.ts, used by the web preview. There is no
// Bluetooth sensor in a browser here, so scanning finds nothing and the demo
// mode (the simulator) is the way to try the app. The phone uses ble.ts.

import type { BleError, Device, Subscription } from 'react-native-ble-plx';

export const AdapterState = { Unknown: 'Unknown', Unsupported: 'Unsupported', PoweredOn: 'PoweredOn', PoweredOff: 'PoweredOff' } as const;
export type AdapterStateValue = (typeof AdapterState)[keyof typeof AdapterState];
export type BleDevice = Device;

const none: Subscription = { remove() {} };

export const manager = {
  onStateChange(cb: (s: AdapterStateValue) => void, emitCurrent?: boolean): Subscription {
    if (emitCurrent) cb(AdapterState.Unsupported);
    return none;
  },
  startDeviceScan(): void {},
  stopDeviceScan(): void {},
};

export async function requestBlePermissions(): Promise<boolean> {
  return false;
}

export function openAppSettings(): void {}

export async function connectAndPrepare(): Promise<Device> {
  throw new Error('Bluetooth no está disponible en el navegador. Usá el modo demo.');
}

export function monitorSamples(_device: Device, _onPacket: (b: Uint8Array) => void, _onError: (e: BleError) => void): Subscription {
  return none;
}
