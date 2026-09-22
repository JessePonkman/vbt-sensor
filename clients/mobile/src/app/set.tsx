// Set tab: the last completed set — full acceleration + velocity charts and
// the per-rep table. Reads ConnCtx only (`sets` is a frozen snapshot
// published once at End set), so this screen is structurally incapable of
// re-rendering at the Live tab's 10 Hz. See PLAN-V2.md §4.3.

import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { LineChart } from '../charts';
import { useConn } from '../stream';
import { colors, StatTile, styles as ui } from '../ui';

export default function SetScreen() {
  const { sets } = useConn();
  const set = sets.length > 0 ? sets[sets.length - 1] : null;

  if (!set) {
    return (
      <View style={[ui.screen, styles.centered]}>
        <Text style={ui.hint}>Todavía no grabaste ninguna serie. Empezá una en el tab Live.</Text>
      </View>
    );
  }

  const best = set.reps.reduce((m, r) => Math.max(m, r.peakConcentricVelocity), 0);

  return (
    <ScrollView style={ui.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>
        SERIE {set.id} · {set.reps.length} reps · {(set.durationMs / 1000).toFixed(1)}s
      </Text>

      <View style={ui.statsRow}>
        <StatTile label="vel media m/s" value={set.meanVelocity.toFixed(2)} />
        <StatTile label="acc media m/s²" value={set.meanAccel.toFixed(2)} />
        <StatTile label="mejor m/s" value={best.toFixed(2)} />
      </View>

      <View style={styles.chartSection}>
        <Text style={ui.sectionLabel}>ACELERACIÓN m/s²</Text>
        <LineChart
          series={[
            { values: set.ax, color: colors.disconnected },
            { values: set.ay, color: colors.warning },
            { values: set.az, color: colors.connected },
          ]}
          height={140}
        />
      </View>

      <View style={styles.chartSection}>
        <Text style={ui.sectionLabel}>VELOCIDAD m/s</Text>
        <LineChart series={[{ values: set.v, color: colors.connected }]} height={140} />
      </View>

      <View style={styles.tableSection}>
        <View style={styles.tableHeader}>
          <Text style={[styles.headerCell, styles.colRep]}>#</Text>
          <Text style={styles.headerCell}>ECC max</Text>
          <Text style={styles.headerCell}>CON max</Text>
          <Text style={styles.headerCell}>CON media</Text>
        </View>
        {set.reps.map((rep) => (
          <View key={rep.index} style={styles.tableRow}>
            <Text style={[styles.cell, styles.colRep]}>{rep.index}</Text>
            <Text style={styles.cell}>{rep.eccentric.peakVelocity.toFixed(2)}</Text>
            <Text style={styles.cell}>{rep.peakConcentricVelocity.toFixed(2)}</Text>
            <Text style={styles.cell}>
              {rep.meanConcentricVelocity.toFixed(2)}
              {rep.lossy ? ' ⚠' : ''}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centered: { justifyContent: 'center', alignItems: 'center', padding: 24 },
  content: { paddingHorizontal: 16, paddingVertical: 12, gap: 16 },
  title: { color: colors.textPrimary, fontSize: 15, fontWeight: '700' },
  chartSection: { gap: 6 },
  tableSection: { gap: 2 },
  tableHeader: { flexDirection: 'row', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: colors.surface },
  headerCell: { flex: 1, color: colors.textSecondary, fontSize: 11, fontWeight: '700', textAlign: 'right' },
  colRep: { textAlign: 'left', flex: 0.5 },
  tableRow: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.surface },
  cell: { flex: 1, color: colors.textPrimary, fontSize: 13, fontFamily: 'monospace', textAlign: 'right', fontVariant: ['tabular-nums'] },
});
