// Live tab: scan/connect (when disconnected, PLAN.md §3.1 verbatim) and,
// once connected, calibration status, Start/End set, and the live
// acceleration + velocity charts (PLAN-V2.md §4.1-4.2).

import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { State as AdapterState } from 'react-native-ble-plx';
import { openAppSettings } from '../ble';
import { LineChart } from '../charts';
import { DEVICE_NAME } from '../protocol';
import { useConn, useLive } from '../stream';
import { Banner, colors, StatTile, styles as ui } from '../ui';

export default function LiveScreen() {
  const conn = useConn();
  const live = useLive();

  const blockingBanner = useMemo(() => {
    if (conn.adapterState !== AdapterState.PoweredOn) {
      return {
        message: 'Bluetooth is off',
        actionLabel: 'Enable Bluetooth',
        onAction: () => Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS'),
      };
    }
    if (conn.permissionDenied) {
      return { message: 'Bluetooth permission denied', actionLabel: 'Grant permission', onAction: openAppSettings };
    }
    return null;
  }, [conn.adapterState, conn.permissionDenied]);

  return (
    <View style={ui.screen}>
      <StatusBar style="light" />

      {conn.appState === 'connected' && conn.device && (
        <View style={styles.subHeader}>
          <Text style={styles.subHeaderText}>{conn.device.name ?? conn.device.id}</Text>
          <Text style={styles.subHeaderText}>{conn.rssi !== null ? `${conn.rssi} dBm` : '— dBm'}</Text>
          <Text style={styles.subHeaderText}>{live.stats.rateHz.toFixed(1)} Hz</Text>
        </View>
      )}

      {blockingBanner ? (
        <Banner message={blockingBanner.message} actionLabel={blockingBanner.actionLabel} onAction={blockingBanner.onAction} />
      ) : conn.notice ? (
        <Banner message={conn.notice} tone="warning" />
      ) : null}

      {conn.appState !== 'connected' && (
        <View style={styles.scanSection}>
          <TouchableOpacity
            style={[ui.primaryButton, (conn.appState === 'scanning' || !!blockingBanner) && ui.buttonDisabled]}
            onPress={conn.scan}
            disabled={conn.appState === 'scanning' || conn.appState === 'connecting' || !!blockingBanner}
          >
            {conn.appState === 'scanning' ? (
              <ActivityIndicator color={colors.textPrimary} />
            ) : (
              <Text style={ui.primaryButtonText}>Scan for devices</Text>
            )}
          </TouchableOpacity>

          {conn.appState === 'connecting' && <Text style={ui.hint}>Conectando…</Text>}

          {conn.appState === 'scanning' && conn.devices.length === 0 && (
            <Text style={ui.hint}>No devices found yet. Is {DEVICE_NAME} powered on?</Text>
          )}

          {conn.devices.length > 0 && (
            <View style={styles.deviceList}>
              <Text style={ui.sectionLabel}>DEVICES</Text>
              {conn.devices.map((device) => (
                <TouchableOpacity
                  key={device.id}
                  style={styles.deviceRow}
                  onPress={() => conn.select(device)}
                  disabled={conn.appState === 'connecting'}
                >
                  <Text style={styles.deviceName}>{device.name ?? device.id}</Text>
                  <Text style={styles.deviceMeta}>
                    {device.rssi !== null ? `${device.rssi} dBm` : '— dBm'} · {device.id}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      )}

      {conn.appState === 'connected' && conn.device && <LivePanel />}
    </View>
  );
}

function LivePanel() {
  const conn = useConn();
  const live = useLive();

  const meanVelocity = useMemo(() => {
    const values = live.win.v;
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  }, [live.win.v]);
  const meanAccel = useMemo(() => {
    const values = live.win.a;
    return values.length > 0 ? values.reduce((a, b) => a + Math.abs(b), 0) / values.length : 0;
  }, [live.win.a]);

  return (
    <>
      <View style={ui.statsRow}>
        <StatTile label="vel media" value={meanVelocity.toFixed(2)} />
        <StatTile label="acc media" value={meanAccel.toFixed(2)} />
        <StatTile label="reps" value={String(live.repCount)} />
      </View>

      <View style={styles.actionSection}>
        {!conn.isRecording ? (
          live.live.calibrated ? (
            <>
              <TouchableOpacity style={ui.primaryButton} onPress={conn.startSet}>
                <Text style={ui.primaryButtonText}>Iniciar serie</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={conn.recalibrate}>
                <Text style={styles.recalLink}>Recalibrar</Text>
              </TouchableOpacity>
            </>
          ) : (
            <View style={styles.calibrating}>
              <Text style={styles.calibratingText}>⚠ Mantené quieto — calibrando</Text>
            </View>
          )
        ) : (
          <TouchableOpacity style={ui.dangerButton} onPress={conn.endSet}>
            <Text style={ui.secondaryButtonText}>
              ● REC {formatElapsed(live.setElapsedMs)} · Terminar serie
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.chartSection}>
        <Text style={ui.sectionLabel}>ACELERACIÓN m/s²</Text>
        <LineChart
          series={[
            { values: live.win.ax, color: colors.disconnected },
            { values: live.win.ay, color: colors.warning },
            { values: live.win.az, color: colors.connected },
          ]}
        />
      </View>

      <View style={styles.chartSection}>
        <Text style={ui.sectionLabel}>VELOCIDAD m/s</Text>
        <LineChart series={[{ values: live.win.v, color: colors.connected }]} />
        <Text style={styles.liveHint}>en vivo — aproximado. Los números por rep se calculan al cerrar cada rep.</Text>
      </View>

      <View style={styles.footer}>
        <TouchableOpacity style={ui.dangerButton} onPress={conn.disconnect}>
          <Text style={ui.secondaryButtonText}>Disconnect</Text>
        </TouchableOpacity>
      </View>
    </>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  subHeader: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  subHeaderText: { color: colors.textSecondary, fontSize: 13 },
  scanSection: { paddingHorizontal: 16, gap: 16 },
  deviceList: { gap: 8 },
  deviceRow: { backgroundColor: colors.surface, borderRadius: 8, padding: 12 },
  deviceName: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  deviceMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  actionSection: { paddingHorizontal: 16, paddingTop: 12, gap: 8 },
  calibrating: { backgroundColor: colors.surface, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  calibratingText: { color: colors.warning, fontSize: 14, fontWeight: '600' },
  recalLink: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', textDecorationLine: 'underline' },
  chartSection: { paddingHorizontal: 16, paddingTop: 16, gap: 6 },
  liveHint: { color: colors.textSecondary, fontSize: 11 },
  footer: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 16 },
});
