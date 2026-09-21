# VBT Sensor — Mobile (Android)

React Native (Expo) app that connects to the VBT ESP32-S3 over BLE, subscribes to its
accelerometer data characteristic, and shows the live stream of samples on screen.

See [PLAN.md](./PLAN.md) for the full design/spec this app was built against.

## Prerequisites

- Node.js and npm.
- **A physical Android device.** BLE does not work on the Android emulator — you need a real
  phone with USB debugging enabled (or over Wi-Fi via `adb`).
- Android SDK + a JDK, for the native build (`expo prebuild` / `expo run:android`). Not needed
  just to read/edit the TypeScript source.
- The ESP32-S3 flashed with the firmware in `../../firmware` and powered on.

BLE is native code, so **this app does not run in Expo Go** — it needs a dev client build.

## Running it

```bash
npm install
npx expo prebuild --platform android   # generates the android/ folder (CNG)
npx expo run:android                   # builds and installs the dev client on a connected device
```

For subsequent runs, once the dev client is installed on the device:

```bash
npx expo start
```

## Verifying without building

```bash
npx tsc --noEmit   # typecheck
npm test           # runs src/protocol.test.ts (the packet parser, no hardware needed)
npx expo lint      # lint
```

## The wire protocol (VBT Protocol v1)

22 bytes, little-endian, no padding. Source of truth: `../../firmware/src/main.cpp`.

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 1 | `magic` | uint8 | Always `0x56` |
| 1 | 1 | `version` | uint8 | Always `0x01` |
| 2 | 4 | `timestamp` | uint32 LE | `micros()` since ESP32 boot; overflows ~every 71.6 min |
| 6 | 4 | `accelX` | float32 LE | m/s² |
| 10 | 4 | `accelY` | float32 LE | m/s² |
| 14 | 4 | `accelZ` | float32 LE | m/s² |
| 18 | 4 | `sequence` | uint32 LE | Increments from 0 on every ESP32 boot |

BLE identifiers:

- Device name: `VBT-ESP32`
- Service UUID: `4fafc201-1fb5-459e-8fcc-c5c9c331914b`
- Characteristic UUID: `beb5483e-36e1-4688-b7f5-ea07361b26a8` (READ + NOTIFY, no WRITE)

⚠️ The default BLE MTU (23 bytes) only fits 20 payload bytes — too small for this 22-byte packet.
The app requests MTU 247 on connect; if negotiation gives less than 25 bytes, it shows an error
instead of silently parsing truncated data.

## Hardware validation checklist

The app's own test suite (`npm test`) only covers the packet parser. To validate the full path
against real hardware:

1. Flash the firmware, open the serial monitor — you should see `SEQ=… | AX=… | AY=… | AZ=…` lines.
2. Open the app → **Scan for devices** → `VBT-ESP32` should appear in the list.
3. Tap it to connect → the log should fill in, with `AZ ≈ 9.8` while the sensor sits flat and still.
4. Cross-check a few values in the app against the same `sequence` in the serial monitor — they
   should match.
5. `rate` in the stats row should read ~1 Hz with the firmware as shipped
   (`SAMPLE_INTERVAL_US = 1000000`).
6. `lost` should stay at 0 with the device close by.
7. Turn on **Show raw hex** — every row's first two bytes should read `56 01`.
8. Walk away until the connection drops — the app should show `Device disconnected` and return to
   the scan screen without crashing.

## What's intentionally not here

Charts, VBT/velocity metrics, session recording, CSV export, iOS, and any BLE write/configuration
UI are out of scope for this MVP — the characteristic doesn't support WRITE, and the goal here is
just to see the raw stream. See PLAN.md's "Fuera de scope" section.
