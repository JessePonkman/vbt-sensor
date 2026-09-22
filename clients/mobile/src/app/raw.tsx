// The original single-screen debug view, moved almost verbatim from
// App.tsx's StreamPanel (PLAN.md §3.2) into its own route. Consumes both
// contexts: ConnCtx for connect state / disconnect, LiveCtx for the 10fps
// row/stat publish.

import React, { useState } from 'react';
import { FlatList, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { magnitude, toHex } from '../protocol';
import { useConn, useLive, type LogRow } from '../stream';
import { Banner, colors, StatTile, styles as ui } from '../ui';

export default function RawScreen() {
  const { device, disconnect } = useConn();
  const [showHex, setShowHex] = useState(false);
  const { rows, stats, paused, togglePause, streamError } = useLive();

  if (!device) {
    return (
      <View style={[ui.screen, styles.centered]}>
        <Text style={ui.hint}>No conectado. Conectá el sensor en el tab Live.</Text>
      </View>
    );
  }

  return (
    <View style={ui.screen}>
      {streamError && <Banner message={streamError} />}

      <View style={ui.statsRow}>
        <StatTile label="packets" value={String(stats.packets)} />
        <StatTile label="rate" value={`${stats.rateHz.toFixed(1)} Hz`} />
        <StatTile label="lost" value={String(stats.lost)} warn={stats.lost > 0} />
      </View>

      {stats.malformed > 0 && (
        <Text style={styles.malformedHint}>{stats.malformed} malformed packet(s) — check MTU negotiation</Text>
      )}

      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>Show raw hex</Text>
        <Switch value={showHex} onValueChange={setShowHex} />
      </View>

      <View style={styles.tableHeader}>
        <Text style={[styles.headerCell, styles.cellSeq]}>SEQ</Text>
        <Text style={styles.headerCell}>AX</Text>
        <Text style={styles.headerCell}>AY</Text>
        <Text style={styles.headerCell}>AZ</Text>
        <Text style={styles.headerCell}>|a|</Text>
      </View>

      <FlatList
        style={styles.list}
        data={rows}
        keyExtractor={(row) => row.key}
        renderItem={({ item }) => <LogRowItem row={item} showHex={showHex} />}
        initialNumToRender={25}
        maxToRenderPerBatch={25}
        windowSize={5}
        removeClippedSubviews
      />

      <View style={styles.footer}>
        <TouchableOpacity style={ui.secondaryButton} onPress={togglePause}>
          <Text style={ui.secondaryButtonText}>{paused ? 'Resume' : 'Pause'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={ui.dangerButton} onPress={disconnect}>
          <Text style={ui.secondaryButtonText}>Disconnect</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const LogRowItem = React.memo(function LogRowItem({ row, showHex }: { row: LogRow; showHex: boolean }) {
  if (row.kind === 'gap') {
    return (
      <View style={styles.gapRow}>
        <Text style={styles.gapText}>
          ⚠ {row.count} packet{row.count === 1 ? '' : 's'} lost
        </Text>
      </View>
    );
  }

  const { sample } = row;
  return (
    <View style={styles.row}>
      <View style={styles.rowLine}>
        <Text style={[styles.cell, styles.cellSeq]}>{sample.sequence}</Text>
        <Text style={styles.cell}>{sample.ax.toFixed(2)}</Text>
        <Text style={styles.cell}>{sample.ay.toFixed(2)}</Text>
        <Text style={styles.cell}>{sample.az.toFixed(2)}</Text>
        <Text style={styles.cell}>{magnitude(sample).toFixed(1)}</Text>
      </View>
      {showHex && <Text style={styles.hexLine}>{toHex(sample.raw)}</Text>}
    </View>
  );
});

const styles = StyleSheet.create({
  centered: { justifyContent: 'center', alignItems: 'center', padding: 24 },
  malformedHint: { color: colors.warning, fontSize: 12, textAlign: 'center', marginTop: 8 },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  toggleLabel: { color: colors.textSecondary, fontSize: 13 },
  tableHeader: { flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: colors.surface },
  headerCell: { flex: 1, color: colors.textSecondary, fontSize: 11, fontWeight: '700', textAlign: 'right' },
  cellSeq: { textAlign: 'left' },
  list: { flex: 1, paddingHorizontal: 16 },
  row: { paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.surface },
  rowLine: { flexDirection: 'row' },
  cell: { flex: 1, color: colors.textPrimary, fontSize: 13, fontFamily: 'monospace', textAlign: 'right', fontVariant: ['tabular-nums'] },
  hexLine: { color: colors.textSecondary, fontSize: 10, fontFamily: 'monospace', marginTop: 2 },
  gapRow: { paddingVertical: 6, alignItems: 'center' },
  gapText: { color: colors.warning, fontSize: 12, fontWeight: '600' },
  footer: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
});
