// Buffers incoming BLE notifications outside of React (see PLAN.md §5.2) so a
// 100-200 Hz stream doesn't trigger a re-render per packet. A 100ms ticker
// copies the buffer into state instead.
//
// The hook holds no device-change reset logic: App.tsx mounts a fresh
// instance (via `key={sessionId}`) for every new connection, so a plain
// `useState([])`/`useRef([])` initial value already is the reset. On
// disconnect (device -> null) nothing remounts, so the last log simply stays
// on screen until the next successful connection (PLAN.md §3.2).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BleError, Device } from 'react-native-ble-plx';
import { monitorSamples } from './ble';
import { parsePacket, type VbtSample } from './protocol';

export type LogRow =
  | { key: string; kind: 'sample'; sample: VbtSample }
  | { key: string; kind: 'gap'; afterSequence: number; count: number };

export type StreamStats = {
  packets: number;
  malformed: number;
  lost: number;
  rateHz: number;
};

const LOG_SIZE = 200;
const TICK_MS = 100;
const RATE_WINDOW_MS = 1000;

const EMPTY_STATS: StreamStats = { packets: 0, malformed: 0, lost: 0, rateHz: 0 };

export function useVbtStream(device: Device | null) {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [stats, setStats] = useState<StreamStats>(EMPTY_STATS);
  const [paused, setPaused] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  // ponytail: plain array + splice to 200 items; switch to a ring buffer if
  // the log ever needs to hold thousands of samples.
  const bufferRef = useRef<LogRow[]>([]);
  const lastSequenceRef = useRef<number | null>(null);
  const packetsRef = useRef(0);
  const malformedRef = useRef(0);
  const lostRef = useRef(0);
  const recentRxTimesRef = useRef<number[]>([]);
  const pausedRef = useRef(false);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Subscribe to the connected device's notifications.
  useEffect(() => {
    if (!device) return;

    const subscription = monitorSamples(
      device,
      (bytes) => {
        const sample = parsePacket(bytes);
        if (!sample) {
          malformedRef.current += 1;
          return;
        }

        const last = lastSequenceRef.current;
        if (last !== null && sample.sequence > last + 1) {
          const gap = sample.sequence - last - 1;
          lostRef.current += gap;
          bufferRef.current.push({ key: `gap-${last}`, kind: 'gap', afterSequence: last, count: gap });
        }
        // sample.sequence <= last means the ESP32 rebooted (its counter
        // restarts at 0) — just resync below instead of counting loss.
        lastSequenceRef.current = sample.sequence;

        packetsRef.current += 1;
        recentRxTimesRef.current.push(sample.rxAt);

        bufferRef.current.push({ key: String(sample.sequence), kind: 'sample', sample });
        if (bufferRef.current.length > LOG_SIZE) {
          bufferRef.current.splice(0, bufferRef.current.length - LOG_SIZE);
        }
      },
      (error: BleError) => setStreamError(error.message)
    );

    return () => subscription.remove();
  }, [device]);

  // Publish buffer -> state at 10fps, independent of the incoming packet rate.
  // Only runs while connected; stopped means nothing new is arriving anyway.
  useEffect(() => {
    if (!device) return;

    const interval = setInterval(() => {
      const cutoff = Date.now() - RATE_WINDOW_MS;
      const recent = recentRxTimesRef.current.filter((t) => t >= cutoff);
      recentRxTimesRef.current = recent;

      setStats({
        packets: packetsRef.current,
        malformed: malformedRef.current,
        lost: lostRef.current,
        rateHz: recent.length / (RATE_WINDOW_MS / 1000),
      });

      if (!pausedRef.current) {
        setRows([...bufferRef.current].reverse()); // most recent first
      }
    }, TICK_MS);

    return () => clearInterval(interval);
  }, [device]);

  const togglePause = useCallback(() => setPaused((p) => !p), []);

  return { rows, stats, paused, togglePause, streamError };
}
