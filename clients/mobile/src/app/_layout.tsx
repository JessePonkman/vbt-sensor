// Root layout: theme + safe areas + the data provider, then three tabs. The
// set detail screen (set/[id]) is a route but not a tab: it opens from Grabar
// (right after a set ends) and from Historial.

import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Svg, { Circle, Line, Rect } from 'react-native-svg';
import { VbtProvider } from '../stream';
import { ThemeProvider, useTheme } from '../theme';

import type { ColorValue } from 'react-native';
type IconProps = { color: ColorValue; size?: number };

function RecIcon({ color }: IconProps) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={8} stroke={color} strokeWidth={2} fill="none" />
      <Circle cx={12} cy={12} r={3.5} fill={color} />
    </Svg>
  );
}
function HistoryIcon({ color }: IconProps) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24">
      <Rect x={4} y={13} width={4} height={7} fill={color} />
      <Rect x={10} y={6} width={4} height={14} fill={color} />
      <Rect x={16} y={10} width={4} height={10} fill={color} />
    </Svg>
  );
}
function SettingsIcon({ color }: IconProps) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24">
      <Line x1={4} y1={7} x2={20} y2={7} stroke={color} strokeWidth={2} />
      <Line x1={4} y1={12} x2={20} y2={12} stroke={color} strokeWidth={2} />
      <Line x1={4} y1={17} x2={20} y2={17} stroke={color} strokeWidth={2} />
    </Svg>
  );
}

function ThemedTabs() {
  const { colors, scheme } = useTheme();
  return (
    <>
      <StatusBar style={scheme === 'light' ? 'dark' : 'light'} />
      <Tabs
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: colors.bg },
          tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, minHeight: 60 },
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.textDim,
          tabBarLabelStyle: { fontSize: 13, fontWeight: '700' },
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Grabar', tabBarIcon: RecIcon }} />
        <Tabs.Screen name="history" options={{ title: 'Historial', tabBarIcon: HistoryIcon }} />
        <Tabs.Screen name="settings" options={{ title: 'Ajustes', tabBarIcon: SettingsIcon }} />
        <Tabs.Screen name="set/[id]" options={{ href: null }} />
      </Tabs>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <VbtProvider>
          <ThemedTabs />
        </VbtProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
