// Set detail: what the lifter opens after pressing End, and later from the
// history. Everything needed to decide something about the set, top to bottom:
// the headline numbers, one bar per rep, the whole velocity curve, and the rep
// table. Tapping a rep (in either chart or the table) highlights it in all of
// them. Wide screens put the charts and the numbers side by side.

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { RepBars, VelocityCurve, type Span } from '../../charts';
import { confirmAsync } from '../../confirm';
import { analyzeSet } from '../../reps';
import { useLayout } from '../../responsive';
import { type RepRow } from '../../session';
import { deleteSet, getSet, loadSamples, reanalyzeSet, shareSetCsv, updateSetMeta } from '../../store';
import { useTheme } from '../../theme';
import { Banner, Button, Card, Field, row, Screen, SectionLabel, StatTile, Title } from '../../ui';

const when = (ms: number) =>
  new Date(ms).toLocaleString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function SetDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { s, isWide } = useLayout();

  const [set, setSet] = useState(() => getSet(String(id)));
  const [selected, setSelected] = useState<number | null>(null);
  const [loadText, setLoadText] = useState(set?.loadKg != null ? String(set.loadKg) : '');
  const [note, setNote] = useState(set?.note ?? '');
  const [msg, setMsg] = useState<string | null>(null);

  // The curve needs the full trace, which is not stored: re-derive it from the
  // raw CSV (a few ms for a set).
  const analysis = useMemo(() => (set ? analyzeSet(loadSamples(set.id)) : null), [set]);

  if (!set || !analysis) {
    return (
      <Screen>
        <Title>Serie no encontrada</Title>
        <Button label="Ir al historial" onPress={() => router.replace('/history')} />
      </Screen>
    );
  }

  const sm = set.summary;
  const spans: Span[] = analysis.reps.map((r, i) => ({
    index: i + 1,
    start: r.startedAtMs / 1000,
    end: (r.startedAtMs + r.totalDurationMs) / 1000,
    partial: !!r.partial,
  }));
  const loss = sm.velocityLoss;
  const lossTone = loss < 0.1 ? 'good' : loss < 0.2 ? 'warn' : 'bad';
  const dirty = loadText.trim() !== (set.loadKg != null ? String(set.loadKg) : '') || note !== set.note;

  const save = () => {
    const kg = parseFloat(loadText.replace(',', '.'));
    setSet(updateSetMeta(set, { loadKg: Number.isFinite(kg) && kg > 0 ? kg : null, note }));
    setMsg('Guardado.');
  };
  const share = async () => setMsg((await shareSetCsv(set.id)) ? null : 'Compartir no está disponible en este dispositivo.');
  const reanalyze = () => {
    setSet(reanalyzeSet(set));
    setMsg('Serie reanalizada con la versión actual del detector.');
  };
  const remove = async () => {
    if (await confirmAsync('Borrar serie', 'Se borra la serie y sus datos de este teléfono. No se puede deshacer.', 'Borrar')) {
      deleteSet(set.id);
      router.replace('/history');
    }
  };

  const charts = (
    <View style={{ gap: 16, flex: isWide ? 3 : undefined, minWidth: 0 }}>
      <Card>
        <SectionLabel>Velocidad media por repetición (m/s)</SectionLabel>
        <RepBars rows={sm.rows} selected={selected} onSelect={setSelected} />
        <Text style={{ color: colors.textDim, fontSize: s(12) }}>
          Barra y número = media de la subida · raya = pico · color = cuánto cayó contra tu mejor rep (verde &lt;10%, ámbar &lt;20%, rojo ≥20%).
        </Text>
      </Card>
      <Card>
        <SectionLabel>Velocidad de la barra en el tiempo (m/s)</SectionLabel>
        <VelocityCurve t={analysis.session.t} v={analysis.session.v} spans={spans} selected={selected} onSelect={setSelected} />
        <Text style={{ color: colors.textDim, fontSize: s(12) }}>Eje horizontal en segundos. Cada repetición está sombreada y numerada; tocala para resaltarla.</Text>
      </Card>
    </View>
  );

  const numbers = (
    <View style={{ gap: 16, flex: isWide ? 2 : undefined, minWidth: 0 }}>
      <View style={row.wrap}>
        <StatTile label="Repeticiones" value={String(sm.reps)} />
        <StatTile label="Mejor vel. media" value={sm.bestMeanV.toFixed(2)} unit="m/s" />
        <StatTile label="Pérdida de velocidad" value={`${Math.round(loss * 100)}`} unit="%" tone={lossTone} />
        <StatTile label="Recorrido promedio" value={(sm.avgRomM * 100).toFixed(0)} unit="cm" />
        <StatTile label="Mejor vel. pico" value={sm.bestPeakV.toFixed(2)} unit="m/s" />
        <StatTile label="Subida / bajada" value={`${sm.avgConS.toFixed(1)} / ${sm.avgEccS.toFixed(1)}`} unit="s" />
      </View>
      <RepTable rows={sm.rows} selected={selected} onSelect={setSelected} />
    </View>
  );

  return (
    <Screen>
      <Pressable onPress={() => router.replace('/history')} accessibilityRole="button" accessibilityLabel="Volver al historial" style={{ minHeight: 40, justifyContent: 'center' }}>
        <Text style={{ color: colors.accent, fontSize: s(16), fontWeight: '800' }}>‹ Historial</Text>
      </Pressable>
      <Title sub={`${when(set.createdAt)} · ${set.durationS.toFixed(0)} s${set.source === 'demo' ? ' · demo' : set.source === 'import' ? ' · importada' : ''}`}>
        Sentadilla{set.loadKg != null ? ` · ${set.loadKg} kg` : ''}
      </Title>

      {sm.reps === 0 && <Banner tone="warn" message="No se detectó ninguna repetición completa. Probá marcar el inicio con la barra quieta y el fin con la barra arriba." />}
      {sm.partialReps > 0 && (
        <Banner tone="warn" message={`${sm.partialReps} repetición(es) quedaron cortadas por la marca de inicio o de fin (con *). Se muestran, pero no cuentan para las estadísticas.`} />
      )}
      {set.rejected > 0 && <Banner tone="info" message={`${set.rejected} movimiento(s) descartado(s) por no parecer una repetición (por ejemplo sacar o guardar la barra).`} />}
      {set.orientation === 'accel' && <Banner tone="info" message="Esta serie no trae giroscopio: el detector usó solo el acelerómetro y puede equivocarse más si la barra rueda." />}

      <View style={{ flexDirection: isWide ? 'row' : 'column', gap: 16, alignItems: isWide ? 'flex-start' : 'stretch' }}>
        {charts}
        {numbers}
      </View>

      <Card>
        <SectionLabel>Datos de la serie</SectionLabel>
        <View style={row.wrap}>
          <View style={{ flexBasis: 140, flexGrow: 1 }}>
            <Field label="Carga" value={loadText} onChangeText={setLoadText} unit="kg" numeric placeholder="—" />
          </View>
          <View style={{ flexBasis: 240, flexGrow: 3 }}>
            <Field label="Nota" value={note} onChangeText={setNote} placeholder="ej. pausa 2 s, RPE 8" />
          </View>
        </View>
        {dirty && <Button label="Guardar cambios" onPress={save} />}
        {msg && <Text style={{ color: colors.textDim, fontSize: s(13) }}>{msg}</Text>}
      </Card>

      <View style={row.wrap}>
        <Button variant="secondary" label="Compartir CSV" onPress={share} style={{ flexGrow: 1, flexBasis: 160 }} />
        <Button variant="secondary" label="Reanalizar" onPress={reanalyze} style={{ flexGrow: 1, flexBasis: 160 }} />
        <Button variant="ghost" label="Borrar serie" onPress={remove} style={{ flexGrow: 1, flexBasis: 160 }} />
      </View>
    </Screen>
  );
}

function RepTable({ rows, selected, onSelect }: { rows: RepRow[]; selected: number | null; onSelect: (i: number | null) => void }) {
  const { colors } = useTheme();
  const { s } = useLayout();
  const cols: [string, number][] = [['Rep', 0.7], ['Media', 1.1], ['Pico', 1.1], ['Recorr.', 1.1], ['Subida', 1.1], ['Caída', 1]];
  const cell = (flex: number, text: string, bold = false, color?: string) => (
    <Text style={{ flex, textAlign: 'right', color: color ?? colors.text, fontSize: s(13), fontWeight: bold ? '800' : '500', fontVariant: ['tabular-nums'] }}>{text}</Text>
  );
  return (
    <Card style={{ paddingHorizontal: 8 }}>
      <View style={{ flexDirection: 'row', paddingHorizontal: 6 }}>
        {cols.map(([name, flex]) => (
          <Text key={name} style={{ flex, textAlign: 'right', color: colors.textDim, fontSize: s(11), fontWeight: '800' }}>{name}</Text>
        ))}
      </View>
      {rows.map((r) => {
        const isSel = selected === r.index;
        const dropColor = r.partial ? colors.textDim : r.dropFromBest < 0.1 ? colors.good : r.dropFromBest < 0.2 ? colors.warn : colors.bad;
        return (
          <Pressable
            key={r.index}
            accessibilityRole="button"
            accessibilityLabel={`Repetición ${r.index}`}
            onPress={() => onSelect(isSel ? null : r.index)}
            style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingHorizontal: 6, borderRadius: 8, backgroundColor: isSel ? colors.bandSelected : 'transparent', opacity: r.partial ? 0.55 : 1 }}
          >
            {cell(0.7, r.partial ? `${r.index}*` : String(r.index), true)}
            {cell(1.1, r.meanV.toFixed(2), true)}
            {cell(1.1, r.peakV.toFixed(2))}
            {cell(1.1, `${(r.romM * 100).toFixed(0)} cm`)}
            {cell(1.1, `${r.conS.toFixed(1)} s`)}
            {cell(1, r.partial ? '—' : `${Math.round(r.dropFromBest * 100)}%`, true, dropColor)}
          </Pressable>
        );
      })}
      <Text style={{ color: colors.textDim, fontSize: s(11), paddingHorizontal: 6, paddingTop: 4 }}>
        Media y pico en m/s, de la subida. Caída = contra la mejor rep de la serie. * = incompleta.
      </Text>
    </Card>
  );
}
