// Historial: every set saved on the phone, newest first. One tap opens the
// detail. The row shows what is needed to find a set again (when, load, reps)
// and the two numbers that say how it went (best mean velocity, velocity loss).

import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { seedExamples } from '../examples';
import { MAX_CONTENT_WIDTH, useLayout } from '../responsive';
import type { StoredSet } from '../session';
import { listSets } from '../store';
import { useTheme } from '../theme';
import { Button, Title } from '../ui';

const day = (ms: number) => new Date(ms).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });
const hour = (ms: number) => new Date(ms).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

export default function HistoryScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { s, gutter, contentWidth } = useLayout();
  const [sets, setSets] = useState<StoredSet[]>([]);

  const refresh = useCallback(() => setSets(listSets()), []);
  useFocusEffect(refresh);

  const header = (
    <View style={{ paddingTop: 8, paddingBottom: 12, gap: 4 }}>
      <Title sub={sets.length ? `${sets.length} serie${sets.length === 1 ? '' : 's'} guardadas en este teléfono` : undefined}>Historial</Title>
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top', 'left', 'right']}>
      <FlatList
        data={sets}
        keyExtractor={(x) => x.id}
        ListHeaderComponent={header}
        contentContainerStyle={{ width: '100%', maxWidth: Math.min(contentWidth, MAX_CONTENT_WIDTH), alignSelf: 'center', paddingHorizontal: gutter, paddingBottom: 24, gap: 10 }}
        ListEmptyComponent={
          <View style={{ gap: 14, paddingTop: 24, alignItems: 'stretch' }}>
            <Text style={{ color: colors.textDim, fontSize: s(16), lineHeight: s(22) }}>
              Todavía no hay series. Grabá una desde la pestaña Grabar, o cargá unas de ejemplo para recorrer la app sin sensor.
            </Text>
            <Button label="Cargar series de ejemplo" onPress={() => { seedExamples(); refresh(); }} />
          </View>
        }
        renderItem={({ item }) => <SetRow set={item} onPress={() => router.push({ pathname: '/set/[id]', params: { id: item.id } })} />}
      />
    </SafeAreaView>
  );
}

function SetRow({ set, onPress }: { set: StoredSet; onPress: () => void }) {
  const { colors } = useTheme();
  const { s } = useLayout();
  const sm = set.summary;
  const loss = sm.velocityLoss;
  const lossColor = loss < 0.1 ? colors.good : loss < 0.2 ? colors.warn : colors.bad;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Serie del ${day(set.createdAt)}, ${set.loadKg ?? 'sin carga'} kilos, ${sm.reps} repeticiones`}
      style={({ pressed }) => ({ backgroundColor: colors.surface, borderRadius: 14, padding: 14, minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: pressed ? 0.8 : 1 })}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: colors.text, fontSize: s(17), fontWeight: '800' }} numberOfLines={1}>
          {set.loadKg != null ? `${set.loadKg} kg` : 'Sin carga'} · {sm.reps} rep{sm.reps === 1 ? '' : 's'}
        </Text>
        <Text style={{ color: colors.textDim, fontSize: s(13) }} numberOfLines={1}>
          {day(set.createdAt)} · {hour(set.createdAt)}
          {set.source !== 'sensor' ? ` · ${set.source === 'demo' ? 'demo' : 'importada'}` : ''}
        </Text>
        {set.note ? (
          <Text style={{ color: colors.textDim, fontSize: s(13) }} numberOfLines={1}>
            {set.note}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Text style={{ color: colors.text, fontSize: s(20), fontWeight: '800', fontVariant: ['tabular-nums'] }}>
          {sm.bestMeanV.toFixed(2)}
          <Text style={{ color: colors.textDim, fontSize: s(12), fontWeight: '600' }}> m/s</Text>
        </Text>
        <Text style={{ color: lossColor, fontSize: s(13), fontWeight: '800' }}>pérdida {Math.round(loss * 100)}%</Text>
      </View>
    </Pressable>
  );
}
