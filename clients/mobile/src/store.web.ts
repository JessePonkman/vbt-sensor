// Browser version of store.ts, for the web preview: same API, backed by
// localStorage instead of the file system. It exists so the whole flow
// (record in demo mode -> detail -> history -> export) can be tried and
// screenshotted in a browser; the phone uses store.ts.

import { buildStoredSet, parseCsv, samplesToCsv, type StoredSample, type StoredSet } from './session';

const P = 'vbt:';
const ls = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export function saveSet(set: StoredSet, samples: readonly StoredSample[]): void {
  const st = ls();
  if (!st) return;
  st.setItem(`${P}csv:${set.id}`, samplesToCsv(samples));
  st.setItem(`${P}json:${set.id}`, JSON.stringify(set));
}

export function getSet(id: string): StoredSet | null {
  const raw = ls()?.getItem(`${P}json:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSet;
  } catch {
    return null;
  }
}

export function listSets(): StoredSet[] {
  const st = ls();
  if (!st) return [];
  const out: StoredSet[] = [];
  for (let i = 0; i < st.length; i++) {
    const k = st.key(i);
    if (k?.startsWith(`${P}json:`)) {
      const set = getSet(k.slice(`${P}json:`.length));
      if (set) out.push(set);
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function loadSamples(id: string): StoredSample[] {
  return parseCsv(ls()?.getItem(`${P}csv:${id}`) ?? '').samples;
}

export function updateSetMeta(set: StoredSet, patch: { loadKg?: number | null; note?: string }): StoredSet {
  const next = { ...set, ...patch };
  ls()?.setItem(`${P}json:${set.id}`, JSON.stringify(next));
  return next;
}

export function deleteSet(id: string): void {
  ls()?.removeItem(`${P}csv:${id}`);
  ls()?.removeItem(`${P}json:${id}`);
}

export function reanalyzeSet(set: StoredSet): StoredSet {
  const next = buildStoredSet(loadSamples(set.id), { source: set.source, createdAt: set.createdAt, loadKg: set.loadKg, note: set.note, id: set.id });
  ls()?.setItem(`${P}json:${set.id}`, JSON.stringify(next));
  return next;
}

export function importCsv(text: string, opts: { loadKg?: number | null; note?: string } = {}): StoredSet {
  const { samples } = parseCsv(text);
  const set = buildStoredSet(samples, { source: 'import', ...opts });
  saveSet(set, samples);
  return set;
}

export function getSetting(key: string): string | null {
  return ls()?.getItem(`${P}setting:${key}`) ?? null;
}

export function setSetting(key: string, value: string): void {
  ls()?.setItem(`${P}setting:${key}`, value);
}

/** In the browser "share" is a download of the CSV. */
export async function shareSetCsv(id: string): Promise<boolean> {
  const csv = ls()?.getItem(`${P}csv:${id}`);
  if (!csv || typeof document === 'undefined') return false;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${id}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

// Compile-time guarantee that this file and store.ts expose the same API.
const _same: typeof import('./store') = { saveSet, getSet, listSets, loadSamples, updateSetMeta, deleteSet, reanalyzeSet, importCsv, getSetting, setSetting, shareSetCsv };
void _same;
