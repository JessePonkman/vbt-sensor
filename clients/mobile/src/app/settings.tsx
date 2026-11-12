// Ajustes: appearance, and the raw view of what the sensor is sending (the old
// debug screen, kept because it is how you check the link before a session).

import React, { useState } from 'react';
import { FlatList, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { magnitude, toHex } from '../protocol';
import { MAX_CONTENT_WIDTH, useLayout } from '../responsive';
import { useConn, useLive, type LogRow } from '../stream';
import { useTheme, type ThemeMode } from '../theme';
import { Button, Card, Chip, row, SectionLabel, StatTile, Title } from '../ui';

const MODES: [ThemeMode, string][] = [['auto', 'Automático'], ['light', 'Claro (sol)'], ['dark', 'Oscuro']];

export default function SettingsScreen() {
  const { colors, mode, setMode } = useTheme();
  const { s, gutter, contentWidth } = useLayout();
  const conn = useConn();
  const { rows, stats, paused, togglePause } = useLive();
  const [showHex, setShowHex] = useState(false);
  const live = conn.appState === 'connected';

  const header = (
    <View style={{ gap: 16, paddingTop: 8, paddingBottom: 12 }}>
      <Title>Ajustes</Title>
      <Card>
        <SectionLabel>Apariencia</SectionLabel>
        <View style={row.wrap}>
          {MODES.map(([m, label]) => (
            <Chip key={m} label={label} selected={mode === m} onPress={() => setMode(m)} />
          ))}
        </View>
        <Text style={{ color: colors.textDim, fontSize: s(13) }}>El tema claro tiene alto contraste para usarlo a pleno sol.</Text>
      </Card>

      <Card>
        <SectionLabel>Datos del sensor</SectionLabel>
        {live ? (
          <>
            <View style={row.wrap}>
              <StatTile label="Paquetes" value={String(stats.packets)} />
              <StatTile label="Frecuencia" value={stats.rateHz.toFixed(0)} unit="Hz" />
              <StatTile label="Perdidos" value={String(stats.lost)} tone={stats.lost > 0 ? 'warn' : undefined} />
            </View>
            {stats.malformed > 0 && <Text style={{ color: colors.warn, fontSize: s(13) }}>{stats.malformed} paquete(s) inválidos: revisá la MTU.</Text>}
            <View style={row.between}>
              <Text style={{ color: colors.text, fontSize: s(15) }}>Mostrar hexadecimal</Text>
              <Switch value={showHex} onValueChange={setShowHex} />
            </View>
            <Button variant="secondary" label={paused ? 'Reanudar' : 'Pausar la lista'} onPress={togglePause} />
          </>
        ) : (
          <Text style={{ color: colors.textDim, fontSize: s(14) }}>Sin conexión. Conectá el sensor (o la demo) en la pestaña Grabar para ver los paquetes.</Text>
        )}
      </Card>
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top', 'left', 'right']}>
      <FlatList
        data={live ? rows : []}
        keyExtractor={(r) => r.key}
        ListHeaderComponent={header}
        contentContainerStyle={{ width: '100%', maxWidth: Math.min(contentWidth, MAX_CONTENT_WIDTH), alignSelf: 'center', paddingHorizontal: gutter, paddingBottom: 24 }}
        renderItem={({ item }) => <LogRowItem row={item} showHex={showHex} />}
        initialNumToRender={20}
        windowSize={5}
      />
    </SafeAreaView>
  );
}

const LogRowItem = React.memo(function LogRowItem({ row: r, showHex }: { row: LogRow; showHex: boolean }) {
  const { colors } = useTheme();
  const { s } = useLayout();
  if (r.kind === 'gap') {
    return (
      <Text style={{ color: colors.warn, fontSize: s(12), fontWeight: '800', textAlign: 'center', paddingVertical: 6 }}>
        ⚠ {r.count} paquete{r.count === 1 ? '' : 's'} perdido{r.count === 1 ? '' : 's'}
      </Text>
    );
  }
  const x = r.sample;
  const mono = { color: colors.text, fontSize: s(12), fontFamily: 'monospace', flex: 1, textAlign: 'right' as const, fontVariant: ['tabular-nums' as const] };
  return (
    <View style={{ paddingVertical: 3, borderBottomWidth: 0.5, borderBottomColor: colors.border }}>
      <View style={{ flexDirection: 'row' }}>
        <Text style={[mono, { textAlign: 'left' }]}>{x.sequence}</Text>
        <Text style={mono}>{x.ax.toFixed(2)}</Text>
        <Text style={mono}>{x.ay.toFixed(2)}</Text>
        <Text style={mono}>{x.az.toFixed(2)}</Text>
        <Text style={mono}>{magnitude(x).toFixed(1)}</Text>
      </View>
      {showHex && x.raw.length > 0 && <Text style={{ color: colors.textDim, fontSize: s(10), fontFamily: 'monospace' }}>{toHex(x.raw)}</Text>}
    </View>
  );
});
