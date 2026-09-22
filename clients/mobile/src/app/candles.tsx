// Candles tab: one candle per rep of the last completed set — eccentric and
// concentric velocity, each candle's box spanning min..max and its tick at
// the mean. Colors: concentric green (up), eccentric red (down) — reads
// correctly for lifting with zero new palette entries. See PLAN-V2.md §4.4.

import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Candle } from '../charts';
import { CandleChart } from '../charts';
import { useConn } from '../stream';
import { colors, styles as ui } from '../ui';

// A concentric rep whose mean falls this far below the set's best is the
// actual point of VBT (velocity loss as a fatigue signal) — costs one ternary.
const FATIGUE_DROP_RATIO = 0.8;

export default function CandlesScreen() {
  const { sets } = useConn();
  const set = sets.length > 0 ? sets[sets.length - 1] : null;

  if (!set || set.reps.length === 0) {
    return (
      <View style={[ui.screen, styles.centered]}>
        <Text style={ui.hint}>Todavía no grabaste ninguna serie. Empezá una en el tab Live.</Text>
      </View>
    );
  }

  const bestCon = set.reps.reduce((m, r) => Math.max(m, r.concentric.peakVelocity), 0);

  const concentric: Candle[] = set.reps.map((r) => ({
    lo: Math.min(0, r.concentric.minVelocity),
    hi: r.concentric.peakVelocity,
    mid: r.concentric.meanVelocity,
    color: r.concentric.meanVelocity < bestCon * FATIGUE_DROP_RATIO ? colors.warning : colors.connected,
  }));
  const eccentric: Candle[] = set.reps.map((r) => ({
    lo: r.eccentric.peakVelocity,
    hi: Math.max(0, r.eccentric.minVelocity),
    mid: r.eccentric.meanVelocity,
    color: colors.disconnected,
  }));

  return (
    <ScrollView style={ui.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>
        SERIE {set.id} · {set.reps.length} reps
      </Text>

      <View style={styles.chartSection}>
        <Text style={ui.sectionLabel}>CONCÉNTRICA m/s</Text>
        <CandleChart candles={concentric} />
      </View>

      <View style={styles.chartSection}>
        <Text style={ui.sectionLabel}>EXCÉNTRICA m/s</Text>
        <CandleChart candles={eccentric} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centered: { justifyContent: 'center', alignItems: 'center', padding: 24 },
  content: { paddingHorizontal: 16, paddingVertical: 12, gap: 20 },
  title: { color: colors.textPrimary, fontSize: 15, fontWeight: '700' },
  chartSection: { gap: 6 },
});
