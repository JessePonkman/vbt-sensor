// What a recorded set IS once it leaves the sensor: its raw samples as a CSV
// (the SAME 13-column format clients/desktop/app.py records and opens, so a set
// recorded on the phone opens in the desktop tool and the other way round), a
// summary of the analysis, and the metadata the lifter attaches (load, note).
//
// Pure TypeScript with no React Native imports, so node's test runner can load
// it; the part that touches the file system is src/store.ts.

// Node's test runner needs the explicit .ts extension for a runtime import.
import { analyzeSet } from './reps.ts';
import type { RawSample, Rep } from './vbt';

// ---- CSV ------------------------------------------------------------------------

export const CSV_COLUMNS = [
  'seq', 't_us', 'ax', 'ay', 'az', 'gx', 'gy', 'gz', 'temp_c', 'flags', 'tx_dropped', 'jitter_us', 'rx_at_ms',
] as const;

/** What a stored sample can carry beyond RawSample (all of it optional: v1 has
 *  none of it, and the desktop tool treats an empty cell as "not reported"). */
export type StoredSample = RawSample & {
  tempC?: number;
  flags?: number;
  txDropped?: number;
  jitterUs?: number;
  rxAt?: number; // ms
};

const cell = (x: number | undefined): string => (x === undefined || Number.isNaN(x) ? '' : String(x));

/** Always the full 13-column header, as the desktop tool writes it; columns a
 *  sample does not have are left empty. `rx_at_ms` is mandatory for the desktop
 *  loader, so it falls back to the sensor timestamp in ms. */
export function samplesToCsv(samples: readonly StoredSample[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const s of samples) {
    lines.push(
      [
        s.sequence, s.timestamp, s.ax, s.ay, s.az,
        cell(s.gx), cell(s.gy), cell(s.gz), cell(s.tempC),
        cell(s.flags), cell(s.txDropped), cell(s.jitterUs),
        s.rxAt ?? s.timestamp / 1000,
      ].join(',')
    );
  }
  return lines.join('\n') + '\n';
}

/** Reads a CSV written by this app or by clients/desktop. Rows with a missing
 *  or non-numeric required field are skipped and counted, never half-parsed. */
export function parseCsv(text: string): { samples: StoredSample[]; skipped: number } {
  const rows = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (rows.length === 0) return { samples: [], skipped: 0 };
  const head = rows[0].split(',').map((h) => h.trim());
  const ix = (k: string) => head.indexOf(k);
  for (const k of ['seq', 't_us', 'ax', 'ay', 'az']) if (ix(k) < 0) throw new Error(`CSV sin la columna "${k}"`);

  const num = (c: string[], k: string): number | undefined => {
    const i = ix(k);
    if (i < 0 || c[i] === undefined || c[i].trim() === '') return undefined;
    const v = Number(c[i]);
    return Number.isFinite(v) ? v : undefined;
  };

  const samples: StoredSample[] = [];
  let skipped = 0;
  for (const line of rows.slice(1)) {
    const c = line.split(',');
    const seq = num(c, 'seq');
    const t = num(c, 't_us');
    const ax = num(c, 'ax');
    const ay = num(c, 'ay');
    const az = num(c, 'az');
    if (seq === undefined || t === undefined || ax === undefined || ay === undefined || az === undefined) {
      skipped++;
      continue;
    }
    const s: StoredSample = { sequence: seq, timestamp: t, ax, ay, az };
    const gx = num(c, 'gx');
    const gy = num(c, 'gy');
    const gz = num(c, 'gz');
    if (gx !== undefined && gy !== undefined && gz !== undefined) {
      s.gx = gx;
      s.gy = gy;
      s.gz = gz;
    }
    const tempC = num(c, 'temp_c');
    if (tempC !== undefined) s.tempC = tempC;
    const flags = num(c, 'flags');
    if (flags !== undefined) s.flags = flags;
    const drop = num(c, 'tx_dropped');
    if (drop !== undefined) s.txDropped = drop;
    const jit = num(c, 'jitter_us');
    if (jit !== undefined) s.jitterUs = jit;
    const rx = num(c, 'rx_at_ms');
    if (rx !== undefined) s.rxAt = rx;
    samples.push(s);
  }
  return { samples, skipped };
}

// ---- set summary ------------------------------------------------------------------

export type RepRow = {
  index: number;
  meanV: number; // mean concentric velocity, m/s
  peakV: number; // peak concentric velocity, m/s
  eccPeakV: number; // peak eccentric velocity (negative), m/s
  romM: number; // range of motion, m
  conS: number; // concentric duration, s
  eccS: number; // eccentric duration, s
  /** How far this rep's mean velocity fell below the set's best, 0..1. */
  dropFromBest: number;
  lossy: boolean; // packets were lost inside this rep
};

export type SetSummary = {
  reps: number;
  bestMeanV: number;
  lastMeanV: number;
  avgMeanV: number;
  bestPeakV: number;
  avgPeakV: number;
  /** (fastest rep - last rep) / fastest rep: the usual "velocity loss in the set". */
  velocityLoss: number;
  /** (fastest rep - slowest rep) / fastest rep. */
  maxVelocityLoss: number;
  avgRomM: number;
  avgConS: number;
  avgEccS: number;
  rows: RepRow[];
};

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

export function summarizeSet(reps: readonly Rep[]): SetSummary {
  const best = reps.reduce((m, r) => Math.max(m, r.concentric.meanVelocity), 0);
  const worst = reps.length ? reps.reduce((m, r) => Math.min(m, r.concentric.meanVelocity), Infinity) : 0;
  const last = reps.length ? reps[reps.length - 1].concentric.meanVelocity : 0;
  const rows: RepRow[] = reps.map((r, i) => ({
    index: i + 1,
    meanV: r.concentric.meanVelocity,
    peakV: r.concentric.peakVelocity,
    eccPeakV: r.eccentric.peakVelocity,
    romM: r.concentric.rangeOfMotion,
    conS: r.concentric.durationMs / 1000,
    eccS: r.eccentric.durationMs / 1000,
    dropFromBest: best > 0 ? Math.max(0, (best - r.concentric.meanVelocity) / best) : 0,
    lossy: r.lossy,
  }));
  return {
    reps: reps.length,
    bestMeanV: best,
    lastMeanV: last,
    avgMeanV: mean(rows.map((r) => r.meanV)),
    bestPeakV: reps.reduce((m, r) => Math.max(m, r.concentric.peakVelocity), 0),
    avgPeakV: mean(rows.map((r) => r.peakV)),
    velocityLoss: best > 0 ? (best - last) / best : 0,
    maxVelocityLoss: best > 0 ? (best - worst) / best : 0,
    avgRomM: mean(rows.map((r) => r.romM)),
    avgConS: mean(rows.map((r) => r.conS)),
    avgEccS: mean(rows.map((r) => r.eccS)),
    rows,
  };
}

// ---- the stored set ------------------------------------------------------------------

export type Exercise = 'squat';
export type SetSource = 'sensor' | 'demo' | 'import';

/** Bumped whenever the detector changes enough that stored numbers are stale.
 *  The raw CSV is kept, so an old set can simply be re-analyzed. */
export const ANALYSIS_VERSION = 1;

export type StoredSet = {
  id: string; // also the file name stem: "2026-11-12_153045"
  createdAt: number; // ms since epoch
  exercise: Exercise;
  loadKg: number | null;
  note: string;
  source: SetSource;
  sampleCount: number;
  durationS: number;
  orientation: 'gyro' | 'accel';
  analysisVersion: number;
  summary: SetSummary;
  reps: Rep[];
  rejected: number; // candidate reps the detector refused (walkout bumps, partial reps)
};

const two = (n: number) => String(n).padStart(2, '0');

/** "2026-11-12_153045", the same style as the desktop tool's session files. */
export function makeSetId(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

/** Analyzes a recorded set and packages it with its metadata. This is the one
 *  place a recording becomes a StoredSet, whether it came from the sensor, the
 *  demo or an imported CSV. */
export function buildStoredSet(
  samples: readonly StoredSample[],
  opts: { source: SetSource; createdAt?: number; loadKg?: number | null; note?: string; id?: string }
): StoredSet {
  const createdAt = opts.createdAt ?? Date.now();
  const a = analyzeSet(samples);
  const first = samples[0]?.timestamp ?? 0;
  const last = samples[samples.length - 1]?.timestamp ?? 0;
  return {
    id: opts.id ?? makeSetId(createdAt),
    createdAt,
    exercise: 'squat',
    loadKg: opts.loadKg ?? null,
    note: opts.note ?? '',
    source: opts.source,
    sampleCount: samples.length,
    durationS: samples.length > 1 ? (((last - first + 2 ** 32) % 2 ** 32) / 1e6) : 0,
    orientation: a.orientation,
    analysisVersion: ANALYSIS_VERSION,
    summary: summarizeSet(a.reps),
    reps: a.reps,
    rejected: a.rejected.length,
  };
}
