// Persistence for recorded sets: the app's own folder, one pair of files per set.
//
//   <document dir>/sets/2026-11-12_153045.csv    raw samples, same format as clients/desktop
//   <document dir>/sets/2026-11-12_153045.json   StoredSet: metadata + analysis
//
// The CSV is the source of truth. The JSON is a cache of the analysis plus the
// load and note the lifter typed, so an old set can be re-analyzed when the
// detector improves (see ANALYSIS_VERSION in session.ts).
//
// Uses the current expo-file-system API (File / Directory / Paths) from SDK 57;
// the legacy functional API is deprecated. Everything here is synchronous file
// I/O on small files (a 60 s set is ~300 KB of CSV), which is why it is not
// wrapped in promises.

import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { buildStoredSet, parseCsv, samplesToCsv, type StoredSample, type StoredSet } from './session';

function dir(): Directory {
  const d = new Directory(Paths.document, 'sets');
  d.create({ idempotent: true, intermediates: true });
  return d;
}

const csvFile = (id: string) => new File(dir(), `${id}.csv`);
const jsonFile = (id: string) => new File(dir(), `${id}.json`);

/** Writes a set's raw samples and its analysis. Overwrites an existing id. */
export function saveSet(set: StoredSet, samples: readonly StoredSample[]): void {
  const csv = csvFile(set.id);
  csv.create({ overwrite: true });
  csv.write(samplesToCsv(samples));
  writeMeta(set);
}

function writeMeta(set: StoredSet): void {
  const json = jsonFile(set.id);
  json.create({ overwrite: true });
  json.write(JSON.stringify(set));
}

/** Every saved set, newest first. A file that cannot be read is skipped, not fatal. */
export function listSets(): StoredSet[] {
  const out: StoredSet[] = [];
  for (const item of dir().list()) {
    if (!(item instanceof File) || !item.name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(item.textSync()) as StoredSet);
    } catch {
      // half-written or corrupt: leave it for the user to delete, do not crash the history
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function loadSamples(id: string): StoredSample[] {
  return parseCsv(csvFile(id).textSync()).samples;
}

/** Load and note are the only things the lifter edits afterwards. */
export function updateSetMeta(set: StoredSet, patch: { loadKg?: number | null; note?: string }): StoredSet {
  const next = { ...set, ...patch };
  writeMeta(next);
  return next;
}

export function deleteSet(id: string): void {
  for (const f of [csvFile(id), jsonFile(id)]) if (f.exists) f.delete();
}

/** Re-runs the detector over the stored samples, keeping the lifter's metadata. */
export function reanalyzeSet(set: StoredSet): StoredSet {
  const next = buildStoredSet(loadSamples(set.id), { source: set.source, createdAt: set.createdAt, loadKg: set.loadKg, note: set.note, id: set.id });
  writeMeta(next);
  return next;
}

/** Imports a CSV (from this app or from the desktop tool) as a new set. */
export function importCsv(text: string, opts: { loadKg?: number | null; note?: string } = {}): StoredSet {
  const { samples } = parseCsv(text);
  const set = buildStoredSet(samples, { source: 'import', ...opts });
  saveSet(set, samples);
  return set;
}

/** Opens the system share sheet with the set's CSV (mail, Drive, WhatsApp...). */
export async function shareSetCsv(id: string): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(csvFile(id).uri, {
    mimeType: 'text/csv', // Android
    dialogTitle: `Serie ${id}`, // Android
    UTI: 'public.comma-separated-values-text', // iOS
  });
  return true;
}
