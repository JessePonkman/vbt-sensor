// Two palettes and nothing else. The light one is for sun on the field: pure
// white background, near-black text, and accent colours dark enough to keep
// 4.5:1 contrast on white. The dark one is the gym default. The mode is
// automatic (follows the phone), or forced from the settings and remembered.

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { getSetting, setSetting } from './store';

export type Palette = {
  bg: string;
  surface: string; // cards
  surface2: string; // inputs, chips
  border: string;
  text: string;
  textDim: string;
  accent: string; // primary actions, "good"
  onAccent: string;
  good: string;
  warn: string;
  bad: string;
  band: string; // a rep's span behind the velocity curve
  bandSelected: string;
};

export const LIGHT: Palette = {
  bg: '#FFFFFF',
  surface: '#F2F3F5',
  surface2: '#E6E8EC',
  border: '#B8BDC6',
  text: '#0A0A0B',
  textDim: '#454A54',
  accent: '#0A6B4D',
  onAccent: '#FFFFFF',
  good: '#0A6B4D',
  warn: '#A24A00',
  bad: '#B3261E',
  band: 'rgba(10,107,77,0.10)',
  bandSelected: 'rgba(10,107,77,0.28)',
};

export const DARK: Palette = {
  bg: '#0D0D0F',
  surface: '#1A1A1E',
  surface2: '#26262C',
  border: '#3A3A42',
  text: '#F2F2F2',
  textDim: '#A4A4AD',
  accent: '#34D399',
  onAccent: '#0D0D0F',
  good: '#34D399',
  warn: '#FBBF24',
  bad: '#F87171',
  band: 'rgba(52,211,153,0.10)',
  bandSelected: 'rgba(52,211,153,0.28)',
};

export type ThemeMode = 'auto' | 'light' | 'dark';

type ThemeCtx = { colors: Palette; scheme: 'light' | 'dark'; mode: ThemeMode; setMode: (m: ThemeMode) => void };
const Ctx = createContext<ThemeCtx>({ colors: DARK, scheme: 'dark', mode: 'auto', setMode: () => {} });

function readMode(): ThemeMode {
  try {
    const v = getSetting('themeMode');
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const scheme: 'light' | 'dark' = mode === 'auto' ? (system === 'light' ? 'light' : 'dark') : mode;

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    try {
      setSetting('themeMode', m);
    } catch {
      // not being able to remember the choice must never break switching it
    }
  }, []);

  const value = useMemo(() => ({ colors: scheme === 'light' ? LIGHT : DARK, scheme, mode, setMode }), [scheme, mode, setMode]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
