# VBT Sensor — Mobile

React Native (Expo) app for velocity-based training with the VBT ESP32-S3 sensor: record a
set between your own Start / End marks, then review it — reps, mean and peak velocity,
velocity loss, range of motion, charts — and keep a history on the phone. Back squat for now.

Runs on Android (the target) and iOS from the same code; the browser version is a preview
that uses the built-in simulator instead of the sensor.

See [BENCH.md](./BENCH.md) for how well reps are detected and what that does and does not
prove, and [PLAN-V2.md](./PLAN-V2.md) / [PLAN.md](./PLAN.md) for the original design notes
(older than the current screens).

## Quick start

```bash
npm ci            # exactly the versions in package-lock.json
npm test          # 64 tests, no hardware needed
npx expo start --web    # look at the app in a browser (simulator instead of the sensor)
```

Use `npm ci`. **Do not run `npm install --legacy-peer-deps`**: it silently drops packages the
app needs (`expo-linking`, the Babel preset, ...) and the bundle then fails. To add a package,
use `npx expo install <package> -- --force`.

## On a phone

- **A physical device.** BLE does not work in an emulator or a browser.
- Android SDK and a JDK for the native build (React Native expects JDK 17).
- The ESP32-S3 flashed with the firmware in `../../firmware` (protocol v2) and powered on.

BLE and the file system are native code, so **this app does not run in Expo Go** — it needs
a development build:

```bash
npx expo prebuild --platform android   # generates the android/ folder (CNG)
npx expo run:android                   # builds and installs the dev client on a connected device
```

⚠️ **This iteration added native modules** (`expo-file-system`, `expo-sharing`,
`expo-system-ui`; before that `expo-router`, `react-native-safe-area-context`,
`react-native-screens`, `react-native-svg`). An older dev client will fail at runtime with a
missing-native-module error: rebuild it with `npx expo run:android`.

Once the dev client is installed, `npx expo start` is enough.

**Nothing in this repo has been run on a physical phone yet** — Bluetooth, saving to disk and
the share sheet are covered by types, tests and a bundle build, not by a device. The first
session on real hardware is the real test.

## Verifying without building

```bash
npx tsc --noEmit   # typecheck
npm test           # protocol, detector, orientation, storage, simulator — no hardware needed
npx expo lint      # lint
```

`src/vbt.test.ts` is the important one: it feeds a deterministic synthetic squat (with sensor
noise, an arbitrary mounting orientation, and a dropped-packet gap) through the exact same
`vbt.ts` pipeline the app uses, and checks that recovered peak/mean velocity and ROM land within a
few percent of the analytically known ground truth. Read it before touching `vbt.ts` §2's math.

## How reps are detected, and how that is measured

Reps are found by `src/reps.ts`, a batch detector over the recorded set: it reads
the bar's *displacement* (double-integrated, high-passed), so a 6 s grinding PR, a
4 s tempo descent and a long bottom pause are found like a fast rep. The streaming
state machine in `src/vbt.ts` is still used for the live velocity trace, but it
reads slow, uniform motion as "still" and misses those reps. With protocol v2 the
gyroscope is fused (Mahony filter, `src/orientation.ts`, ported from
`clients/desktop/imu.py` and checked against it on a real recording) to track the
bar's tilt.

```bash
npm run bench           # 17 hand-picked scenarios + the real recordings, before/after
npm run bench:random    # 600 randomized sessions
npm run bench:final     # a fresh randomized dataset + the author's own generator
```

The results are in `BENCH.md`, including what they do **not** prove. In short: on
simulated data the new detector finds ~99.5% of reps (the old one ~2%), and the
peak velocity is within ~3%; mean velocity reads ~9-18% high because of how the
start and end of the ascent are defined.

## The wire protocol (VBT Protocol v1 and v2)

The app parses both versions (dispatching on byte 1). v2 is 42 bytes: flags,
txDropped, scheduled timestamp, sequence, jitter, accel, gyro, temperature; see
`src/protocol.ts` for the layout. The description below is v1.

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

⚠️ The default BLE MTU (23 bytes) only fits 20 payload bytes — too small for these packets.
The app requests MTU 247 on connect; if negotiation gives less than 45 bytes (a 42-byte v2
packet plus the ATT header), it shows an error instead of silently parsing truncated data.

## Screens

The app is for **reviewing a set afterwards**, not for live feedback. Three tabs (Expo
Router, routes under `src/app/`), plus the set detail:

- **Grabar** — connect the sensor (or try the built-in simulator, "modo demo"), optionally type
  the load in kg, tap **Marcar inicio** with the bar still, do the set, tap **Marcar fin** with
  the bar up and still. Nothing starts or stops by itself, so the analysis gets exactly the
  window the lifter meant. While recording only a timer and "data arriving" are shown.
- **Detalle de la serie** (`set/[id]`, opened right after *Marcar fin* and from the history) —
  headline numbers (reps, best mean velocity, velocity loss, range of motion, times), one bar per
  rep coloured by how far it fell below the best rep, the whole velocity curve with each rep
  shaded and numbered, and the rep table. Tapping a rep in a chart or the table highlights it in
  all three. Edit the load and a note, share the raw CSV, re-analyze or delete the set.
- **Historial** — every set saved on the phone, newest first.
- **Ajustes** — appearance (automatic / light for sun / dark) and the raw packet view.

Each recorded set is saved on the phone as `<id>.csv` (raw samples, **the same 13-column format
as `clients/desktop`**, so it opens in the desktop tool and desktop recordings import) and
`<id>.json` (metadata + analysis). See `src/session.ts` and `src/store.ts`.

### Trying it in a browser

The same app runs in a browser, with the simulator standing in for the sensor and
`localStorage` standing in for the file system (`src/ble.web.ts`, `src/store.web.ts`):

```bash
npx expo start --web
```

It is the quickest way to look at the screens at any window size. "Cargar series de ejemplo" in
the history fills it with simulated sets. It does not replace testing on a phone: Bluetooth,
the file system and sharing only exist there.

### Layout

One column up to ~760 dp, centred; from 900 dp the detail splits into charts on the left and
numbers on the right (`src/responsive.ts`). Controls are at least 52 dp tall. Light theme is
pure white with near-black text for direct sun.

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
