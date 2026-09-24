# PLAN — Cliente desktop de debug para VBT-Sensor

> Documento de implementación. Mismo rol que `clients/mobile/PLAN.md` / `PLAN-V2.md`:
> las decisiones ya están argumentadas acá, el código las implementa sin re-discutirlas.
> Las referencias a `vbt.ts`, `ble.ts`, `protocol.ts` apuntan a `clients/mobile/src/`.

---

## 0. Contexto

El firmware (`firmware/src/main.cpp`) emite paquetes VBT v1 de 22 bytes por BLE notify
a 100 Hz nominales: magic, version, `timestamp` (µs uint32), `ax/ay/az` (float32 LE, m/s²)
y `sequence` (uint32). El único consumidor hoy es la app Expo en `clients/mobile/`.

**El problema:** cada vez que hay que mirar la señal cruda del sensor hace falta un build de
Android completo. El ciclo de iteración es de minutos para responder preguntas de segundos
("¿cuánto ruido tiene el eje Z en reposo?", "¿este pico es real o es un glitch de I²C?").

**El objetivo:** un osciloscopio de escritorio en Python que se conecta por BLE en segundos y
muestra la señal cruda, sus integrales y sus estadísticos — y, sobre todo, un **banco de filtros**
con el que decidir, con datos y no a ojo, **qué filtro se implementa en el microcontrolador**.

**El entregable final no es la app: es una decisión de firmware.** La app existe para producir
esa decisión, y para eso tiene que terminar escupiendo el código C con los coeficientes listos
para pegar en `main.cpp`. Todo lo que no sirva a ese fin es andamiaje.

**Fuera de alcance (decidido):** detección de reps. Esa lógica ya vive, está derivada y está
testeada en `clients/mobile/src/vbt.ts` + `vbt.test.ts`. No se re-implementa en Python.

---

## 1. Decisiones tomadas

| Decisión | Elegido |
|---|---|
| Lenguaje / GUI | Python + **PySide6 + pyqtgraph** |
| BLE | **bleak** (CoreBluetooth en macOS) en hilo aparte → `queue` → `QTimer` |
| Persistencia | **Sí**: grabar a CSV + re-correr filtros offline sobre la misma captura |
| Gravedad en las velocidades | **Quitar bias + high-pass**, con toggles para ver el crudo |
| Alcance | **Osciloscopio de señal puro** (sin FSM de reps) |

---

## 2. Estructura de archivos

```
clients/desktop/
  requirements.txt        # bleak, PySide6, pyqtgraph, numpy, scipy
  README.md               # cómo correrlo en 3 líneas
  .gitignore              # .venv/, sessions/, __pycache__/
  protocol.py             # ~50 líneas — espejo 1:1 de src/protocol.ts
  ble.py                  # ~90 líneas — scan / connect / notify → queue
  dsp.py                  # ~220 líneas — grilla, filtros, integración, stats, análisis
  app.py                  # ~400 líneas — ventana PySide6, 5 pestañas, entrypoint
  test_dsp.py             # ~80 líneas — el chequeo corrible
  sessions/               # grabaciones (gitignored)
```

Sin `pyproject.toml`, sin `__main__.py`, sin capa de "servicios". `uv` no está instalado en esta
máquina: se usa `venv` + `pip` de stdlib. Se corre desde `clients/desktop/`, así que el cwd ya
pone los módulos en `sys.path` y **no hace falta paso de instalación del paquete**.

```bash
cd clients/desktop
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

---

## 3. `protocol.py` — el parser

Espejo de `clients/mobile/src/protocol.ts`. **La fuente de verdad sigue siendo
`firmware/src/main.cpp`**; si el packet cambia, cambian los tres.

El struct de C es `#pragma pack(1)` y little-endian, así que el parser entero es una línea:

```python
PACKET = struct.Struct("<BBIfffI")   # 1+1+4+4+4+4+4 = 22 bytes
assert PACKET.size == 22
```

- `DEVICE_NAME = "VBT-ESP32"`, `SERVICE_UUID`, `CHARACTERISTIC_UUID`: copiar de `protocol.ts`.
- `parse_packet(data: bytes) -> Sample | None`: devuelve `None` si el largo ≠ 22 o si
  `magic != 0x56` / `version != 0x01`. Mismos criterios que el TS.
- `Sample`: `NamedTuple` con `timestamp, ax, ay, az, sequence, rx_at, raw`.
- `delta_us(prev, curr)`: el truco wrap-safe `(curr - prev + 2**32) % 2**32`, portado de
  `deltaUs` en `vbt.ts`. El `timestamp` es uint32 en µs → **da la vuelta cada 71,6 min**.
  No es hipotético en una sesión de gimnasio larga.
- `to_hex(raw)`: para la vista de stream.

---

## 4. `ble.py` — el transporte

**Modelo de concurrencia** (es la única parte con riesgo real de integración):

```
[hilo daemon: asyncio.run(_run()) + bleak]
        │  notification callback
        ▼
   queue.SimpleQueue()          ← thread-safe, sin locks propios
        ▲
        │  drain
[hilo main: QTimer 33 ms] → numpy → pyqtgraph
```

- El hilo BLE **nunca** toca un widget de Qt. Solo hace `queue.put()`.
- `SimpleQueue` es thread-safe por contrato; no hace falta ningún lock adicional.
- API: `BleWorker(on_state: Callable[[str], None])` con `.start()`, `.stop()`, `.queue`.
  Los cambios de estado (`scanning / connected / disconnected / error`) se emiten como
  strings y el lado Qt los envuelve en una signal — **no** se llama a Qt desde el hilo BLE.

**Detalles de bleak que importan:**

- Descubrimiento: `BleakScanner.find_device_by_name(DEVICE_NAME, timeout=10)`. Si falla,
  caer a `BleakScanner.discover()` filtrando por `SERVICE_UUID` en los service UUIDs
  anunciados — el firmware los advierte (`pAdvertising->addServiceUUID`).
- En **macOS, `device.address` es un UUID de CoreBluetooth, no una MAC**, y es distinto
  en cada máquina. No hardcodear direcciones; buscar por nombre siempre.
- **MTU**: en macOS no se negocia desde el cliente (a diferencia de `ble.ts`, que pide 247).
  CoreBluetooth ya da ≥185 por default, de sobra para 22 bytes. No hay nada que hacer acá,
  y por eso este cliente **no** replica el chequeo `MIN_USABLE_MTU` de `ble.ts`.
- Callback: `def on_notify(sender, data: bytearray)`. Parsear ahí mismo y encolar el `Sample`
  ya parseado (el parseo son ~200 ns, no justifica moverlo de hilo).
- Los notifies **llegan en ráfagas**: macOS agrupa varios paquetes por connection event.
  Esto es normal y es exactamente la razón por la que el `timestamp` del firmware existe.
  → **Nunca derivar el eje de tiempo del momento de llegada.**

**Único riesgo de integración:** correr el loop de asyncio de bleak fuera del hilo principal.
Está soportado y es el patrón habitual en macOS, pero si CoreBluetooth se queja, el escape es
`qasync` (un solo loop compartido Qt+asyncio). No construir ese camino por adelantado; dejarlo
anotado en el README.

---

## 5. `dsp.py` — el núcleo

### 5.1 Reconstrucción de la grilla uniforme — la pieza clave

Es la diferencia de diseño más importante contra `vbt.ts`, y habilita todo lo demás.

`vbt.ts` §2.3 **rechazó Butterworth** con una razón correcta para su contexto: "necesita
coeficientes precalculados para frecuencia fija, que el diseño de `dt` variable no provee".
Acá esa restricción no aplica, y conviene entender por qué:

El scheduler del firmware es `lastSampleTime += SAMPLE_INTERVAL_US` (`main.cpp:541`) — acumula,
**no** hace `lastSampleTime = now`. Es libre de drift por construcción: los timestamps emitidos
son múltiplos exactos de 10 000 µs desde el boot. El `dt` variable que ve el cliente móvil no
viene del muestreo, viene de **paquetes perdidos en el aire**.

Y los paquetes perdidos son perfectamente contables: `sequence` es un contador denso.

```python
def to_grid(samples) -> Grid:
    """Reconstruye la grilla uniforme de 100 Hz que el firmware SÍ muestreó.
    k = seq - seq[0] es el índice exacto en la grilla. Los huecos se rellenan
    por interpolación lineal y se marcan en `filled` para poder pintarlos."""
```

Devuelve `Grid(t, ax, ay, az, filled: np.ndarray[bool], fs: float)`.

- `fs` se estima de la mediana de los `delta_us` **entre paquetes consecutivos en sequence**
  (robusta a huecos y a outliers), no del nominal 100 Hz. Si el firmware cambia
  `SAMPLE_INTERVAL_US`, la herramienta se entera sola.
- **Reset ante discontinuidad**: si `delta_us` implica un salto > 250 ms (igual que `DT_MAX_S`
  en `vbt.ts`) → reboot del ESP32 o stall del link. Cortar el segmento y empezar grilla nueva;
  no interpolar sobre un hueco de ese tamaño, sería inventar señal.
- Si `filled.mean() > 0.05` la UI muestra un warning: con >5% de muestras inventadas, cualquier
  conclusión sobre filtros es sospechosa.

**Esto es lo que legitima usar Butterworth de coeficientes fijos, Savitzky-Golay y Welch**, que
asumen grilla uniforme. Sin este paso serían incorrectos y darían respuestas lindas pero falsas.

### 5.2 El banco de filtros

Todos son one-liners de `scipy.signal`. **No implementar ninguno a mano** — es el stdlib del
dominio, y la aritmética de un Butterworth escrita a mano es exactamente el tipo de código que
se depura a las 3 AM.

| # | Filtro | ¿Causal? | Costo en MCU | Por qué está en la lista |
|---|---|---|---|---|
| 0 | Passthrough | — | — | La línea base contra la que se mide todo |
| 1 | Un polo / EMA (`LPF_HZ`) | sí | 3 flops, 1 float | Lo que usa `vbt.ts` hoy. El piso de costo absoluto |
| 2 | Butterworth LP 2º orden | sí | 1 biquad: 5×, 4+, 4 floats | Passband plana, −12 dB/oct. El estándar en biomecánica |
| 3 | Butterworth LP 4º orden | sí | 2 biquads | El "4th-order Butterworth" de la literatura |
| 4 | Butterworth LP **fase cero** | **no** | N/A | La *referencia*: qué se vería sin retardo de fase |
| 5 | Savitzky–Golay | no (necesita lookahead) | FIR: W×, W+, ring de W | El que **mejor preserva picos** |
| 6 | Media móvil (SMA) | sí | 2 flops + ring | Línea base a superar. Banda de rechazo dentada |
| 7 | **Mediana** (kernel 3–5) | sí | sort de 3–5 | Lo **único** que mata spikes impulsivos |
| 8 | Butterworth **HP** 1º–2º orden | sí | 1 biquad | Quita DC. Contra el drift vale más que cualquier LP |
| 9 | Notch (IIR) | sí | 1 biquad | Solo si la PSD revela una resonancia mecánica |

```python
sos = signal.butter(order, fc, btype="low", fs=fs, output="sos")
y   = signal.sosfilt(sos, x)          # causal   → lo que corre en el micro
y0  = signal.sosfiltfilt(sos, x)      # fase cero → la referencia, imposible en el micro
y   = signal.savgol_filter(x, window_length=w, polyorder=p)   # w impar
y   = signal.medfilt(x, kernel_size=k)                        # k impar
b,a = signal.iirnotch(f0, Q, fs=fs)
```

El filtro #1 es el único que se escribe a mano, porque tiene que reproducir *exactamente* la
fórmula de `vbt.ts:722-724` para que las comparaciones sean honestas:

```python
rc = 1 / (2 * np.pi * fc); alpha = dt / (dt + rc); y[i] = y[i-1] + alpha*(x[i] - y[i-1])
```

Con grilla uniforme `alpha` es constante → es `signal.lfilter([alpha], [1, -(1-alpha)], x)`.
Dejar el lazo explícito igual y **asertar en `test_dsp.py` que ambos coinciden**: es la prueba
de que la versión Python y la de TypeScript son el mismo filtro.

**Rechazados explícitamente:**
- **Kalman / Madgwick / filtro complementario.** Son la respuesta correcta a la fuga de gravedad
  por inclinación — que es el error dominante en doble integración — pero **necesitan giróscopo,
  y el paquete v1 no lo lleva**. Es un cambio de firmware, no de cliente. Anotado en §10.
- **Denoising por wavelets.** Sin camino razonable a un ESP32 y sin problema que lo pida.

### 5.3 Integración y velocidad

```python
v = integrate.cumulative_trapezoid(a, t, initial=0.0)
```

Misma regla trapezoidal que `vbt.ts:530`, así que los números son comparables entre clientes.

Pipeline por eje, cada etapa con su checkbox en la UI:

```
a_raw ──[filtro §5.2]──[− bias de gravedad]──[∫dt]──[detrend / HP]──[ZUPT]──> v
             ☑                  ☑                        ☑            ☐
```

1. **Bias de gravedad** — botón "Capturar reposo": toma 1 s de muestras quieto y promedia por
   eje. Es `calibrate()` de `vbt.ts:132` simplificado: acá se guarda el **vector de bias por eje**
   (no solo la proyección), porque hacen falta las tres velocidades por separado.
   Se reusan sus dos guardas, que son buenas y ya están justificadas:
   `8.5 ≤ |g| ≤ 11.0` y RMS de desviación 3D ≤ 0.12 m/s². Si no pasan, no calibrar y decirlo.
2. **Detrend** — el `detrend()` de `vbt.ts:174`: `bias = v[-1]/T`, restar la rampa. Es el inverso
   exacto del modelo de bias constante. Alternativa en el combo: HP Butterworth a 0.1–0.5 Hz.
3. **ZUPT** (opcional, off por default) — poner `v = 0` cuando el RMS de `|a|` en una ventana
   de 300 ms cae bajo umbral. Portar el criterio de `isStill()` (`vbt.ts:454`).

**Cuarta gráfica: `v_vert`.** Proyectar sobre el versor de gravedad (`a·û − |g|`, igual que
`vbt.ts:716`) e integrar. Es la señal que de verdad importa para VBT y el único número
comparable contra la app móvil. Sale gratis: son dos líneas sobre lo ya calculado.

El toggle "integración cruda" desactiva 1–3 y muestra `∫a dt` literal. **Va a ser una rampa de
~9.8 m/s por segundo en el eje vertical, y eso es correcto y deliberado**: es la demostración
visual de por qué el bias DC —y no el ruido de banda ancha— es lo que destruye la integración.

### 5.4 Estadísticos

`max, min, mean, median, std, RMS, peak-to-peak` — todos one-liners de numpy. Por eje, más `|a|`.

**En dos columnas: crudo vs filtrado.** Esa comparación *es* el criterio de selección: muestra
directamente **cuánto pico se come cada filtro**, y el pico de aceleración es una métrica VBT,
no un adorno. Un filtro que baja el ruido 40% pero recorta el pico 15% es un mal negocio, y de
otra forma no se ve.

Ámbito seleccionable: **ventana visible** / **grabación completa**.

### 5.5 Las tres herramientas que realmente eligen el filtro

Esto no es decoración. Sin esto, la app es un visor lindo y la decisión sigue siendo a ojo.

**a) PSD de Welch (log-log, crudo vs filtrado)**
```python
f, pxx = signal.welch(x, fs=fs, nperseg=min(512, len(x)))
```
Dice **dónde termina la señal y empieza el ruido**. Se toman dos capturas —una en reposo y una
con una rep— y se superponen: el cruce de ambas curvas es la frecuencia de corte candidata.
Es la medición que responde la pregunta, no una opinión sobre ella.

**b) Análisis de residuos (Winter)** — el método objetivo estándar en biomecánica:
```
para fc en 1..20 Hz:  residuo(fc) = RMS(x − butter_lp(x, fc))
```
Ajustar una recta a la cola (15–20 Hz, donde solo queda ruido), extrapolar a `fc = 0`, y tomar
como corte el `fc` donde la curva de residuos cruza esa ordenada al origen. Marcarlo en el plot.
**Esto produce un número de corte defendible para hardcodear en el firmware**, en vez de un 10 Hz
elegido porque suena redondo.

**c) Retardo de grupo, en ms y en muestras**
```python
w, gd = signal.group_delay(signal.sos2tf(sos), fs=fs)
```
Mostrarlo para cada filtro causal, más el ya conocido del DLPF on-chip (**~8,5 ms a 21 Hz**).
En el micro el filtro tiene que ser causal, y `sosfiltfilt` (#4) está en la lista precisamente
como la referencia contra la cual medir cuánto cuesta esa causalidad.

### 5.6 Exportador de código C — el entregable

Botón **"Export firmware snippet"**. Toma el filtro seleccionado con sus parámetros y escribe
el C listo para pegar en `main.cpp`:

```c
// Butterworth LP 2º orden, fc = 6.0 Hz @ fs = 100.0 Hz
// Generado por clients/desktop — retardo de grupo ~ 37 ms @ DC
// Costo: 5 mul, 4 add, 2 floats de estado, por eje.
static const float SOS[1][6] = {
    { 0.02785f, 0.05571f, 0.02785f, 1.0f, -1.47550f, 0.58696f }
};
// Forma directa II transpuesta. c = [b0, b1, b2, a0, a1, a2] (a0 == 1).
static inline float biquad(float x, const float c[6], float s[2]) {
    float y = c[0]*x + s[0];
    s[0] = c[1]*x - c[4]*y + s[1];
    s[1] = c[2]*x - c[5]*y;
    return y;
}
```

Los coeficientes de arriba son los reales de `butter(2, 6, fs=100, output="sos")` y sirven de
chequeo de cordura para el exportador: la ganancia en DC tiene que dar 1, o sea
`(b0+b1+b2)/(1+a1+a2) = 0.11141/0.11146 ≈ 1.0`. Si el exportador escupe algo que no cumple eso,
está mal. **Ojo con el retardo**: 37 ms para este filtro contra los ~16 ms del un-polo a 10 Hz —
el orden extra no es gratis, y es justamente el compromiso que la pestaña Filters tiene que
mostrar en vez de esconder.

Que el snippet salga de la misma llamada a `scipy` que generó la curva en pantalla es lo que hace
que **lo que se ve sea lo que se va a ejecutar**. Sin esto la herramienta produce una intuición;
con esto produce código verificado.

---

## 6. `app.py` — la UI

Ventana única, `QTabWidget` con 5 pestañas. Barra superior siempre visible:

```
[Scan] [Connect] [● Rec] [Open…]   VBT-ESP32 · conectado · RSSI −54
                                    98.7 Hz · 12 340 pkts · 7 perdidos (0.06%) · 0 malformados
```

Dos tasas de Hz distintas, ambas útiles y **no intercambiables**:
- **Hz del firmware** — de `timestamp`. Dice si el ESP32 mantiene su cadencia de muestreo.
- **Hz de llegada** — de `rx_at`. Dice si el link BLE sigue el ritmo.

Si divergen, el problema es el link, no el sensor. Un solo número escondería exactamente eso.

| Pestaña | Contenido |
|---|---|
| **1 · Stream** | `QPlainTextEdit` monoespaciado con `setMaximumBlockCount(500)` — se auto-poda solo, sin modelo de tabla. Una línea por paquete: `seq · t_us · dt_ms · ax ay az · \|a\| · hex`. Checkbox "mostrar hex". Marca las pérdidas en línea: `── 3 paquetes perdidos tras seq 12043 ──`. |
| **2 · Accel** | 3 `PlotWidget` apilados (ax, ay, az), eje X enlazado con `setXLink`. Cada uno: crudo en gris tenue + filtrado en color. Regiones interpoladas sombreadas. |
| **3 · Velocity** | 4 plots (vx, vy, vz, v_vert), X enlazado. Panel lateral con los toggles de §5.3 y el botón "Capturar reposo". |
| **4 · Stats** | Tabla: filas = ax/ay/az/\|a\|, columnas = max/min/mean/median/std/RMS/p2p, **en pares crudo vs filtrado**. Selector de ámbito. |
| **5 · Filters** | Combo de filtro + sus parámetros + lectura de diseño (−3 dB, orden, retardo de grupo, costo estimado en MCU) + plot de PSD + plot de residuos de Winter + **[Export firmware snippet]**. |

**Refresco:** `QTimer` a 33 ms (30 FPS). Drena la queue, extiende los buffers, re-filtra, redibuja.
Nunca dibujar por paquete: a 100 Hz serían 100 repaints/s para una pantalla de 60 Hz.

**Buffers:** `collections.deque(maxlen=6000)` (60 s a 100 Hz) por campo. La ventana visible por
default son 10 s. Se filtra el **buffer entero** y se plotea solo la rebanada visible: así el
transitorio de arranque del IIR queda **fuera de pantalla** en vez de ensuciar el borde izquierdo.

Re-filtrar todo el buffer en cada frame es deliberado: 6000 muestras × 4 señales a 30 FPS es
irrelevante para scipy, y elimina por completo el manejo de estado `zi` entre frames.

```python
# ponytail: re-filtrado stateless del buffer completo por frame, O(buffer) a 30 FPS.
# Techo: ~10 s de buffer a 1 kHz empezaría a notarse. Upgrade: sosfilt con zi
# persistente por señal — solo si un profiler lo pide, que no lo va a pedir.
```

**Grabación:** CSV a `sessions/YYYY-MM-DD_HHMMSS.csv`, cabecera
`seq,t_us,ax,ay,az,rx_at_ms`. Texto plano: legible, `grep`-eable, `np.loadtxt`-eable, y abrible
en cualquier cosa. Escribir con `csv.writer` a medida que llegan (no acumular en RAM y volcar al
final: si la app se cae se pierde la sesión entera).

**"Open…"** carga un CSV y llena exactamente los mismos paneles, con la fuente BLE desconectada.
Es lo que permite el A/B honesto: **mismo movimiento, distintos filtros**. Sin esto cada
comparación sería contra una sentadilla diferente, que es no comparar nada.

---

## 7. `test_dsp.py` — el chequeo corrible

Asserts planos, sin framework. Corre con `python test_dsp.py` (y también bajo `pytest` si está).

1. **Round-trip del paquete** — `struct.pack` un paquete conocido, parsearlo, comparar campos.
   Rechazar: largo ≠ 22, magic malo, version mala.
2. **Wraparound del timestamp** — `delta_us(2**32 - 5, 5) == 10`.
3. **Reconstrucción de grilla** — sacar 3 muestras del medio de una secuencia sintética;
   verificar que `to_grid` devuelve largo completo, `filled` marcando exactamente esos 3
   índices, y valores interpolados correctos.
4. **Integración** — `a = sin(2π·1·t)` durante 2 s a 100 Hz ⇒ `v = (1−cos)/2π`. Comparar contra
   la primitiva analítica con `atol=1e-3`.
5. **Equivalencia con TypeScript** — el lazo explícito del un-polo vs `signal.lfilter`,
   `np.allclose`. Blinda que el filtro Python y el de `vbt.ts` son el mismo filtro.
6. **Sanidad del filtro** — meter `sin(2 Hz) + sin(30 Hz)` por un LP a 6 Hz; assert que la
   potencia a 30 Hz cae >20 dB y la de 2 Hz sobrevive dentro de 1 dB.

El #6 es el que importa: es lo que falla si alguien invierte `btype` o confunde Hz con rad/s.

---

## 8. Hipótesis a validar (lo que la herramienta debería demostrar o refutar)

El plan no presupone la respuesta. Pero conviene que el agente sepa qué forma se espera que tenga,
para no construir de más:

1. **El DLPF on-chip ya hace casi todo el trabajo, gratis.** El MPU6050 está en
   `MPU6050_BAND_21_HZ` (`main.cpp:213`). Cuesta 0 ciclos de CPU y su elección puede ser una
   línea de firmware. **Hay que agotar esa opción antes de gastar un solo flop en software.**
2. **El contenido útil está muy por debajo de 10 Hz.** La velocidad de una sentadilla vive casi
   entera bajo 5 Hz; la aceleración bajo ~10 Hz. El traqueteo de discos y el golpe del rack
   están en 15–30 Hz. Si la PSD confirma esto, un LP de 2º orden a 5–8 Hz alcanza y sobra.
3. **La integración ya es un pasa-bajos con respuesta 1/f.** Más rolloff aporta poco a la
   velocidad. **Lo que destruye la velocidad es el bias DC, y ningún pasa-bajos quita DC.**
   → Es muy probable que **el high-pass (#8) importe más que cualquier low-pass**.
4. **Si hay spikes impulsivos** (glitches de I²C, clipping del rango ±8 g), ningún LP los
   arregla: los *esparce*. Solo la mediana (#7) los saca, y es baratísima.
   La pestaña Stream, con los bytes crudos, es donde se detectan.
5. **El error dominante probablemente no sea ruido, sino fuga de gravedad por inclinación.**
   Si la barra rota, `a_vert` levanta componente horizontal en silencio. Ningún filtro de los
   9 lo arregla. Ver §10.

Orden de trabajo sugerido una vez la app funciona: (1) capturar 30 s en reposo → piso de ruido
y offsets por eje; (2) capturar 5 reps → PSD + residuos de Winter; (3) elegir corte; (4) A/B de
causal vs fase-cero sobre la misma captura para medir el costo del retardo; (5) exportar el C.

---

## 9. Orden de implementación

| # | Paso | Verificación |
|---|---|---|
| 1 | `requirements.txt`, `.gitignore`, venv | `.venv/bin/python -c "import bleak, PySide6, pyqtgraph, scipy"` |
| 2 | `protocol.py` + tests 1–2 | `python test_dsp.py` pasa |
| 3 | `ble.py` + script mínimo que imprime paquetes | Se ven seq consecutivos a ~100 Hz con el sensor prendido |
| 4 | `dsp.py`: grilla + integración + stats, tests 3–4 | `python test_dsp.py` pasa |
| 5 | `app.py`: shell + pestaña Stream + grabación | Stream corre; el CSV se llena y `np.loadtxt` lo lee |
| 6 | Pestañas Accel + Velocity | 7 gráficas actualizando a 30 FPS sin lag |
| 7 | `dsp.py`: banco de filtros, tests 5–6 | `python test_dsp.py` pasa |
| 8 | Pestañas Stats + Filters (PSD, residuos) | Cambiar de filtro redibuja crudo vs filtrado |
| 9 | Exportador de C + `README.md` | El snippet compila pegado en `main.cpp` |

Los pasos 3 y 5 son los únicos que necesitan el hardware prendido. El resto se desarrolla y
verifica entero contra CSVs grabados o señales sintéticas — que es, incidentalmente, el mismo
argumento por el que existe esta herramienta.

---

## 10. Hallazgo para el firmware (fuera de alcance, pero hay que decirlo)

**El paquete v1 no lleva giróscopo, y eso pone un techo a lo que cualquier filtro puede lograr.**

El MPU6050 ya tiene el giro configurado (`MPU6050_RANGE_500_DEG`, `main.cpp:204`) y ya se lee en
cada `mpu.getEvent()` (`main.cpp:310`) — **los datos existen y se descartan**. `PLAN-V2.md:248`
ya identificó esto como el techo de la calibración de gravedad.

Sin giro, el vector de gravedad es un snapshot fijo tomado en reposo. Si la barra rota durante el
levantamiento, `a_vert` levanta componente horizontal en silencio y ningún filtro de los 9 de §5.2
lo detecta, porque **no es ruido: es señal, proyectada mal**.

Un paquete v2 de 34 bytes (+3 float32 de giro) habilita filtro complementario o Madgwick, que es
la solución real. Coste: +12 bytes por notify, holgado dentro del MTU.

**No hacerlo en este PR.** Pero la app conviene que quede preparada: si `protocol.py` despacha por
el byte de `version`, agregar v2 después es una función de parseo más y tres curvas más, no un
refactor. Es la única concesión a futuro que vale la pena en este plan.

*(Nota de metodología, opcional: para elegir el `MPU6050_BAND_*` óptimo se puede capturar una vez
con el DLPF bien abierto y emular offline cada banda más angosta. Pero a 100 Hz de muestreo con el
DLPF en 260 Hz **hay aliasing**, así que esa captura exigiría subir también `SAMPLE_INTERVAL_US`.
Es un experimento aparte, no parte de este plan.)*

---

## 11. Verificación de punta a punta

```bash
cd clients/desktop
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python test_dsp.py            # los 6 asserts pasan, sin hardware
.venv/bin/python app.py
```

Con el ESP32 encendido:

1. **Scan → Connect** → la barra muestra `conectado`, RSSI, y ~100 Hz en ambos contadores.
2. **Stream** — seq consecutivos, `dt_ms ≈ 10`, 0 malformados. Golpear la mesa: se ve el pico.
3. **Rec** 20 s (10 quieto, 10 moviendo) → **Stop** → aparece el CSV en `sessions/`.
4. **Accel** — en los 10 s quietos, un eje en ~9.8 y los otros dos cerca de 0. Si no, el sensor
   está montado distinto de lo asumido, y eso ya es un hallazgo de debug.
5. **Capturar reposo** → **Velocity** — con bias+detrend activos, `v` vuelve cerca de 0 tras cada
   movimiento. Destildar "remove gravity bias": aparece la rampa de 9.8 m/s². **Ambos
   comportamientos son la verificación**, no uno solo.
6. **Stats** — `median(az)` en reposo ≈ `mean(az)` ≈ |g| del eje vertical.
7. **Filters** — PSD con el grueso de la potencia bajo 10 Hz. Bajar el corte de 20 a 3 Hz y ver
   el pico de aceleración achicarse en la tabla de Stats: eso es el compromiso, cuantificado.
8. **Export** — pegar el snippet en `main.cpp` y compilar con `pio run`.
9. **Open…** el CSV del paso 3 sin sensor: las mismas gráficas, los mismos números.

El paso 9 es el que cierra el objetivo original: a partir de ahí, iterar filtros no necesita ni el
sensor ni un build.

---

## Fuentes consultadas sobre filtrado

- [Validation of Inertial Sensor to Measure Barbell Kinematics across a Spectrum of Loading Conditions](https://www.mdpi.com/2075-4663/8/7/93) — Butterworth 4º orden a 4 Hz sobre datos de acelerómetro.
- [Validation of an Automatic Inertial Sensor-Based Methodology for Detailed Barbell Velocity Monitoring](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9784026/) — LP a 25 Hz + Madgwick para quitar gravedad + ZUPT al inicio de cada concéntrica.
- [Filtering Biomechanical Signals in Movement Analysis](https://www.mdpi.com/1424-8220/21/13/4580) — comparación Savitzky–Golay vs Butterworth; SG preserva mejor los picos y no introduce retardo, Butterworth es más estable en los bordes.
- [Why and How Savitzky–Golay Filters Should Be Replaced](https://pubs.acs.org/doi/10.1021/acsmeasuresciau.1c00054) — las limitaciones de SG (banda de rechazo pobre) y cuándo no usarlo.
- [IMU-velocity-and-displacement-measurements](https://github.com/Wojtek120/IMU-velocity-and-displacement-measurements) — implementación de referencia de VBT con IMU: Madgwick + ZVU contra el drift.
