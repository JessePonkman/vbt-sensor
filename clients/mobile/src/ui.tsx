// Shared dark palette (was theme.ts — folded in here, PLAN-V2.md §8) plus
// the two components every screen reuses: Banner and StatTile. Per-screen
// layout stays in each screen file; only what's genuinely cross-screen lives
// here.

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export const colors = {
  background: '#0D0D0F',
  surface: '#1A1A1E',
  textPrimary: '#F2F2F2',
  textSecondary: '#8A8A92',
  connected: '#34D399',
  disconnected: '#F87171',
  warning: '#FBBF24',
} as const;

export function Banner({
  message,
  actionLabel,
  onAction,
  tone = 'error',
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  tone?: 'error' | 'warning';
}) {
  return (
    <View style={[styles.banner, tone === 'warning' ? styles.bannerWarning : styles.bannerError]}>
      <Text style={styles.bannerText}>{message}</Text>
      {actionLabel && onAction && (
        <TouchableOpacity onPress={onAction}>
          <Text style={styles.bannerAction}>{actionLabel}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

export function StatTile({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <View style={styles.statTile}>
      <Text style={[styles.statValue, warn && styles.statValueWarn]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  banner: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 12,
    borderRadius: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  bannerError: { backgroundColor: '#3A1616' },
  bannerWarning: { backgroundColor: '#3A2E0F' },
  bannerText: { color: colors.textPrimary, fontSize: 13, flexShrink: 1 },
  bannerAction: { color: colors.textPrimary, fontSize: 13, fontWeight: '700', textDecorationLine: 'underline', marginLeft: 12 },
  statsRow: { flexDirection: 'row', paddingHorizontal: 16, gap: 8 },
  statTile: { flex: 1, backgroundColor: colors.surface, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  statValue: { color: colors.textPrimary, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statValueWarn: { color: colors.warning },
  statLabel: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  sectionLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
  hint: { color: colors.textSecondary, fontSize: 13, textAlign: 'center' },
  primaryButton: { backgroundColor: colors.connected, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  buttonDisabled: { opacity: 0.5 },
  primaryButtonText: { color: '#0D0D0F', fontSize: 16, fontWeight: '700' },
  secondaryButton: { flex: 1, backgroundColor: colors.surface, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  dangerButton: { flex: 1, backgroundColor: colors.disconnected, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  secondaryButtonText: { color: colors.textPrimary, fontSize: 14, fontWeight: '700' },
});
