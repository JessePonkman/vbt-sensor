# VBT Sensor — Plan de implementación MVP (Android / React Native)

Documento de especificación para el agente que implementa. Lee esto entero antes de escribir código.

**Objetivo del MVP:** una app Android que se conecta por BLE a una ESP32-S3, se suscribe a las
notificaciones de la característica de datos, parsea los paquetes binarios de 22 bytes y muestra en
pantalla el stream completo de muestras de aceleración en vivo.

**Fuera de scope explícito del MVP** (no implementar, no dejar scaffolding):
gráficos, cálculo de velocidad/VBT, grabación de sesión, export CSV, persistencia en disco,
autenticación, backend, iOS, navegación multi-pantalla, tests E2E.

---

## 1. Contexto del firmware (fuente de verdad)

Está en `firmware/src/main.cpp` del mismo repo. **Leelo antes de implementar el parser.**
Resumen de lo relevante:

| Concepto | Valor |
|---|---|
| Nombre BLE | `VBT-ESP32` |
| Service UUID | `4fafc201-1fb5-459e-8fcc-c5c9c331914b` |
| Characteristic UUID | `beb5483e-36e1-4688-b7f5-ea07361b26a8` |
| Propiedades de la característica | `READ` + `NOTIFY` (no hay WRITE — la app no puede configurar nada) |
| Tamaño de paquete | 22 bytes exactos (`static_assert` en el firmware lo garantiza) |
| Sensor | MPU6050, rango ±8 g, DLPF 21 Hz |
| Stack BLE | NimBLE-Arduino 2.5.x |

### 1.1 Layout del paquete — VBT Protocol v1

`#pragma pack(push, 1)` → sin padding. ESP32 es **little-endian**.

| Offset | Tamaño | Campo | Tipo | Notas |
|---|---|---|---|---|
| 0 | 1 | `magic` | uint8 | Siempre `0x56` (`'V'`) |
| 1 | 1 | `version` | uint8 | Siempre `0x01` |
| 2 | 4 | `timestamp` | uint32 LE | `micros()` del ESP32. Microsegundos desde boot. **Overflow cada ~71,6 min** |
| 6 | 4 | `accelX` | float32 LE | m/s² |
| 10 | 4 | `accelY` | float32 LE | m/s² |
| 14 | 4 | `accelZ` | float32 LE | m/s² |
| 18 | 4 | `sequence` | uint32 LE | Contador incremental desde 0, arranca en el boot del ESP32 |
| | **22** | | | |

En reposo, con el sensor plano, se espera `az ≈ 9.8`, `ax ≈ 0`, `ay ≈ 0`. Esto sirve de sanity check
al probar en hardware real.

### 1.2 Dos gotchas del firmware que condicionan la app

**(a) MTU.** El MTU BLE por defecto es 23 bytes → 20 bytes útiles de payload (3 de header ATT).
**Un paquete de 22 bytes NO entra.** La app tiene que negociar MTU antes de suscribirse o las
notificaciones llegan truncadas a 20 bytes. Ver §4.3. Este es el fallo más probable de toda la
integración: si el agente ve paquetes de 20 bytes, es esto.

**(b) La frecuencia real hoy es 1 Hz, no 100 Hz.** `SAMPLE_INTERVAL_US` está en `1000000` µs
(= 1 Hz) aunque los comentarios y el log de boot del firmware dicen 100 Hz. Es un valor de debug.
**No cambies el firmware**, pero **diseñá la app para 100–200 Hz** (ver §5): tiene que seguir
funcionando sin refactor cuando ese valor baje a `10000`.

---

## 2. Stack y dependencias

- **Expo con dev client** (managed + `expo prebuild`). BLE es nativo: **no funciona en Expo Go**.
  El flujo de desarrollo es `npx expo prebuild --platform android` + `npx expo run:android`.
- **TypeScript**, strict.
- **`react-native-ble-plx`** para BLE, instalada vía su config plugin de Expo (maneja permisos y
  manifest solo).
- **Sin state manager externo.** `useState` + `useRef` alcanzan. No Redux, no Zustand, no MobX.
- **Sin librería de UI.** `StyleSheet` de RN. No NativeWind, no Paper, no Tamagui.
- **Sin react-navigation.** Una sola pantalla.
- **Sin librería de charting.** No hay gráficos en el MVP.

Ubicación del proyecto: `clients/mobile/` (hoy sólo tiene un `.gitkeep`; el proyecto Expo se crea
ahí dentro, sin subcarpeta extra).

### 2.1 Config plugin

En `app.json` / `app.config.ts`:

```json
{
  "plugins": [
    ["react-native-ble-plx", { "isBackgroundEnabled": false, "modes": [], "bluetoothAlwaysPermission": false }]
  ],
  "android": { "package": "io.mascoma.vbtsensor" }
}
```

`minSdkVersion` por defecto de Expo (24) está bien. `targetSdkVersion` 34+.

---

## 3. Diseño de la UI

**Una sola pantalla.** Sin navegación. El contenido cambia según la máquina de estados (§6).
Tema oscuro (se usa en un gimnasio, y el log de números se lee mejor).

### 3.1 Estado DESCONECTADO / ESCANEANDO

```
┌──────────────────────────────┐
│ VBT Sensor      ○ DISCONNECTED│   ← header
├──────────────────────────────┤
│                              │
│      [   Scan for devices  ] │   ← botón primario, full-width
│                              │
│  Scanning… (3s)              │   ← sólo mientras escanea
├──────────────────────────────┤
│ DEVICES                      │
│ ┌──────────────────────────┐ │
│ │ VBT-ESP32                │ │   ← tocar = conectar
│ │ -54 dBm · AA:BB:CC:DD:EE │ │
│ └──────────────────────────┘ │
└──────────────────────────────┘
```

- Si el escaneo termina sin resultados: `No devices found. Is the sensor powered on?`
- Si faltan permisos o el Bluetooth está apagado: banner rojo arriba con el motivo y un botón de
  acción (`Grant permission` / `Enable Bluetooth`). Ver §4.1 y §4.2.

### 3.2 Estado CONECTADO / STREAMING

```
┌──────────────────────────────┐
│ VBT Sensor       ● CONNECTED │
│ VBT-ESP32   │ -54 dBm │ v1   │   ← nombre, RSSI, versión de protocolo del último paquete
├──────────────────────────────┤
│   1.024      99.8 Hz      0  │   ← fila de stats
│  packets      rate       lost│
├──────────────────────────────┤
│ Show raw hex            [ o] │   ← toggle debug, off por defecto
├──────────────────────────────┤
│ SEQ    AX      AY     AZ  |a|│   ← header de la tabla, fijo
├──────────────────────────────┤
│ 1024  0.12  -0.34   9.79  9.8│   ← lista, más reciente arriba
│ 1023  0.11  -0.31   9.81  9.8│
│ 1022  0.09  -0.30   9.80  9.8│
│ ⚠ 3 packets lost             │   ← fila especial ante un gap de sequence
│ 1018  0.10  -0.29   9.78  9.8│
│ …                            │
├──────────────────────────────┤
│  [  Pause  ]   [ Disconnect ]│
└──────────────────────────────┘
```

Detalles:

- **Stats:**
  - `packets` — total de paquetes válidos recibidos en la conexión actual.
  - `rate` — Hz reales, medidos en el cliente sobre una ventana móvil de ~1 s de `Date.now()`
    (no del `timestamp` del ESP32). Formato `99.8 Hz`.
  - `lost` — suma de gaps detectados en `sequence` (ver §5.3).
- **Log:** las **últimas 200 muestras**, más reciente arriba. Ancho fijo por columna, fuente
  monoespaciada, aceleraciones con 2 decimales. `|a|` es `sqrt(ax²+ay²+az²)`, útil para ver de un
  vistazo si el sensor está en reposo (~9.8).
- **Toggle hex:** cuando está encendido, cada fila agrega debajo una segunda línea con los 22 bytes
  en hex separados por espacios, atenuada y en fuente más chica. Off por defecto.
- **Pause:** congela el render del log (los paquetes se siguen contando y las stats se siguen
  actualizando). Es para poder leer un valor sin que se escape. El botón pasa a `Resume`.
- **Disconnect:** corta y vuelve al estado de §3.1.
- Si el dispositivo se desconecta solo: banner `Device disconnected` y vuelta a §3.1, conservando
  el último log visible hasta el próximo Scan.

### 3.3 Paleta

Oscuro. Fondo `#0D0D0F`, superficies `#1A1A1E`, texto primario `#F2F2F2`, secundario `#8A8A92`,
acento/conectado `#34D399`, error/desconectado `#F87171`, warning (packet loss) `#FBBF24`.

---

## 4. BLE: permisos, escaneo, conexión

### 4.1 Permisos de Android

El config plugin declara los permisos en el manifest, pero **hay que pedirlos en runtime**. Son
distintos según la versión:

- **Android 12+ (API 31+):** `BLUETOOTH_SCAN` (con `neverForLocation` para no necesitar ubicación)
  y `BLUETOOTH_CONNECT`.
- **Android 11 y anteriores (API ≤ 30):** `ACCESS_FINE_LOCATION`, y además el **servicio de
  ubicación del sistema tiene que estar encendido** o el escaneo devuelve cero resultados sin error.

Usar `PermissionsAndroid.requestMultiple` con el array correcto según `Platform.Version >= 31`.
Si el usuario deniega, mostrar el banner de §3.1 con un botón que abra los ajustes de la app
(`Linking.openSettings()`).

### 4.2 Estado del adaptador

Suscribirse a `BleManager.onStateChange(state => …, true)`. Sólo escanear cuando el estado sea
`PoweredOn`. Si es `PoweredOff`, banner `Bluetooth is off`.

### 4.3 Secuencia de conexión — el orden importa

```
1. startDeviceScan([SERVICE_UUID], { allowDuplicates: false }, cb)
   → filtrar por service UUID, no por nombre (más confiable en Android)
   → deduplicar por device.id
   → timeout de 10 s → stopDeviceScan()

2. Al tocar un dispositivo:
   stopDeviceScan()

3. device.connect({ requestMTU: 247 })
   ⚠ CRÍTICO. Sin esto los paquetes llegan a 20 bytes.
   Loguear el MTU efectivo que devuelve; si es < 25, abortar con un error explícito
   en pantalla: "MTU negotiation failed (got N). Packets will be truncated."

4. device.discoverAllServicesAndCharacteristics()
   (obligatorio en ble-plx antes de monitorear, aunque ya sepamos los UUIDs)

5. device.monitorCharacteristicForService(SERVICE_UUID, CHAR_UUID, listener)
   → guardar la Subscription para poder cancelarla

6. device.onDisconnected(...) → limpiar estado, volver a §3.1
```

El payload llega en `characteristic.value` como **string base64**. Hay que decodificarlo a bytes:
usar `Buffer.from(value, 'base64')` (con el polyfill `buffer`, ya presente en el bundle de RN) o una
función de decode propia de ~10 líneas. **No** agregar `react-native-quick-base64` ni similares
para esto.

### 4.4 Limpieza

- `stopDeviceScan()` en el unmount y al conectar.
- Cancelar la subscription de la característica y llamar `device.cancelConnection()` al
  desconectar y en el unmount.
- Cancelar el `onStateChange` subscription en el unmount.
- No instanciar más de un `BleManager` en toda la app (módulo singleton).

---

## 5. Parseo y manejo del throughput

### 5.1 Parser

Función pura, sin dependencias, testeable sin hardware:

```ts
type VbtSample = {
  timestamp: number;  // µs del ESP32
  ax: number; ay: number; az: number;  // m/s²
  sequence: number;
  rxAt: number;       // Date.now() del cliente, para medir Hz reales
  raw: Uint8Array;    // los 22 bytes, para el toggle hex
};

function parsePacket(bytes: Uint8Array): VbtSample | null
```

- Rechazar (devolver `null`) si `bytes.length !== 22`, si `bytes[0] !== 0x56` o si
  `bytes[1] !== 0x01`. Contar los rechazos en un contador `malformed` (mostrarlo en las stats sólo
  si es > 0 — señal de MTU mal negociado o de firmware desactualizado).
- Leer con `DataView`, **todos los campos con `littleEndian = true`**:
  `getUint32(2, true)`, `getFloat32(6, true)`, `getFloat32(10, true)`, `getFloat32(14, true)`,
  `getUint32(18, true)`.
- ⚠ Cuidado con `byteOffset` al construir el `DataView` si el `Uint8Array` viene de un `Buffer`
  que comparte un ArrayBuffer más grande. Construirlo como
  `new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)`.

### 5.2 Desacoplar el stream de React

A 100–200 Hz, un `setState` por notificación mata la app. El patrón:

- El listener de BLE parsea y hace `bufferRef.current.push(sample)` sobre un **`useRef`** —
  cero re-renders. El buffer es un array plano al que se le hace `splice(0, len - 200)` cuando pasa
  de 200 elementos (con ~200 items no hace falta un ring buffer real).
- Un `setInterval` de **100 ms** copia el buffer a estado con un `setSamples([...ref.current])`
  → la UI se refresca a 10 fps. Si `paused`, el intervalo no copia (pero el buffer se sigue
  llenando y las stats se siguen calculando).
- Las stats (packets / rate / lost) también viven en refs y se publican en el mismo tick de 100 ms.

`ponytail: array con splice a 200 items; si el log tiene que crecer a miles de muestras, cambiar a ring buffer con índice.`

### 5.3 Detección de pérdida

Guardar `lastSequence`. Si `sample.sequence > lastSequence + 1`, sumar el gap a `lost` e insertar en
el log una fila marcadora (§3.2). Si `sample.sequence <= lastSequence`, es un reinicio del ESP32
(el contador arranca en 0): resetear los contadores en vez de contar pérdida.

### 5.4 Render de la lista

`FlatList` con:
- `keyExtractor` por `sequence` (no por índice).
- El item envuelto en `React.memo`.
- `initialNumToRender={25}`, `maxToRenderPerBatch={25}`, `windowSize={5}`,
  `removeClippedSubviews`.
- **No** usar `getItemLayout` salvo que el toggle de hex esté apagado (las filas cambian de alto).
  Si simplifica, hacer dos alturas fijas conocidas y calcularlo.

---

## 6. Máquina de estados

```
IDLE ──scan()──> SCANNING ──tap device──> CONNECTING ──ok──> CONNECTED
 ^                  │                          │                │
 │                  │ timeout / stop           │ error          │ disconnect() / pérdida de link
 └──────────────────┴──────────────────────────┴────────────────┘

Estados de error transversales (bloquean scan/connect, se muestran como banner):
  NO_PERMISSION · BT_OFF · MTU_FAILED
```

Un `useState<AppState>` con un union type de strings. Sin librería de FSM.

---

## 7. Estructura de archivos propuesta

Mantenerla plana. Seis archivos, no más:

```
clients/mobile/
├── app.json                 # config Expo + plugin de ble-plx
├── App.tsx                  # la pantalla única: estado, layout, render
├── src/
│   ├── ble.ts               # singleton BleManager, permisos, scan, connect, subscribe
│   ├── protocol.ts          # constantes de UUID + parsePacket() + tipo VbtSample
│   ├── protocol.test.ts     # el único test (§8)
│   ├── useVbtStream.ts      # hook: buffer en ref, tick de 100ms, stats, detección de gaps
│   └── theme.ts             # colores de §3.3
```

Si un archivo queda en 20 líneas, fusionarlo con su vecino. No crear `components/`, `hooks/`,
`utils/`, `types/`, `constants/` con un archivo cada uno.

---

## 8. Verificación

**Un solo test**, sobre `parsePacket` — es la única lógica no trivial que se puede verificar sin
hardware, y la que va a fallar silenciosamente si algo está mal:

```
src/protocol.test.ts
  ✓ parsea un paquete válido de 22 bytes con los valores esperados
    (construir el buffer a mano con DataView, little-endian, verificar los 5 campos)
  ✓ devuelve null si length !== 22 (probar con 20 — el caso del MTU sin negociar)
  ✓ devuelve null si magic !== 0x56
  ✓ devuelve null si version !== 0x01
```

Sin framework nuevo si el proyecto ya trae jest-expo; si no, un `node --test` o incluso un
`assert`-based `demo()` alcanza. **No** montar testing-library, no testear componentes, no mockear
ble-plx.

### 8.1 Checklist de validación en hardware real

El agente no puede correr esto, pero tiene que dejarlo documentado en el README para el usuario:

1. Flashear el firmware, ver en el monitor serie las líneas `SEQ=… | AX=… | AY=… | AZ=…`.
2. Abrir la app → `Scan` → debe aparecer `VBT-ESP32`.
3. Conectar → el log tiene que llenarse con `az ≈ 9.8` con el sensor plano y quieto.
4. Los valores de la app tienen que coincidir con los del monitor serie para la misma `sequence`.
5. `rate` debe marcar ~1 Hz con el firmware actual (`SAMPLE_INTERVAL_US = 1000000`).
6. `lost` debe quedar en 0 con el dispositivo cerca.
7. Activar el toggle hex → el primer byte de cada fila debe ser `56 01`.
8. Alejar el dispositivo hasta que se corte → debe aparecer `Device disconnected` y volver al scan
   sin crashear.

---

## 9. README

Dejar un `clients/mobile/README.md` corto con: prerequisitos (Node, Android SDK, dispositivo físico
— **el emulador de Android no tiene BLE**), los comandos de prebuild/run, la tabla del protocolo de
§1.1 y el checklist de §8.1.

---

## 10. Recordatorios para el implementador

- **No tocar el firmware.** Si algo no cuadra, documentarlo, no arreglarlo acá.
- **No agregar dependencias** más allá de `react-native-ble-plx` (y `buffer` si no viene en el
  bundle). Todo lo demás se resuelve con RN y la stdlib.
- El `timestamp` del ESP32 es tiempo desde boot y **desborda a los ~71,6 minutos**. En el MVP sólo
  se muestra, no se usa para calcular nada. No inventar lógica de unwrapping.
- La característica **no tiene WRITE**: la app no puede configurar el sample rate ni nada. No
  diseñar UI de configuración.
- El MVP no calcula velocidad ni métricas de VBT. Sólo muestra lo que llega.
