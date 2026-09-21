import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  SafeAreaView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Device, State as AdapterState } from 'react-native-ble-plx';
import { connectAndPrepare, manager, openAppSettings, requestBlePermissions } from './src/ble';
import { DEVICE_NAME, magnitude, SERVICE_UUID, toHex } from './src/protocol';
import { colors } from './src/theme';
import { LogRow, useVbtStream } from './src/useVbtStream';

type AppState = 'idle' | 'scanning' | 'connecting' | 'connected';

const SCAN_TIMEOUT_MS = 10_000;

export default function App() {
  const [adapterState, setAdapterState] = useState<AdapterState>(AdapterState.Unknown);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const [appState, setAppState] = useState<AppState>('idle');
  const [scannedDevices, setScannedDevices] = useState<Map<string, Device>>(new Map());
  const [connectingName, setConnectingName] = useState<string | null>(null);
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [connectedRssi, setConnectedRssi] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Bumped once per successful connection. StreamPanel is mounted with
  // `key={sessionId}` so every new connection gets fresh internal state
  // (rows/stats/refs) for free, without any manual reset logic — see
  // useVbtStream.ts.
  const [sessionId, setSessionId] = useState(0);

  const scanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalDisconnectRef = useRef(false);
  const connectedDeviceRef = useRef<Device | null>(null);
  connectedDeviceRef.current = connectedDevice;

  // Adapter power state — scanning/connecting only make sense while PoweredOn.
  useEffect(() => {
    const subscription = manager.onStateChange(setAdapterState, true);
    return () => subscription.remove();
  }, []);

  // Unmount cleanup only (see PLAN.md §4.4) — uses refs so it doesn't need to
  // re-run every time the connected device changes.
  useEffect(() => {
    return () => {
      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
      manager.stopDeviceScan();
      connectedDeviceRef.current?.cancelConnection().catch(() => {});
    };
  }, []);

  const handleScan = useCallback(async () => {
    setNotice(null);
    if (adapterState !== AdapterState.PoweredOn) return;

    const granted = await requestBlePermissions();
    setPermissionDenied(!granted);
    if (!granted) return;

    setScannedDevices(new Map());
    setAppState('scanning');

    manager.startDeviceScan([SERVICE_UUID], null, (error, device) => {
      if (error) {
        setNotice(error.message);
        setAppState('idle');
        return;
      }
      if (device) {
        setScannedDevices((prev) => new Map(prev).set(device.id, device));
      }
    });

    if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
    scanTimeoutRef.current = setTimeout(() => {
      manager.stopDeviceScan();
      setAppState((current) => (current === 'scanning' ? 'idle' : current));
    }, SCAN_TIMEOUT_MS);
  }, [adapterState]);

  const handleSelectDevice = useCallback(async (device: Device) => {
    if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
    manager.stopDeviceScan();
    setNotice(null);
    setAppState('connecting');
    setConnectingName(device.name ?? device.id);

    try {
      const prepared = await connectAndPrepare(device.id);
      intentionalDisconnectRef.current = false;
      setConnectedRssi(device.rssi);
      setConnectedDevice(prepared);
      setSessionId((n) => n + 1);
      setAppState('connected');

      prepared.onDisconnected(() => {
        setConnectedDevice(null);
        setAppState('idle');
        if (!intentionalDisconnectRef.current) {
          setNotice('Device disconnected');
        }
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Connection failed');
      setAppState('idle');
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    if (!connectedDevice) return;
    intentionalDisconnectRef.current = true;
    await connectedDevice.cancelConnection().catch(() => {});
  }, [connectedDevice]);

  const deviceList = useMemo(
    () => Array.from(scannedDevices.values()).sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)),
    [scannedDevices]
  );

  const blockingBanner = useMemo(() => {
    if (adapterState !== AdapterState.PoweredOn) {
      return {
        message: 'Bluetooth is off',
        actionLabel: 'Enable Bluetooth',
        onAction: () => Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS'),
      };
    }
    if (permissionDenied) {
      return { message: 'Bluetooth permission denied', actionLabel: 'Grant permission', onAction: openAppSettings };
    }
    return null;
  }, [adapterState, permissionDenied]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <Text style={styles.title}>VBT Sensor</Text>
        <View style={styles.statusBadge}>
          <View style={[styles.dot, { backgroundColor: appState === 'connected' ? colors.connected : colors.disconnected }]} />
          <Text style={styles.statusText}>{appState.toUpperCase()}</Text>
        </View>
      </View>

      {appState === 'connected' && connectedDevice && (
        <View style={styles.subHeader}>
          <Text style={styles.subHeaderText}>{connectedDevice.name ?? connectedDevice.id}</Text>
          <Text style={styles.subHeaderText}>{connectedRssi !== null ? `${connectedRssi} dBm` : '— dBm'}</Text>
          <Text style={styles.subHeaderText}>Protocol v1</Text>
        </View>
      )}

      {blockingBanner ? (
        <Banner message={blockingBanner.message} actionLabel={blockingBanner.actionLabel} onAction={blockingBanner.onAction} />
      ) : notice ? (
        <Banner message={notice} tone="warning" />
      ) : null}

      {appState !== 'connected' && (
        <View style={styles.scanSection}>
          <TouchableOpacity
            style={[styles.primaryButton, (appState === 'scanning' || !!blockingBanner) && styles.buttonDisabled]}
            onPress={handleScan}
            disabled={appState === 'scanning' || appState === 'connecting' || !!blockingBanner}
          >
            {appState === 'scanning' ? (
              <ActivityIndicator color={colors.textPrimary} />
            ) : (
              <Text style={styles.primaryButtonText}>Scan for devices</Text>
            )}
          </TouchableOpacity>

          {appState === 'connecting' && <Text style={styles.hint}>Connecting to {connectingName}…</Text>}

          {appState === 'scanning' && deviceList.length === 0 && (
            <Text style={styles.hint}>No devices found yet. Is {DEVICE_NAME} powered on?</Text>
          )}

          {deviceList.length > 0 && (
            <View style={styles.deviceList}>
              <Text style={styles.sectionLabel}>DEVICES</Text>
              {deviceList.map((device) => (
                <TouchableOpacity
                  key={device.id}
                  style={styles.deviceRow}
                  onPress={() => handleSelectDevice(device)}
                  disabled={appState === 'connecting'}
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

      {appState === 'connected' && connectedDevice && (
        <StreamPanel key={sessionId} device={connectedDevice} onDisconnect={handleDisconnect} />
      )}
    </SafeAreaView>
  );
}

function StreamPanel({ device, onDisconnect }: { device: Device; onDisconnect: () => void }) {
  const [showHex, setShowHex] = useState(false);
  const { rows, stats, paused, togglePause, streamError } = useVbtStream(device);

  return (
    <>
      {streamError && <Banner message={streamError} />}

      <View style={styles.statsRow}>
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
        <TouchableOpacity style={styles.secondaryButton} onPress={togglePause}>
          <Text style={styles.secondaryButtonText}>{paused ? 'Resume' : 'Pause'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.dangerButton} onPress={onDisconnect}>
          <Text style={styles.secondaryButtonText}>Disconnect</Text>
        </TouchableOpacity>
      </View>
    </>
  );
}

function Banner({
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

function StatTile({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <View style={styles.statTile}>
      <Text style={[styles.statValue, warn && styles.statValueWarn]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
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
  safe: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { color: colors.textPrimary, fontSize: 20, fontWeight: '700' },
  statusBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },
  subHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  subHeaderText: { color: colors.textSecondary, fontSize: 13 },
  banner: { marginHorizontal: 16, marginBottom: 12, padding: 12, borderRadius: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  bannerError: { backgroundColor: '#3A1616' },
  bannerWarning: { backgroundColor: '#3A2E0F' },
  bannerText: { color: colors.textPrimary, fontSize: 13, flexShrink: 1 },
  bannerAction: { color: colors.textPrimary, fontSize: 13, fontWeight: '700', textDecorationLine: 'underline', marginLeft: 12 },
  scanSection: { paddingHorizontal: 16, gap: 16 },
  primaryButton: { backgroundColor: colors.connected, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  buttonDisabled: { opacity: 0.5 },
  primaryButtonText: { color: '#0D0D0F', fontSize: 16, fontWeight: '700' },
  hint: { color: colors.textSecondary, fontSize: 13, textAlign: 'center' },
  sectionLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
  deviceList: { gap: 8 },
  deviceRow: { backgroundColor: colors.surface, borderRadius: 8, padding: 12 },
  deviceName: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  deviceMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  statsRow: { flexDirection: 'row', paddingHorizontal: 16, gap: 8 },
  statTile: { flex: 1, backgroundColor: colors.surface, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  statValue: { color: colors.textPrimary, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statValueWarn: { color: colors.warning },
  statLabel: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  malformedHint: { color: colors.warning, fontSize: 12, textAlign: 'center', marginTop: 8 },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
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
  secondaryButton: { flex: 1, backgroundColor: colors.surface, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  dangerButton: { flex: 1, backgroundColor: colors.disconnected, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  secondaryButtonText: { color: colors.textPrimary, fontSize: 14, fontWeight: '700' },
});
