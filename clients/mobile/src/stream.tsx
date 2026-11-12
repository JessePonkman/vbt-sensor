// Everything app-wide that is not a screen: the sensor connection (BLE, or the
// built-in simulator in demo mode), the live packet statistics, and recording a
// set between the lifter's own Start and End marks.
//
// What this deliberately does NOT do any more: live velocity or live rep
// counting. The app is for reviewing a set afterwards, so while recording the
// only live feedback is "data is arriving" (packet count, rate, losses). The
// set is analyzed once, when End is pressed (reps.ts), saved to the phone
// (store.ts) and opened in the detail screen.
//
// Two contexts, so the 10 Hz statistics tick does not re-render screens that
// only care about the connection.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AdapterState, connectAndPrepare, manager, monitorSamples, requestBlePermissions, type AdapterStateValue, type BleDevice } from './ble';
import { parsePacket, SERVICE_UUID, type VbtSample } from './protocol';
import { buildStoredSet } from './session';
import { SIM_HZ, SIM_SCENARIOS, simulateSquatSession } from './sim';
import { saveSet } from './store';
import type { RawSample } from './vbt';

export type LogRow =
  | { key: string; kind: 'sample'; sample: VbtSample }
  | { key: string; kind: 'gap'; afterSequence: number; count: number };

export type StreamStats = { packets: number; malformed: number; lost: number; rateHz: number };

type AppState = 'idle' | 'scanning' | 'connecting' | 'connected';
const SCAN_TIMEOUT_MS = 10_000;
const LOG_SIZE = 200;
const TICK_MS = 100;
const RATE_WINDOW_MS = 1000;

/** The scenarios the demo can replay (the simulator's, minus the walkout ones:
 *  the lifter marks Start after the walkout, as they would in the gym). */
export const DEMO_SCENARIOS = SIM_SCENARIOS.filter((s) => ['normal', 'rapida', 'pausa_larga', 'tempo_pausa', 'rebote_brusco', 'limite', 'fatiga'].includes(s.id));

export type EndResult = { ok: true; id: string } | { ok: false; error: string };

// --- ConnCtx: changes only on user action / BLE event ----------------------

type ConnState = {
  appState: AppState;
  adapterState: AdapterStateValue;
  permissionDenied: boolean;
  notice: string | null;
  devices: BleDevice[];
  device: BleDevice | null;
  rssi: number | null;
  demo: boolean;
  demoScenario: string;
  isRecording: boolean;
};

type ConnActions = {
  scan: () => void;
  select: (device: BleDevice) => void;
  disconnect: () => void;
  startDemo: (scenarioId?: string) => void;
  stopDemo: () => void;
  /** Mark the start of a set: from now on samples belong to it. */
  startSet: () => void;
  /** Mark the end: analyze, save and return the saved set's id. */
  endSet: (meta: { loadKg: number | null; note?: string }) => EndResult;
  /** Throw away the set being recorded. */
  cancelSet: () => void;
};

const ConnCtx = createContext<(ConnState & ConnActions) | null>(null);

export function useConn() {
  const ctx = useContext(ConnCtx);
  if (!ctx) throw new Error('useConn() outside <VbtProvider>');
  return ctx;
}

// --- LiveCtx: republished every 100 ms ---------------------------------------

type LiveTick = { rows: LogRow[]; stats: StreamStats; paused: boolean; setElapsedMs: number; setSamples: number };
const EMPTY_TICK: LiveTick = { rows: [], stats: { packets: 0, malformed: 0, lost: 0, rateHz: 0 }, paused: false, setElapsedMs: 0, setSamples: 0 };
const LiveCtx = createContext<LiveTick & { togglePause: () => void }>({ ...EMPTY_TICK, togglePause: () => {} });

export function useLive() {
  return useContext(LiveCtx);
}

// --- buffer -----------------------------------------------------------------

type Recording = { startedAt: number; samples: RawSample[] };

function freshBuffer() {
  return {
    rows: [] as LogRow[],
    lastSeq: null as number | null,
    packets: 0,
    malformed: 0,
    lost: 0,
    rxTimes: [] as number[],
    rec: null as Recording | null,
  };
}

export function VbtProvider({ children }: { children: React.ReactNode }) {
  const [adapterState, setAdapterState] = useState<AdapterStateValue>(AdapterState.Unknown);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [appState, setAppState] = useState<AppState>('idle');
  const [scanned, setScanned] = useState<Map<string, BleDevice>>(new Map());
  const [device, setDevice] = useState<BleDevice | null>(null);
  const [rssi, setRssi] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [demo, setDemo] = useState(false);
  const [demoScenario, setDemoScenario] = useState('normal');

  const [tick, setTick] = useState<LiveTick>(EMPTY_TICK);
  const [paused, setPaused] = useState(false);

  const buf = useRef(freshBuffer());
  const scanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalDisconnectRef = useRef(false);
  const deviceRef = useRef<BleDevice | null>(null);
  const pausedRef = useRef(false);
  const demoRef = useRef(false);

  useEffect(() => {
    deviceRef.current = device;
  }, [device]);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    demoRef.current = demo;
  }, [demo]);

  const reset = useCallback(() => {
    buf.current = freshBuffer();
    setTick(EMPTY_TICK);
  }, []);

  useEffect(() => {
    const subscription = manager.onStateChange(setAdapterState, true);
    return () => subscription.remove();
  }, []);

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

    setScanned(new Map());
    setAppState('scanning');
    manager.startDeviceScan([SERVICE_UUID], null, (error, found) => {
      if (error) {
        setNotice(error.message);
        setAppState('idle');
        return;
      }
      if (found) setScanned((prev) => new Map(prev).set(found.id, found));
    });
    if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
    scanTimeoutRef.current = setTimeout(() => {
      manager.stopDeviceScan();
      setAppState((current) => (current === 'scanning' ? 'idle' : current));
    }, SCAN_TIMEOUT_MS);
  }, [adapterState]);

  const select = useCallback(
    (picked: BleDevice) => {
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
          setIsRecording(false);
          setAppState('connected');
          prepared.onDisconnected(() => {
            setDevice(null);
            setIsRecording(false);
            buf.current.rec = null;
            setAppState('idle');
            if (!intentionalDisconnectRef.current) setNotice('El sensor se desconectó.');
          });
        },
        (error) => {
          setNotice(error instanceof Error ? error.message : 'No se pudo conectar');
          setAppState('idle');
        }
      );
    },
    [reset]
  );

  const startDemo = useCallback(
    (scenarioId = 'normal') => {
      setNotice(null);
      reset();
      setDemoScenario(scenarioId);
      setIsRecording(false);
      setDemo(true);
      setAppState('connected');
    },
    [reset]
  );

  const stopDemo = useCallback(() => {
    setDemo(false);
    setIsRecording(false);
    buf.current.rec = null;
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
    buf.current.rec = { startedAt: Date.now(), samples: [] };
    setIsRecording(true);
  }, []);

  const cancelSet = useCallback(() => {
    buf.current.rec = null;
    setIsRecording(false);
  }, []);

  const endSet = useCallback((meta: { loadKg: number | null; note?: string }): EndResult => {
    const rec = buf.current.rec;
    buf.current.rec = null;
    setIsRecording(false);
    if (!rec || rec.samples.length < SIM_HZ * 2) {
      return { ok: false, error: 'La serie es muy corta (menos de 2 s). Marcá el inicio, hacé la serie y marcá el fin.' };
    }
    try {
      // Every recorded set is kept on the phone (raw CSV + analysis) so it can be
      // reviewed later, compared, exported or re-analyzed.
      const set = buildStoredSet(rec.samples, { source: demoRef.current ? 'demo' : 'sensor', createdAt: rec.startedAt, loadKg: meta.loadKg, note: meta.note });
      saveSet(set, rec.samples);
      return { ok: true, id: set.id };
    } catch (e) {
      return { ok: false, error: `No se pudo guardar la serie: ${e instanceof Error ? e.message : String(e)}` };
    }
  }, []);

  // The single entry point for a decoded packet, whatever produced it (BLE
  // notification or the demo simulator).
  const ingest = useCallback((sample: VbtSample) => {
    const last = buf.current.lastSeq;
    if (last !== null && sample.sequence > last + 1) {
      const gap = sample.sequence - last - 1;
      buf.current.lost += gap;
      buf.current.rows.push({ key: `gap-${last}`, kind: 'gap', afterSequence: last, count: gap });
    }
    // sequence <= last means the ESP32 rebooted (its counter restarts at 0)
    buf.current.lastSeq = sample.sequence;
    buf.current.packets += 1;
    buf.current.rxTimes.push(sample.rxAt);
    buf.current.rows.push({ key: String(sample.sequence), kind: 'sample', sample });
    if (buf.current.rows.length > LOG_SIZE) buf.current.rows.splice(0, buf.current.rows.length - LOG_SIZE);
    if (buf.current.rec) buf.current.rec.samples.push(sample);
  }, []);

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

  // Demo mode: replay a simulated session at real time, 100 Hz, through the
  // same ingest() path as real BLE packets. It is long enough to mark Start
  // after a few seconds of stillness and End after the last rep.
  useEffect(() => {
    if (!demo) return;
    const sc = DEMO_SCENARIOS.find((x) => x.id === demoScenario) ?? DEMO_SCENARIOS[0];
    const { samples } = simulateSquatSession({ ...sc.opts, walkout: false, rerack: false, leadS: 8, trailS: 25, seed: Math.floor(Math.random() * 1e6) });
    const startedAt = Date.now();
    let next = 0;
    const interval = setInterval(() => {
      const due = Math.floor(((Date.now() - startedAt) / 1000) * SIM_HZ);
      while (next < samples.length && samples[next].sequence <= due) {
        const s = samples[next++];
        ingest({ ...s, version: 2, rxAt: startedAt + s.sequence * (1000 / SIM_HZ), raw: new Uint8Array(0) });
      }
      if (next >= samples.length) {
        clearInterval(interval);
        setNotice('La demo terminó. Volvé a iniciarla para otra.');
      }
    }, 20);
    return () => clearInterval(interval);
  }, [demo, demoScenario, ingest]);

  // Publish the buffer -> state at 10 fps, independent of the packet rate.
  useEffect(() => {
    if (!device && !demo) return;
    const interval = setInterval(() => {
      const cutoff = Date.now() - RATE_WINDOW_MS;
      buf.current.rxTimes = buf.current.rxTimes.filter((t) => t >= cutoff);
      const rateHz = buf.current.rxTimes.length / (RATE_WINDOW_MS / 1000);
      const rec = buf.current.rec;
      setTick((prev) => ({
        rows: pausedRef.current ? prev.rows : [...buf.current.rows].reverse(),
        stats: { packets: buf.current.packets, malformed: buf.current.malformed, lost: buf.current.lost, rateHz },
        paused: pausedRef.current,
        setElapsedMs: rec ? Date.now() - rec.startedAt : 0,
        setSamples: rec ? rec.samples.length : 0,
      }));
    }, TICK_MS);
    return () => clearInterval(interval);
  }, [device, demo]);

  const togglePause = useCallback(() => setPaused((p) => !p), []);

  const devices = useMemo(() => Array.from(scanned.values()).sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)), [scanned]);

  const connValue = useMemo<ConnState & ConnActions>(
    () => ({ appState, adapterState, permissionDenied, notice, devices, device, rssi, demo, demoScenario, isRecording, scan, select, disconnect, startDemo, stopDemo, startSet, endSet, cancelSet }),
    [appState, adapterState, permissionDenied, notice, devices, device, rssi, demo, demoScenario, isRecording, scan, select, disconnect, startDemo, stopDemo, startSet, endSet, cancelSet]
  );

  return (
    <ConnCtx.Provider value={connValue}>
      <LiveCtx.Provider value={{ ...tick, togglePause }}>{children}</LiveCtx.Provider>
    </ConnCtx.Provider>
  );
}
