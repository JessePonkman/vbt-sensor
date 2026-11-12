// Everything app-wide: the BLE connection state machine (was App.tsx's local
// state), the sample buffer + 100ms ticker (was useVbtStream.ts), and set
// recording, wired through the vbt.ts processor. Two contexts instead of one
// so the 100ms tick doesn't re-render Set/Candles, which only read a frozen
// snapshot published once at End set — see PLAN-V2.md §3.3.
//
// The old `key={sessionId}` remount-to-reset trick doesn't survive the
// provider sitting above the router (remounting it would remount every
// screen), so reset() is explicit instead — see PLAN-V2.md §3.4.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Device, State as AdapterState } from 'react-native-ble-plx';
import { connectAndPrepare, manager, monitorSamples, requestBlePermissions } from './ble';
import { parsePacket, SERVICE_UUID, type VbtSample } from './protocol';
import { SIM_HZ, simulateSquatSession } from './sim';
import { analyzeSet } from './reps';
import { createVbtProcessor, type LiveState, type RawSample, type Rep, type RejectedRep } from './vbt';

export type LogRow =
  | { key: string; kind: 'sample'; sample: VbtSample }
  | { key: string; kind: 'gap'; afterSequence: number; count: number };

export type StreamStats = { packets: number; malformed: number; lost: number; rateHz: number };

export type SetData = {
  id: number;
  startedAt: number; // Date.now() when Start set was pressed
  durationMs: number;
  reps: Rep[];
  rejected: RejectedRep[];
  meanVelocity: number; // mean of per-rep concentric means
  meanAccel: number; // mean concentric acceleration (peak v / time-to-peak) across reps
  t: number[];
  ax: number[];
  ay: number[];
  az: number[];
  v: number[]; // corrected velocity, exactly reproducing the rep table (PLAN-V2.md §4.3)
};

type AppState = 'idle' | 'scanning' | 'connecting' | 'connected';
const SCAN_TIMEOUT_MS = 10_000;
const LOG_SIZE = 200;
const TICK_MS = 100;
const RATE_WINDOW_MS = 1000;
const LIVE_WINDOW_S = 3;
const REP_COUNT_EVERY_MS = 2000;

// --- ConnCtx: changes only on user action / BLE event ----------------------

type ConnState = {
  appState: AppState;
  adapterState: AdapterState;
  permissionDenied: boolean;
  notice: string | null;
  devices: Device[];
  device: Device | null;
  rssi: number | null;
  sets: SetData[];
  isRecording: boolean;
  demo: boolean; // true while replaying the built-in simulator instead of a BLE sensor
};

type ConnActions = {
  scan: () => void;
  select: (device: Device) => void;
  disconnect: () => void;
  startSet: () => void;
  endSet: () => void;
  recalibrate: () => void;
  startDemo: () => void;
  stopDemo: () => void;
};

const ConnCtx = createContext<(ConnState & ConnActions) | null>(null);

export function useConn() {
  const ctx = useContext(ConnCtx);
  if (!ctx) throw new Error('useConn() outside <VbtProvider>');
  return ctx;
}

// --- LiveCtx: republished every 100ms ---------------------------------------

type LiveWindow = { t: number[]; ax: number[]; ay: number[]; az: number[]; a: number[]; v: number[] };

type LiveTick = {
  rows: LogRow[];
  stats: StreamStats;
  paused: boolean;
  live: LiveState;
  win: LiveWindow;
  repCount: number;
  setElapsedMs: number;
  streamError: string | null;
};

const EMPTY_STATS: StreamStats = { packets: 0, malformed: 0, lost: 0, rateHz: 0 };
const EMPTY_LIVE: LiveState = { calibrated: false, still: false, state: 'idle', aVert: 0, vVert: 0 };
const EMPTY_WIN: LiveWindow = { t: [], ax: [], ay: [], az: [], a: [], v: [] };
const EMPTY_TICK: LiveTick = {
  rows: [],
  stats: EMPTY_STATS,
  paused: false,
  live: EMPTY_LIVE,
  win: EMPTY_WIN,
  repCount: 0,
  setElapsedMs: 0,
  streamError: null,
};

const LiveCtx = createContext<LiveTick & { togglePause: () => void }>({ ...EMPTY_TICK, togglePause: () => {} });

export function useLive() {
  return useContext(LiveCtx);
}

// --- buffer -----------------------------------------------------------------

type Recording = { id: number; startedAt: number; samples: RawSample[]; repCount: number };

function freshBuffer() {
  return {
    rows: [] as LogRow[],
    lastSeq: null as number | null,
    packets: 0,
    malformed: 0,
    lost: 0,
    rxTimes: [] as number[],
    win: { t: [] as number[], ax: [] as number[], ay: [] as number[], az: [] as number[], a: [] as number[], v: [] as number[] },
    proc: createVbtProcessor(),
    rec: null as Recording | null,
    nextSetId: 1,
  };
}

export function VbtProvider({ children }: { children: React.ReactNode }) {
  const [adapterState, setAdapterState] = useState<AdapterState>(AdapterState.Unknown);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [appState, setAppState] = useState<AppState>('idle');
  const [scannedDevices, setScannedDevices] = useState<Map<string, Device>>(new Map());
  const [device, setDevice] = useState<Device | null>(null);
  const [rssi, setRssi] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sets, setSets] = useState<SetData[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [demo, setDemo] = useState(false);

  const [tick, setTick] = useState<LiveTick>(EMPTY_TICK);
  const [paused, setPaused] = useState(false);

  const buf = useRef(freshBuffer());
  const scanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalDisconnectRef = useRef(false);
  const deviceRef = useRef<Device | null>(null);
  const pausedRef = useRef(false);
  const lastCountAt = useRef(0);

  // Refs are only for the unmount-cleanup and 100ms-ticker effects below to
  // read the latest value without depending on it — never mutate a ref
  // during render itself.
  useEffect(() => {
    deviceRef.current = device;
  }, [device]);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const reset = useCallback(() => {
    buf.current = freshBuffer();
    setTick(EMPTY_TICK);
  }, []);

  // Adapter power state — scanning/connecting only make sense while PoweredOn.
  useEffect(() => {
    const subscription = manager.onStateChange(setAdapterState, true);
    return () => subscription.remove();
  }, []);

  // Unmount cleanup only, via refs so it doesn't need to re-run per connection.
  useEffect(() => {
    return () => {
      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
      manager.stopDeviceScan();
      deviceRef.current?.cancelConnection().catch(() => {});
    };
  }, []);

  const scan = useCallback(async () => {
    setNotice(null);
    if (adapterState !== AdapterState.PoweredOn) return;

    const granted = await requestBlePermissions();
    setPermissionDenied(!granted);
    if (!granted) return;

    setScannedDevices(new Map());
    setAppState('scanning');

    manager.startDeviceScan([SERVICE_UUID], null, (error, found) => {
      if (error) {
        setNotice(error.message);
        setAppState('idle');
        return;
      }
      if (found) setScannedDevices((prev) => new Map(prev).set(found.id, found));
    });

    if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
    scanTimeoutRef.current = setTimeout(() => {
      manager.stopDeviceScan();
      setAppState((current) => (current === 'scanning' ? 'idle' : current));
    }, SCAN_TIMEOUT_MS);
  }, [adapterState]);

  const select = useCallback(
    (picked: Device) => {
      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
      manager.stopDeviceScan();
      setNotice(null);
      setAppState('connecting');

      connectAndPrepare(picked.id).then(
        (prepared) => {
          intentionalDisconnectRef.current = false;
          reset();
          setRssi(picked.rssi);
          setDevice(prepared);
          setSets([]);
          setIsRecording(false);
          setAppState('connected');

          prepared.onDisconnected(() => {
            setDevice(null);
            setAppState('idle');
            if (!intentionalDisconnectRef.current) setNotice('Device disconnected');
          });
        },
        (error) => {
          setNotice(error instanceof Error ? error.message : 'Connection failed');
          setAppState('idle');
        }
      );
    },
    [reset]
  );

  const startDemo = useCallback(() => {
    setNotice(null);
    reset();
    setSets([]);
    setIsRecording(false);
    setDemo(true);
    setAppState('connected');
  }, [reset]);

  const stopDemo = useCallback(() => {
    setDemo(false);
    setIsRecording(false);
    setAppState('idle');
    setNotice(null);
  }, []);

  const disconnect = useCallback(() => {
    if (demo) {
      stopDemo();
      return;
    }
    if (!device) return;
    intentionalDisconnectRef.current = true;
    device.cancelConnection().catch(() => {});
  }, [device, demo, stopDemo]);

  const startSet = useCallback(() => {
    if (buf.current.rec) return;
    buf.current.rec = { id: buf.current.nextSetId++, startedAt: Date.now(), samples: [], repCount: 0 };
    setIsRecording(true);
  }, []);

  const endSet = useCallback(() => {
    const rec = buf.current.rec;
    buf.current.rec = null;
    setIsRecording(false);
    if (!rec || rec.samples.length === 0) return;

    // Re-analyze the full recorded sample array in one batch pass, fresh —
    // this is what makes the table and the velocity chart exactly agree
    // (PLAN-V2.md §4.3), rather than reconciling the live estimate. The
    // displacement-based detector (reps.ts) is used here: the streaming FSM in
    // vbt.ts reads slow reps as "still" and misses them (see scripts/bench.ts).
    const { reps, rejected, session } = analyzeSet(rec.samples);
    const conMeans = reps.map((r) => r.meanConcentricVelocity);
    const conAccels = reps.map((r) => r.peakConcentricVelocity / Math.max(0.001, r.timeToPeakMs / 1000));

    setSets((prev) => [
      ...prev,
      {
        id: rec.id,
        startedAt: rec.startedAt,
        durationMs: session.t.length > 0 ? (session.t[session.t.length - 1] - session.t[0]) * 1000 : 0,
        reps,
        rejected,
        meanVelocity: conMeans.length > 0 ? conMeans.reduce((a, b) => a + b, 0) / conMeans.length : 0,
        meanAccel: conAccels.length > 0 ? conAccels.reduce((a, b) => a + b, 0) / conAccels.length : 0,
        t: session.t,
        ax: session.ax,
        ay: session.ay,
        az: session.az,
        v: session.v,
      },
    ]);
  }, []);

  const recalibrate = useCallback(() => {
    buf.current.proc.reset();
  }, []);

  // The single entry point for a decoded packet, whatever produced it (BLE
  // notification or the demo simulator). Everything downstream — the loss
  // counter, the live window, the VBT processor, set recording — is shared,
  // so demo mode exercises exactly the code a real sensor would.
  const ingest = useCallback((sample: VbtSample) => {
    const last = buf.current.lastSeq;
    if (last !== null && sample.sequence > last + 1) {
      const gap = sample.sequence - last - 1;
      buf.current.lost += gap;
      buf.current.rows.push({ key: `gap-${last}`, kind: 'gap', afterSequence: last, count: gap });
    }
    // sample.sequence <= last means the ESP32 rebooted (its counter
    // restarts at 0) — just resync below instead of counting loss.
    buf.current.lastSeq = sample.sequence;

    buf.current.packets += 1;
    buf.current.rxTimes.push(sample.rxAt);

    buf.current.rows.push({ key: String(sample.sequence), kind: 'sample', sample });
    if (buf.current.rows.length > LOG_SIZE) buf.current.rows.splice(0, buf.current.rows.length - LOG_SIZE);

    buf.current.proc.push(sample);
    const live = buf.current.proc.live;
    buf.current.proc.takeReps(); // drain the streaming FSM's reps; the set's real numbers come from analyzeSet
    if (buf.current.rec) buf.current.rec.samples.push(sample);

    const win = buf.current.win;
    win.t.push(sample.rxAt / 1000);
    win.ax.push(sample.ax);
    win.ay.push(sample.ay);
    win.az.push(sample.az);
    win.a.push(live.aVert);
    win.v.push(live.vVert);
    const cutoff = sample.rxAt / 1000 - LIVE_WINDOW_S;
    let cut = 0;
    while (cut < win.t.length && win.t[cut] < cutoff) cut++;
    if (cut > 0) {
      win.t.splice(0, cut);
      win.ax.splice(0, cut);
      win.ay.splice(0, cut);
      win.az.splice(0, cut);
      win.a.splice(0, cut);
      win.v.splice(0, cut);
    }
  }, []);

  // Subscribe to the connected device's notifications.
  useEffect(() => {
    if (!device) return;

    const subscription = monitorSamples(
      device,
      (bytes) => {
        const sample = parsePacket(bytes);
        if (!sample) {
          buf.current.malformed += 1;
          return;
        }
        ingest(sample);
      },
      (error) => setNotice(error.message)
    );

    return () => subscription.remove();
  }, [device, ingest]);

  // Demo mode: replay a simulated session (walkout -> set -> re-rack) at real
  // time, 100 Hz, through the same ingest() path as real BLE packets.
  useEffect(() => {
    if (!demo) return;

    const { samples } = simulateSquatSession();
    const startedAt = Date.now();
    let next = 0;

    const interval = setInterval(() => {
      const now = Date.now();
      const due = Math.floor(((now - startedAt) / 1000) * SIM_HZ);
      while (next < samples.length && samples[next].sequence <= due) {
        const s = samples[next++];
        // rxAt is stamped at "arrival": derive it from the sample's own slot so
        // a late timer tick doesn't bunch packets up and distort the Hz readout.
        ingest({ ...s, version: 2, rxAt: startedAt + s.sequence * (1000 / SIM_HZ), raw: new Uint8Array(0) });
      }
      if (next >= samples.length) {
        clearInterval(interval);
        setNotice('Demo terminada');
      }
    }, 20);

    return () => clearInterval(interval);
  }, [demo, ingest]);

  // Publish buffer -> state at 10fps, independent of the incoming packet rate.
  useEffect(() => {
    if (!device && !demo) return;

    const interval = setInterval(() => {
      const cutoff = Date.now() - RATE_WINDOW_MS;
      buf.current.rxTimes = buf.current.rxTimes.filter((t) => t >= cutoff);
      const rateHz = buf.current.rxTimes.length / (RATE_WINDOW_MS / 1000);
      const live = buf.current.proc.live;
      const rec = buf.current.rec;

      // Live rep counter: re-run the batch detector over the set so far every
      // 2 s (~3 ms for a typical set on a laptop). A rep counts once it is
      // complete, so the number lags the lifter by about a rep's tail.
      if (rec && Date.now() - lastCountAt.current >= REP_COUNT_EVERY_MS) {
        lastCountAt.current = Date.now();
        rec.repCount = analyzeSet(rec.samples).reps.length;
      }

      setTick((prev) => ({
        rows: pausedRef.current ? prev.rows : [...buf.current.rows].reverse(),
        stats: { packets: buf.current.packets, malformed: buf.current.malformed, lost: buf.current.lost, rateHz },
        paused: pausedRef.current,
        live,
        win: {
          t: [...buf.current.win.t],
          ax: [...buf.current.win.ax],
          ay: [...buf.current.win.ay],
          az: [...buf.current.win.az],
          a: [...buf.current.win.a],
          v: [...buf.current.win.v],
        },
        repCount: rec ? rec.repCount : 0,
        setElapsedMs: rec ? Date.now() - rec.startedAt : 0,
        streamError: null,
      }));
    }, TICK_MS);

    return () => clearInterval(interval);
  }, [device, demo]);

  const togglePause = useCallback(() => setPaused((p) => !p), []);

  const devices = useMemo(
    () => Array.from(scannedDevices.values()).sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)),
    [scannedDevices]
  );

  const connValue = useMemo<ConnState & ConnActions>(
    () => ({
      appState,
      adapterState,
      permissionDenied,
      notice,
      devices,
      device,
      rssi,
      sets,
      isRecording,
      demo,
      scan,
      select,
      disconnect,
      startSet,
      endSet,
      recalibrate,
      startDemo,
      stopDemo,
    }),
    [appState, adapterState, permissionDenied, notice, devices, device, rssi, sets, isRecording, demo, scan, select, disconnect, startSet, endSet, recalibrate, startDemo, stopDemo]
  );

  return (
    <ConnCtx.Provider value={connValue}>
      <LiveCtx.Provider value={{ ...tick, togglePause }}>{children}</LiveCtx.Provider>
    </ConnCtx.Provider>
  );
}
