// Root layout: SafeAreaProvider (react-native-svg/expo-router both expect
// it — RN's own SafeAreaView is deprecated, see AGENTS.md/PLAN-V2.md §10)
// wrapping <VbtProvider>, wrapping the tab navigator. No (tabs) group, no
// nested Stack — four flat routes.
//
// Tab icons are hand-drawn RN-SVG primitives, not @expo/vector-icons: that
// package isn't installed and PLAN-V2.md's dependency list doesn't include
// it, but react-native-svg already is (for the charts), so reusing it here
// costs nothing.

import { Tabs } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ColorValue } from 'react-native';
import Svg, { Circle, Line, Rect } from 'react-native-svg';
import { colors } from '../ui';
import { VbtProvider } from '../stream';

function LiveIcon({ color }: { color: ColorValue }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 22 22">
      <Circle cx={11} cy={11} r={7} stroke={color} strokeWidth={2} fill="none" />
      <Circle cx={11} cy={11} r={2.5} fill={color} />
    </Svg>
  );
}

function SetIcon({ color }: { color: ColorValue }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 22 22">
      <Rect x={3} y={11} width={3.5} height={8} fill={color} />
      <Rect x={9.25} y={5} width={3.5} height={14} fill={color} />
      <Rect x={15.5} y={8} width={3.5} height={11} fill={color} />
    </Svg>
  );
}

function CandlesIcon({ color }: { color: ColorValue }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 22 22">
      <Line x1={7} y1={2} x2={7} y2={20} stroke={color} strokeWidth={1.5} />
      <Rect x={4} y={7} width={6} height={8} fill={color} />
      <Line x1={16} y1={4} x2={16} y2={18} stroke={color} strokeWidth={1.5} />
      <Rect x={13} y={9} width={6} height={5} fill={color} />
    </Svg>
  );
}

function RawIcon({ color }: { color: ColorValue }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 22 22">
      <Line x1={3} y1={6} x2={19} y2={6} stroke={color} strokeWidth={2} />
      <Line x1={3} y1={11} x2={19} y2={11} stroke={color} strokeWidth={2} />
      <Line x1={3} y1={16} x2={19} y2={16} stroke={color} strokeWidth={2} />
    </Svg>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <VbtProvider>
        <Tabs
          screenOptions={{
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.textPrimary,
            headerShadowVisible: false,
            tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.surface },
            tabBarActiveTintColor: colors.connected,
            tabBarInactiveTintColor: colors.textSecondary,
          }}
        >
          <Tabs.Screen name="index" options={{ title: 'Live', tabBarIcon: LiveIcon }} />
          <Tabs.Screen name="set" options={{ title: 'Serie', tabBarIcon: SetIcon }} />
          <Tabs.Screen name="candles" options={{ title: 'Velas', tabBarIcon: CandlesIcon }} />
          <Tabs.Screen name="raw" options={{ title: 'Raw', tabBarIcon: RawIcon }} />
        </Tabs>
      </VbtProvider>
    </SafeAreaProvider>
  );
}
