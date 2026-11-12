// Shared building blocks. Everything reads the theme and the layout, so no
// screen hard-codes a colour or a size. Controls are at least 52 dp tall: they
// get pressed with a thumb, with chalk on the hands, in the sun.

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLayout } from './responsive';
import { useTheme } from './theme';

/** A screen: safe area, optional scrolling, content centred in a readable column. */
export function Screen({ children, scroll = true, padBottom = 24 }: { children: React.ReactNode; scroll?: boolean; padBottom?: number }) {
  const { colors } = useTheme();
  const { gutter, contentWidth } = useLayout();
  const inner = { width: '100%' as const, maxWidth: contentWidth, alignSelf: 'center' as const, paddingHorizontal: gutter };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top', 'left', 'right']}>
      {scroll ? (
        <ScrollView contentContainerStyle={[inner, { paddingBottom: padBottom, paddingTop: 8, gap: 16 }]} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[inner, { flex: 1, paddingTop: 8 }]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function Title({ children, sub }: { children: React.ReactNode; sub?: string }) {
  const { colors } = useTheme();
  const { s } = useLayout();
  return (
    <View style={{ gap: 2 }}>
      <Text accessibilityRole="header" style={{ color: colors.text, fontSize: s(26), fontWeight: '800' }}>
        {children}
      </Text>
      {sub ? <Text style={{ color: colors.textDim, fontSize: s(14) }}>{sub}</Text> : null}
    </View>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const { s } = useLayout();
  return <Text style={{ color: colors.textDim, fontSize: s(12), fontWeight: '800', letterSpacing: 0.8 }}>{String(children).toUpperCase()}</Text>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return <View style={[{ backgroundColor: colors.surface, borderRadius: 14, padding: 14, gap: 10 }, style]}>{children}</View>;
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  big,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  big?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const { s } = useLayout();
  const bg = variant === 'primary' ? colors.accent : variant === 'danger' ? colors.bad : variant === 'secondary' ? colors.surface2 : 'transparent';
  const fg = variant === 'primary' ? colors.onAccent : variant === 'danger' ? '#FFFFFF' : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        {
          minHeight: big ? 72 : 52,
          borderRadius: 14,
          paddingHorizontal: 16,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: bg,
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
          borderWidth: variant === 'ghost' ? 1.5 : 0,
          borderColor: colors.border,
        },
        style,
      ]}
    >
      <Text style={{ color: fg, fontSize: s(big ? 22 : 16), fontWeight: '800', textAlign: 'center' }}>{label}</Text>
    </Pressable>
  );
}

export function StatTile({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: 'good' | 'warn' | 'bad' }) {
  const { colors } = useTheme();
  const { s } = useLayout();
  const color = tone ? colors[tone] : colors.text;
  return (
    <View style={{ flexGrow: 1, flexBasis: 140, backgroundColor: colors.surface, borderRadius: 14, padding: 12, gap: 2 }}>
      <Text style={{ color: colors.textDim, fontSize: s(12), fontWeight: '700' }}>{label}</Text>
      <Text style={{ color, fontSize: s(26), fontWeight: '800', fontVariant: ['tabular-nums'] }}>
        {value}
        {unit ? <Text style={{ color: colors.textDim, fontSize: s(14), fontWeight: '600' }}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

export function Banner({ message, tone = 'warn' }: { message: string; tone?: 'warn' | 'bad' | 'info' }) {
  const { colors } = useTheme();
  const { s } = useLayout();
  const c = tone === 'bad' ? colors.bad : tone === 'warn' ? colors.warn : colors.textDim;
  return (
    <View style={{ borderRadius: 12, borderWidth: 1.5, borderColor: c, padding: 12 }}>
      <Text style={{ color: colors.text, fontSize: s(14) }}>{message}</Text>
    </View>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  unit,
  numeric,
  multiline,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  unit?: string;
  numeric?: boolean;
  multiline?: boolean;
}) {
  const { colors } = useTheme();
  const { s } = useLayout();
  return (
    <View style={{ gap: 4, flexGrow: 1 }}>
      <Text style={{ color: colors.textDim, fontSize: s(12), fontWeight: '700' }}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface2, borderRadius: 12, paddingHorizontal: 12 }}>
        <TextInput
          accessibilityLabel={label}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textDim}
          keyboardType={numeric ? 'decimal-pad' : 'default'}
          multiline={multiline}
          style={{ flex: 1, minHeight: 52, color: colors.text, fontSize: s(18), paddingVertical: 10, textAlignVertical: multiline ? 'top' : 'center' }}
        />
        {unit ? <Text style={{ color: colors.textDim, fontSize: s(16), fontWeight: '700' }}>{unit}</Text> : null}
      </View>
    </View>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress?: () => void }) {
  const { colors } = useTheme();
  const { s } = useLayout();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{
        minHeight: 40,
        paddingHorizontal: 14,
        borderRadius: 20,
        justifyContent: 'center',
        backgroundColor: selected ? colors.accent : colors.surface2,
      }}
    >
      <Text style={{ color: selected ? colors.onAccent : colors.text, fontSize: s(14), fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}

export const row = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
});
