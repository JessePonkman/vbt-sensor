// Example sets, so the history and the detail screen can be tried without a
// sensor or a trip to the gym: the simulator's scenarios, saved like real sets
// (marked source "demo"), spread over the last days with plausible loads.

import { buildStoredSet } from './session';
import { SIM_SCENARIOS, simulateSquatSession } from './sim';
import { saveSet } from './store';

const PLAN: { scenario: string; loadKg: number; daysAgo: number; note: string }[] = [
  { scenario: 'normal', loadKg: 100, daysAgo: 0, note: 'Calentamiento' },
  { scenario: 'fatiga', loadKg: 120, daysAgo: 0, note: 'Serie efectiva, cayó la velocidad' },
  { scenario: 'pausa_larga', loadKg: 100, daysAgo: 2, note: 'Pausa de 3 s abajo' },
  { scenario: 'tempo_pausa', loadKg: 90, daysAgo: 4, note: 'Tempo 4-4-1' },
  { scenario: 'limite', loadKg: 140, daysAgo: 7, note: 'Casi al límite' },
];

/** Returns the ids of the sets it saved. */
export function seedExamples(): string[] {
  const now = Date.now();
  return PLAN.map((p, i) => {
    const sc = SIM_SCENARIOS.find((s) => s.id === p.scenario)!;
    const sim = simulateSquatSession({ ...sc.opts, walkout: false, rerack: false, leadS: 3, trailS: 3, seed: 100 + i });
    const createdAt = now - p.daysAgo * 86_400_000 - i * 3_600_000;
    const set = buildStoredSet(sim.samples, { source: 'demo', createdAt, loadKg: p.loadKg, note: p.note });
    saveSet(set, sim.samples);
    return set.id;
  });
}
