// Grabar. One job: mark where the set starts, mark where it ends. Nothing
// starts or stops by itself, so the analysis gets exactly the window the lifter
// meant. No live velocity or rep count: the set is reviewed afterwards.

import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { AdapterState } from '../ble';
import { DEMO_SCENARIOS, useConn, useLive } from '../stream';
import { DEVICE_NAME } from '../protocol';
import { useLayout } from '../responsive';
import { useTheme } from '../theme';
import { Banner, Button, Card, Chip, Field, row, Screen, SectionLabel, Title } from '../ui';

const mmss = (ms: number) => {
  const t = Math.floor(ms / 1000);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export default function RecordScreen() {
  const conn = useConn();
  const live = useLive();
  const router = useRouter();
  const { colors } = useTheme();
  const { s } = useLayout();
  const [loadText, setLoadText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const connected = conn.appState === 'connected' && (!!conn.device || conn.demo);

  const finish = () => {
    const kg = parseFloat(loadText.replace(',', '.'));
    const res = conn.endSet({ loadKg: Number.isFinite(kg) && kg > 0 ? kg : null });
    if (res.ok) {
      setError(null);
      router.push({ pathname: '/set/[id]', params: { id: res.id } });
    } else {
      setError(res.error);
    }
  };

  return (
    <Screen>
      <Title sub="Sentadilla">Grabar serie</Title>

      {conn.adapterState !== AdapterState.PoweredOn && !conn.demo && (
        <Banner
          tone="warn"
          message={conn.adapterState === 'Unsupported' ? 'Bluetooth no está disponible acá. Probá la app con el modo demo.' : 'El Bluetooth está apagado. Activalo para conectar el sensor.'}
        />
      )}
      {conn.permissionDenied && <Banner tone="bad" message="Falta el permiso de Bluetooth. Habilitalo en los ajustes del teléfono." />}
      {conn.notice && <Banner tone="info" message={conn.notice} />}
      {error && <Banner tone="bad" message={error} />}

      {/* ---- connection ------------------------------------------------------ */}
      <Card>
        <View style={row.between}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: connected ? colors.good : colors.textDim }} />
            <Text style={{ color: colors.text, fontSize: s(16), fontWeight: '800', flexShrink: 1 }}>
              {connected ? (conn.demo ? 'Modo demo (sin sensor)' : conn.device?.name ?? DEVICE_NAME) : conn.appState === 'scanning' ? 'Buscando…' : conn.appState === 'connecting' ? 'Conectando…' : 'Sin conexión'}
            </Text>
          </View>
          {connected && !conn.isRecording && <Button variant="ghost" label="Desconectar" onPress={conn.disconnect} style={{ minHeight: 40 }} />}
        </View>

        {connected && (
          <Text style={{ color: colors.textDim, fontSize: s(13) }}>
            {live.stats.rateHz.toFixed(0)} Hz · {live.stats.packets} paquetes · {live.stats.lost} perdidos
            {conn.rssi !== null && !conn.demo ? ` · ${conn.rssi} dBm` : ''}
          </Text>
        )}

        {!connected && (
          <View style={{ gap: 10 }}>
            <Button label={conn.appState === 'scanning' ? 'Buscando sensor…' : 'Buscar sensor'} onPress={conn.scan} disabled={conn.appState === 'scanning' || conn.appState === 'connecting' || conn.adapterState !== AdapterState.PoweredOn} />
            {conn.appState === 'scanning' && conn.devices.length === 0 && <Text style={{ color: colors.textDim, fontSize: s(13) }}>Buscando {DEVICE_NAME}… ¿está encendido?</Text>}
            {conn.devices.map((d) => (
              <Button key={d.id} variant="secondary" label={`${d.name ?? d.id}  ·  ${d.rssi ?? '—'} dBm`} onPress={() => conn.select(d)} />
            ))}
            <SectionLabel>O probá sin sensor</SectionLabel>
            <View style={row.wrap}>
              {DEMO_SCENARIOS.map((sc) => (
                <Chip key={sc.id} label={sc.label} selected={conn.demo && conn.demoScenario === sc.id} onPress={() => conn.startDemo(sc.id)} />
              ))}
            </View>
          </View>
        )}
      </Card>

      {/* ---- the set ------------------------------------------------------------ */}
      {connected && (
        <Card>
          {!conn.isRecording ? (
            <>
              <Field label="Carga (opcional)" value={loadText} onChangeText={setLoadText} placeholder="ej. 140" unit="kg" numeric />
              <Text style={{ color: colors.textDim, fontSize: s(14), lineHeight: s(20) }}>
                Con la barra en posición y <Text style={{ color: colors.text, fontWeight: '800' }}>quieta</Text>, tocá <Text style={{ color: colors.text, fontWeight: '800' }}>Marcar inicio</Text> y empezá.
              </Text>
              <Button big label="Marcar inicio" onPress={() => { setError(null); conn.startSet(); }} />
            </>
          ) : (
            <>
              <View style={{ alignItems: 'center', gap: 4, paddingVertical: 6 }}>
                <Text style={{ color: colors.bad, fontSize: s(14), fontWeight: '800' }}>● GRABANDO</Text>
                <Text accessibilityLiveRegion="polite" style={{ color: colors.text, fontSize: s(56), fontWeight: '800', fontVariant: ['tabular-nums'] }}>
                  {mmss(live.setElapsedMs)}
                </Text>
                <Text style={{ color: colors.textDim, fontSize: s(13) }}>{live.setSamples} muestras · llegando datos</Text>
              </View>
              <Text style={{ color: colors.textDim, fontSize: s(14), lineHeight: s(20) }}>
                Al terminar, con la barra <Text style={{ color: colors.text, fontWeight: '800' }}>arriba y quieta</Text>, tocá <Text style={{ color: colors.text, fontWeight: '800' }}>Marcar fin</Text>. Si lo tocás antes, la última repetición puede quedar incompleta.
              </Text>
              <Button big variant="danger" label="Marcar fin" onPress={finish} />
              <Button variant="ghost" label="Descartar" onPress={conn.cancelSet} />
            </>
          )}
        </Card>
      )}
    </Screen>
  );
}
