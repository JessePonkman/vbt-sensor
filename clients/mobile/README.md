# VBT Sensor — Mobile (Android)

React Native (Expo) app that connects to the VBT ESP32-S3 over BLE, subscribes to its
accelerometer data characteristic, integrates it into bar velocity, and shows live and
per-set velocity-based-training metrics for the back squat.

See [PLAN-V2.md](./PLAN-V2.md) for the full design/spec this iteration was built against
(and [PLAN.md](./PLAN.md) for the original raw-stream MVP it replaces).

## Prerequisites

- Node.js and npm.
- **A physical Android device.** BLE does not work on the Android emulator — you need a real
  phone with USB debugging enabled (or over Wi-Fi via `adb`).
- Android SDK + a JDK, for the native build (`expo prebuild` / `expo run:android`). Not needed
  just to read/edit the TypeScript source.
- The ESP32-S3 flashed with the firmware in `../../firmware` (100 Hz as of this iteration) and
  powered on.

BLE is native code, so **this app does not run in Expo Go** — it needs a dev client build.

## Running it

```bash
npm install
npx expo prebuild --platform android   # generates the android/ folder (CNG)
npx expo run:android                   # builds and installs the dev client on a connected device
```

⚠️ **This iteration added native modules** (`expo-router`, `react-native-safe-area-context`,
`react-native-screens`, `react-native-svg`). If you have an older dev client installed, rebuild it
with `npx expo run:android` again — `npx expo start` alone against a stale client will fail at
runtime with a missing-native-module error.

For subsequent runs, once the dev client is installed on the device:

```bash
npx expo start
```

## Verifying without building

```bash
npx tsc --noEmit   # typecheck
npm test           # runs src/protocol.test.ts and src/vbt.test.ts — no hardware needed
npx expo lint      # lint
```

`src/vbt.test.ts` is the important one: it feeds a deterministic synthetic squat (with sensor
noise, an arbitrary mounting orientation, and a dropped-packet gap) through the exact same
`vbt.ts` pipeline the app uses, and checks that recovered peak/mean velocity and ROM land within a
few percent of the analytically known ground truth. Read it before touching `vbt.ts` §2's math.

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

## Screens

Four tabs (Expo Router, routes under `src/app/`):

- **Live** — scan/connect when disconnected; once connected, calibration status, Start/End set,
  and live acceleration + velocity charts (last 3 s, approximate).
- **Serie** — the last completed set: full acceleration + velocity charts and the per-rep table
  (eccentric/concentric peak and mean velocity).
- **Velas** — one candle per rep of the last set, eccentric and concentric, showing min/max/mean
  velocity per phase.
- **Raw** — the original debug view: the raw sample log with the hex toggle.

Calibration is automatic: hold the bar still for about a second and the app resolves gravity from
whatever angle the sensor happens to be taped on at. There's no calibration button — the "Iniciar
serie" button just waits for `calibrated` to go true.

## Hardware validation checklist

Extends the original MVP's checklist with the velocity pipeline. The agent implementing this
cannot run any of it — it's for you, after flashing and connecting.

1. Serial monitor: `SEQ` should advance by `SERIAL_DEBUG_EVERY` (50) each printed line, and the
   `TIME` delta between consecutive printed lines should be `SERIAL_DEBUG_EVERY × 10000 µs ± 5%`.
   **If the delta is bigger than that, the 100 Hz loop isn't keeping up** — lower the rate or raise
   `SERIAL_DEBUG_EVERY` before debugging anything else.
2. App → Scan → connect. **Raw** tab: `rate` should read ~100 Hz (not the old ~1 Hz), `lost` ≈ 0,
   `malformed` = 0.
3. Sensor still on a table, **Live** tab: "Mantené quieto" disappears within ~1 s on its own. Live
   velocity should sit at 0.00 and **not drift** watching it for 30 s. If it drifts, `STILL_ACC_RMS`
   in `vbt.ts`'s tuning table probably needs raising.
4. Lift the sensor 30 cm by hand and set it back down: the acceleration chart should move, the
   velocity chart should pulse and **return to zero**. If it doesn't return to zero, ZUPT isn't
   firing — see PLAN-V2.md §2.4.
5. Tape the sensor to the bar **at a visibly crooked angle** (this is the actual design case).
   Repeat step 3 — calibration should work exactly the same.
6. Start set → 5 back squats → End set. **Serie** tab: 5 reps in the table. Concentric ROM should
   resemble the real squat depth (~0.4–0.6 m for a full squat). **If ROM is systematically high or
   low by a constant factor, that's the MPU6050's accelerometer scale error** (PLAN-V2.md §2.2) —
   the number that justifies a future six-position calibration.
7. Concentric velocities should be plausible for the load used (0.5–1.0 m/s moderate load).
   Eccentric velocities negative.
8. **Velas** tab: 5 candles per chart, concentric ones green above zero, eccentric ones red below.
   With real fatigue, the later concentric candles should trend down (and turn amber past a 20%
   drop from the set's best — the actual point of doing this).
9. Do a walkout and re-rack **without** any reps → **0 reps detected**. Phantom reps mean
   `ROM_MIN_M` / `V_START` in `vbt.ts` need retuning.
10. Walk away until the connection drops → `Device disconnected`, back to the scan screen without
    crashing. Reconnect → everything resets cleanly (fresh calibration, empty log, no leftover set).

**Write down what you observe when you touch any `VBT_TUNING` constant.** The table's comment says
they're starting guesses; turning them into measurements is the point of the first real session.

## What's intentionally not here

Disk persistence, session history across app restarts, CSV export, a backend, auth, iOS, a set
picker (only the most recent set is shown), movements other than the back squat, Mean Propulsive
Velocity, animations, gestures, and chart tooltips/zoom are all out of scope for this iteration.
See PLAN-V2.md's ledger of deliberate shortcuts (§12) for what each of those costs today and what
the upgrade path looks like.
