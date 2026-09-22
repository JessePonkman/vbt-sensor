# VBT Sensor — Plan de implementación v2: velocidad, gráficos y velas

> Documento de especificación para el agente que implementa. **Leelo entero antes de escribir código**,
> y además `PLAN.md` §1 (protocolo, sigue siendo la fuente de verdad) y `AGENTS.md` (reglas de Expo).
>
> Sucede a `PLAN.md`, que queda como registro histórico del MVP v1 y del que este documento
> **invalida explícitamente dos reglas**: "no tocar el firmware" (§1) y "una sola pantalla,
> sin navegación" (§3).

---

## 0. Contexto

La v1 está terminada y **validada en hardware real**: la app Android se conecta por BLE a la ESP32-S3,
negocia MTU 247, parsea los paquetes de 22 bytes y muestra el stream crudo. Lo que hay hoy es un
visor de aceleraciones — no calcula nada.

Esta iteración convierte ese visor en una herramienta de **VBT (velocity-based training)**: integra
la aceleración para obtener velocidad, segmenta repeticiones en fase excéntrica y concéntrica, y las
grafica. El objetivo del usuario, textual: ver gráficamente cómo se desplazó el movimiento, un
gráfico de velocidad, aceleraciones y velocidades medias, y una pantalla de velas donde cada vela
muestra velocidad máxima/mínima/promedio de una fase.

**Movimiento soportado: back squat, y solo back squat.** Otros movimientos son iteraciones futuras.

### Decisiones ya tomadas por el usuario — no re-litigar

| # | Decisión |
|---|---|
| 1 | Firmware sube a **100 Hz**, una muestra por notificación. Protocolo v1 sin cambios. |
| 2 | Sensor en la **barra, orientación arbitraria** → vector gravedad resuelto por calibración en reposo. |
| 3 | Gráficos con **`react-native-svg` a mano**. Nada de victory / skia / gifted-charts. |
| 4 | Captura con botones **Iniciar / Terminar serie**; reps auto-detectadas. **Solo en memoria**, sin persistencia. |
| 5 | Navegación con **Expo Router + tabs** (lo manda `AGENTS.md`). `App.tsx` se migra a `src/app/`. |
| 6 | **Una vela = una rep** de la serie actual. Dos gráficos: excéntrico y concéntrico. |

### Fuera de scope explícito (no implementar, no dejar scaffolding)

Persistencia en disco · historial entre sesiones · export CSV · backend · auth · iOS · selector de
series anteriores · movimientos que no sean squat · MPV (Mean Propulsive Velocity) · animaciones ·
gestos · tooltips · zoom/pan en los gráficos · tipo `Session`.

---

## 1. Firmware — tres cambios de una línea cada uno

`PLAN.md` §10 decía "no tocar el firmware". **Esta iteración lo invalida**: a 1 Hz una sentadilla
entera son ~2 muestras y no hay nada que integrar. Son tres cambios, todos en
`firmware/src/main.cpp`, y los tres son necesarios.

### 1.1 Sample rate

```c
#define SAMPLE_INTERVAL_US 10000   // era 1000000 (1 Hz). 100 Hz.
```

### 1.2 Bug de arranque: ráfaga de catch-up

`lastSampleTime` arranca en `0` (línea ~502) pero `setup()` quema ~2,5 s en `delay()`. En el primer
`loop()`, `micros()` ya vale ~3.000.000 mientras `lastSampleTime == 0`, y el acumulador
`lastSampleTime += SAMPLE_INTERVAL_US` avanza de a 10 ms por iteración.

**Resultado: ~300 paquetes disparados de corrido al inicio de cada sesión**, con `timestamp` reales
separados ~1 ms (el tiempo de lectura I2C), no 10 ms. A 1 Hz eran 3 paquetes y nadie lo notó. A
100 Hz envenena exactamente la ventana de calibración.

Arreglo — una línea al final de `setup()`:

```c
lastSampleTime = micros();   // sacar `static uint32_t lastSampleTime` del loop a scope de archivo
```

> `ponytail: solo arregla el arranque. Un stall de varios segundos a mitad de sesión reproduce la ráfaga. Upgrade: guarda `if ((uint32_t)(now - lastSampleTime) > 5*SAMPLE_INTERVAL_US) lastSampleTime = now;`. El cliente ya se defiende con DT_MIN_S, así que no hace falta hasta que se vea.*

### 1.3 El serial bloquea a 100 Hz

Cada línea de `printSerialPacket` son ~72 caracteres. A 115200 baudios 8N1 eso es
`72 × 10 / 115200 ≈ 6,2 ms`. El período a 100 Hz es 10 ms: el serial se come el **62% del
presupuesto del loop**, y cuando el buffer TX de la UART se llena (~3 paquetes) `Serial.print`
**bloquea**. La frecuencia efectiva cae por debajo de 100 Hz y se vuelve irregular.

Arreglo — imprimir 1 de cada N:

```c
#define SERIAL_DEBUG_EVERY 50    // ~2 líneas/s a 100 Hz. 0 = apagado.
if (SERIAL_DEBUG_EVERY && packet.sequence % SERIAL_DEBUG_EVERY == 0) printSerialPacket(packet);
```

Actualizar también el `Serial.println("Sampling frequency: 100 Hz")` de `setup()` para que deje de
mentir cuando alguien vuelva a cambiar la constante.

### 1.4 Verificación del firmware antes de tocar la app

Flashear y confirmar en el monitor serie que las `SEQ` avanzan de a `SERIAL_DEBUG_EVERY` y que el
delta de `TIME` entre dos líneas consecutivas es `SERIAL_DEBUG_EVERY × 10000 µs ± 5%`. Si el delta
es mayor, el loop no llega: bajar el rate o subir `SERIAL_DEBUG_EVERY`.

---

## 2. El núcleo de cálculo — `src/vbt.ts`

**Este es el corazón del plan.** Un archivo, **cero imports**, TypeScript puro. Sin React, sin BLE,
sin dependencias. Esa restricción es lo que hace que sea testeable sin hardware (§7) y no es
negociable: `node --test` tiene que poder cargarlo solo.

> **Restricción de sintaxis:** el type-stripping de Node rechaza TS que emite runtime. Nada de
> `enum`, `namespace`, ni parameter properties en constructores. Solo `type` y funciones. Por eso el
> integrador es `step(state, …)` sobre un objeto plano y no una clase.

### 2.1 Base de tiempo: el `timestamp` del ESP32, no `rxAt`

`rxAt` es `Date.now()` en el callback de la notificación. En Android ble-plx entrega en los bordes
del connection interval (7,5–50 ms), así que a 100 Hz **varias muestras llegan en ráfaga con `rxAt`
casi idéntico** seguidas de un hueco. El jitter es del orden del connection interval: ±20 ms sobre
un `dt` nominal de 10 ms, y no es de media cero dentro de una rep. Integrar con eso es inútil.

El `micros()` del ESP32 viene del timer group respaldado por cristal de 40 MHz: error de escala de
decenas de ppm (microsegundos a lo largo de una rep) y jitter sub-milisegundo. Es tres órdenes de
magnitud mejor.

`rxAt` conserva **exactamente** el trabajo que ya tiene en `useVbtStream.ts`: medir el `rateHz` que
se muestra en pantalla. No extenderlo.

```ts
const US_WRAP = 2 ** 32;

/** Delta wrap-safe entre dos lecturas uint32 de micros(). Es el truco C
 *  `(uint32_t)(now - last)`, exacto en doubles porque todo intermedio queda
 *  bajo 2^53. Solo ambiguo para huecos reales de >= 71,6 min, imposibles
 *  dentro de una serie — y DT_MAX_S resetea el pipeline igual. */
function deltaUs(prevUs: number, currUs: number): number {
  return (currUs - prevUs + US_WRAP) % US_WRAP;
}
```

`dt = deltaUs(prev, curr) / 1e6` segundos. Bandas de guarda:

| Condición | Acción |
|---|---|
| `dt < DT_MIN_S` (2 ms) | Descartar la muestra entera, **no** avanzar `prev`. Atrapa la ráfaga de boot de §1.2 y timestamps duplicados. |
| `dt > DT_MAX_S` (250 ms) | Discontinuidad dura. Reset total: `v=0`, `s=0`, filtro a 0, FSM a `idle`, descartar la rep en vuelo, **invalidar la calibración**. Cubre reboot del ESP32, stall del link, app en background. |
| `DT_GAP_S` (60 ms) `< dt ≤ DT_MAX_S` | Integrar normal, pero marcar `lossy = true` en la rep abierta. |

**No interpolar ni remuestrear a grilla uniforme.** Es la opción perezosa *y* la correcta: la
integración trapezoidal a través de un hueco, `Δv = ½(a_{n-1} + a_n)·Δt`, es *idénticamente* lo que
da interpolar linealmente la aceleración y integrar el interpolante. Remuestrear produciría los
mismos números más un remuestreador. Todo el pipeline trabaja sobre pares `(t, a)` de `dt` variable
— lo que obliga al filtro de §2.3 a recalcular su coeficiente por muestra.

`sequence` se usa **solo** para marcar pérdida (la lógica ya existe en `useVbtStream.ts`, incluido
el caso reboot-vuelve-a-0). Nunca para derivar tiempo.

### 2.2 Gravedad y orientación sin giróscopo

El giróscopo se lee en el firmware pero **no se transmite**. Con acelerómetro solo, y una barra que
casi no rota en una sentadilla, alcanza con un snapshot del vector gravedad.

```ts
export type Calibration = { ux: number; uy: number; uz: number; gMag: number };
```

**Ventana:** los últimos `CALIB_MS = 1000` ms, exigiendo al menos `CALIB_MIN_SAMPLES = 50` muestras
presentes (guarda contra calibrar sobre 6 paquetes sobrevivientes de un segundo con pérdida).

**Estimador — promediar los *vectores*, no las magnitudes:**

```
g = (1/N) Σ aᵢ        gMag = ‖g‖        û = g / gMag
```

Promediar el vector cancela el ruido de media cero por eje. Promediar magnitudes **no**: `‖·‖` es
convexa, así que la media de magnitudes queda sesgada hacia arriba en ~σ²/2g.

**Validación de reposo — desviación RMS 3-D respecto del vector medio** (rotación-invariante, un
solo número, y es la cantidad que realmente importa: cuánto vagó el vector):

```
rms = sqrt( (1/N) Σ ‖aᵢ − g‖² )  ≤  CALIB_STILL_RMS
```

Rechazar si `rms` se pasa, **y también** si `gMag ∉ [8.5, 11.0]` — esa segunda puerta atrapa
calibrar en movimiento, un registro de rango mal puesto, y un eje muerto.

`CALIB_STILL_RMS = 0.12` m/s² es el valor de arranque. Razonamiento: la densidad de ruido del
MPU6050 es ~400 µg/√Hz, así que con ancho de banda 21 Hz el RMS por eje es
`400e-6 × 9.81 × √21 ≈ 0.018` m/s², o sea ≈ 0.032 m/s² para el vector 3-D. 0.12 es ~4σ de ruido
puro, dejando margen para el balanceo postural de una persona bajo una barra cargada.
**Es la perilla que más probablemente haya que mover en el gimnasio.** Si la calibración nunca
dispara, subir esta primero, de a poco, y loguear el `rms` observado para que el ajuste sea por
datos y no por adivinanza.

#### Usar la magnitud **medida**, jamás 9.81

Es la línea más importante de esta sección. El MPU6050 a ±8 g tiene error de escala inicial de hasta
±3% y offset de cero-g de hasta ±80 mg por eje. Si el dispositivo lee 10.10 m/s² en reposo, usar el
valor de tabla deja un residuo permanente de `10.10 − 9.81 = 0.29` m/s², que en una rep de 2 s
integra a **0.58 m/s de pura ficción** — comparable a la señal entera.

Usar `gMag` hace que `a_vert` sea exactamente 0 en reposo **por construcción**: convierte el error
de escala y el offset del sensor en una constante calibrada.

Lo que esto **no** arregla, dicho con honestidad: el error de escala sobre la parte *dinámica*
sobrevive. Un 3% de error de escala da velocidades 3% altas. La práctica de VBT es abrumadoramente
de ratios dentro de una sesión (pérdida de velocidad %, pendiente carga-velocidad), así que un 3%
consistente es aceptable.

> `ponytail: calibración de una sola pose — cancela offset+escala solo sobre el eje de gravedad, así que las velocidades dinámicas heredan el ~3% de error de escala del MPU6050. Techo: ~3% de exactitud absoluta, los ratios quedan bien. Upgrade: calibración estática de seis posiciones (sensor sobre cada cara, resolver escala+offset por eje), guardada una vez por dispositivo.*

#### Convención de signo: positivo es arriba

Un acelerómetro en reposo mide **fuerza específica**, o sea lee **+g sobre el eje que apunta hacia
arriba**. Por lo tanto `û` tal como se calculó arriba ya apunta hacia arriba en el marco del sensor:

```
a_vert = a · û − gMag        (positivo = la barra acelera hacia arriba)
```

Sanity check con los números de `PLAN.md` §1.1: sensor plano, `az ≈ 9.8` → `û = (0,0,1)`,
`gMag = 9.8`. Levantarlo con 1 m/s² reales hacia arriba hace que el chip lea `az = 10.8`, dando
`a_vert = +1.0`. Correcto. **Este check va al test** (§7.3).

#### El tracker continuo de gravedad: rechazado, con una parte aceptada

La alternativa de manual es `a_dynamic = a − lowpass(a, ~0.1–0.5 Hz)`, siguiendo la gravedad de
forma continua. Rechazada, por tres razones:

1. **No tiene corte válido para esta señal.** Una rep de sentadilla dura 1–4 s, así que su contenido
   de aceleración arranca cerca de 0.25 Hz. Cualquier tracker rápido como para seguir un cambio real
   de orientación también es rápido como para absorber parte de la aceleración excéntrica/concéntrica
   y sesgar las velocidades hacia abajo; cualquiera lento como para ser seguro no está siguiendo
   nada. El trade-off no tiene buen punto.
2. **No hay nada que seguir.** Una barra apoyada en la espalda no rota: la dirección de la gravedad
   es constante dentro de una serie con error muy por debajo de un grado.
3. **Su efecto útil se obtiene mejor en otro lado.** El único beneficio real — sacar el drift DC
   lento de `a_vert` — es exactamente lo que hacen el ZUPT y el detrend por rep de §2.4, y lo hacen
   anclados en física (la velocidad *tiene* que ser cero cuando la persona está parada quieta) en
   vez de en una constante de tiempo elegida a dedo. Entre una corrección justificada por una
   condición de borde y una justificada por un corte ajustable, se toma la condición de borde.

**Aceptado, acotado: re-estimar la calibración durante idle detectado.** Cada vez que la FSM esté en
`idle` con el detector de reposo en true por `RECAL_IDLE_MS = 1500` ms, correr `calibrate()` sobre
esa ventana y adoptar el resultado si pasa. Como mucho una vez por período de idle (un booleano que
se limpia al salir de `idle`). Esto da todo lo que ofrecía el tracker — drift térmico del bias, el
sensor que se movió, la persona que re-racked y se volvió a acomodar — en ~5 líneas, reusando el
detector de reposo que ya existe para el ZUPT, y **estructuralmente no puede correr durante una rep**,
así que no puede comerse señal.

> `ponytail: vector de gravedad fijo desde un snapshot en reposo, re-estimado en idle. Techo: se rompe para cualquier levantamiento donde la barra rote de verdad (arranque, envión, un press con recorrido en arco) — a_vert levantaría una componente horizontal en silencio. Upgrade: giróscopo en el paquete v2 (cambio de firmware) + filtro complementario sobre el tilt.*

### 2.3 Filtrado

**Respuesta honesta primero: el filtrado extra es casi innecesario. Se pone igual porque cuesta dos
líneas.**

- El DLPF on-chip a 21 Hz (`MPU6050_BAND_21_HZ`, ~8,5 ms de retardo de grupo) ya provee el
  anti-aliasing que exige muestrear a 100 Hz (Nyquist 50 Hz). Ese trabajo está hecho, en hardware.
- El contenido de velocidad de una sentadilla está esencialmente todo por debajo de 5 Hz; el de
  aceleración por debajo de ~10 Hz. El traqueteo de los discos y el golpe del rack viven en 15–30 Hz.
- **La integración es en sí misma un pasa-bajos** con respuesta 1/f. El ruido de banda ancha por
  encima de unos pocos Hz no aporta casi nada a la velocidad. Lo que destruye la velocidad es el
  bias DC, y ningún pasa-bajos saca DC — eso lo hacen §2.2 y §2.4.

El filtro es cosmético para las métricas y útil para el **display en vivo** (un número que tiembla
en pantalla se lee como una app rota).

**Recomendación: IIR de un polo a `LPF_HZ = 10` sobre el escalar `a_vert`.** Filtrar el escalar y no
los tres ejes: la proyección `a·û` es lineal, así que filtrar la proyección es idéntico a proyectar
el filtrado, a un tercio de la aritmética.

```ts
// Pasa-bajos de un polo. alpha se recalcula por muestra desde el dt real, que
// es lo que hace correcto a este filtro ante paquetes perdidos — un Butterworth
// de coeficientes fijos necesitaría la grilla uniforme que deliberadamente no
// tenemos (§2.1). Poner LPF_HZ muy alto manda RC -> 0, alpha -> 1, o sea
// passthrough: el filtro se apaga desde la tabla de tuning sin branch.
const rc = 1 / (2 * Math.PI * T.LPF_HZ);
const alpha = dt / (dt + rc);
y += alpha * (x - y);
```

A `LPF_HZ = 10`: `rc = 15.9` ms; con `dt = 10` ms, `alpha ≈ 0.386`.

Rechazadas: **media móvil** (banda de rechazo dentada con lóbulos a solo 13 dB, necesita ring
buffer, y se rompe con `dt` variable — estrictamente peor por el mismo esfuerzo) y **Butterworth**
(necesita coeficientes precalculados para frecuencia fija, que el diseño de `dt` variable no provee,
a 4× el código para un rolloff que la integración ya aporta).

**Retardo de fase:** el polo agrega ≈ `rc` = 16 ms sobre los 8,5 ms del DLPF → ~25 ms. Contra fases
de 500–3000 ms es despreciable, y es un retardo *común* a toda la señal, así que no sesga magnitudes.
No compensar.

**Inicialización:** el estado arranca en 0, que es el valor de reposo correcto de `a_vert` por
construcción (§2.2). No hay transitorio de arranque que esperar.

### 2.4 Integración y control de drift — dos pasadas

#### Regla de integración: trapezoidal

```
vₙ = vₙ₋₁ + ½(aₙ₋₁ + aₙ)·Δtₙ          sₙ = sₙ₋₁ + ½(vₙ₋₁ + vₙ)·Δtₙ
```

Trapezoidal sobre rectangular, por tres razones y a costo cero — es la misma línea:

1. Rectangular (Euler) tiene error local O(Δt) cuyo signo sigue al de `da/dt`, así que **no** se
   promedia a cero: se acumula como offset *sistemático* de velocidad a lo largo de la rep.
   Trapezoidal es exacta para aceleración lineal en el tiempo y su error es O(Δt²) con signo
   alternante sobre un perfil curvo.
2. A través de un paquete perdido, trapezoidal *es* exactamente la interpolación lineal de la
   aceleración (§2.1). Rectangular sostiene el valor viejo a través del hueco.
3. No hay trade-off que pesar. Cuando dos opciones son del mismo tamaño, se toma la correcta en los
   bordes.

#### Las dos pasadas

| | Cuándo | Qué produce |
|---|---|---|
| **Pasada A — streaming** | dentro de `push()`, por muestra | calibración, LPF, integrador, detector de reposo, FSM de segmentación. Produce `live.vVert`, el número en pantalla. Arrastra el drift acumulado desde el último ZUPT. |
| **Pasada B — retroactiva** | una sola vez, al cerrar una rep, sobre la ventana bufferada | Las métricas reportadas. Exacta. |

**Decir esto en el texto de la UI, no solo en un comentario:** el número en vivo es feedback de que
el sistema está vivo y siguiendo; el número del log de reps es la medición. Así se comportan también
las unidades comerciales de VBT, y es la razón por la que el diseño puede permitirse ser simple.

#### ZUPT (solo pasada A)

La trampa, dicha explícitamente porque es la forma más fácil de hacer esto mal: **a mitad del
descenso, la aceleración vertical de una sentadilla pasa por cero** (velocidad constante en el medio
de la excéntrica). Un detector de reposo basado solo en aceleración dispara ahí y anula una
velocidad genuinamente distinta de cero, destripando la excéntrica.

Dos discriminadores independientes, ambos requeridos:

1. **Duración de ventana.** `still(i)` es true sii, sobre *todas* las muestras bufferadas en
   `[tᵢ − STILL_WIN_MS, tᵢ]`, el RMS del `a_vert` filtrado es ≤ `STILL_ACC_RMS`, y está presente al
   menos la mitad del conteo nominal de muestras. El perfil de velocidad de una sentadilla es curvo
   en todo su recorrido, así que `|a_vert|` está cerca de cero solo en un *instante* (el pico de
   velocidad), nunca por 300 ms continuos. **La longitud de la ventana *es* el discriminador.**
2. **Compuerta de velocidad.** Aplicar el clamp duro solo cuando `|v_live| < ZUPT_V_MAX = 0.30` m/s.
   Una excéntrica de sentadilla corre a 0.4–1.2 m/s en su pico.

Con ambas: `v_live = 0`, `s_live = 0`.

Implementación del detector: escanear hacia atrás desde `i` por el buffer `{t, aVert}` hasta que `t`
salga de la ventana. A 100 Hz sobre 300 ms son 30 iteraciones por muestra, 3000 operaciones por
segundo. No construir sumas incrementales.

> `ponytail: escaneo hacia atrás O(ventana) por muestra para el detector de reposo (~30 iteraciones a 100 Hz / 300 ms). Upgrade: suma corrida de cuadrados con índices head/tail — solo si un profiler lo pide, cosa que no va a pasar.*

#### Corrección de drift por rep (pasada B) — el meollo

La ventana de la rep va de una muestra que se sabe quieta a otra que se sabe quieta. La física impone
entonces una condición de borde: `v(t₀) = 0` **y** `v(T) = 0`.

Re-integrar limpio sobre `[startIdx, endIdx]` desde `v = 0`, usando el `a_vert` **filtrado
almacenado** — no re-correr el filtro (doble filtrado), y **no reusar la `v` viva de la pasada A**,
porque tiene clamps de ZUPT horneados adentro que corromperían la estimación de la tendencia. Es un
bug fácil y silencioso; el aviso va en el comentario del código.

Lo que salga como `v(T)` es enteramente error. El residuo dominante después de §2.2 es un **bias
constante** del acelerómetro (drift térmico, el residuo de segundo orden de la proyección, lo que
sobra de una calibración levemente vieja). Un bias constante produce un error de velocidad que es
*exactamente* lineal en el tiempo, `e(t) = b·(t − t₀)`. Entonces el detrend lineal **no es una
heurística — es el inverso exacto del modelo de error dominante**:

```
b̂ = v(T) / (T − t₀)          v_corr(tᵢ) = v(tᵢ) − b̂·(tᵢ − t₀)
```

```ts
/** Un bias residual constante del acelerómetro produce un error de velocidad
 *  exactamente lineal en el tiempo. La rep empieza y termina en reposo, así que
 *  la velocidad terminal ES ese error y b_hat = v(T)/T. Esto es el inverso
 *  exacto del modelo de bias constante, no un factor de corrección inventado.
 *  OJO: v tiene que venir de una re-integración limpia del a_vert filtrado
 *  almacenado, NO de la velocidad viva de la pasada A — esa tiene clamps de
 *  ZUPT que harían que v(T) no signifique nada. */
function detrend(t: readonly number[], v: number[]): number {
  const span = t[t.length - 1] - t[0];
  if (span <= 0) return 0;
  const bias = v[v.length - 1] / span;          // m/s^2
  for (let i = 0; i < v.length; i++) v[i] -= bias * (t[i] - t[0]);
  return bias;   // devolverlo: un |bias| grande es aviso de recalibrar / hardware
}
```

Devolver `bias` y exponerlo. Una magnitud por encima de ~0.1 m/s² significa que la calibración se
puso vieja o el sensor se movió; es un diagnóstico que sale gratis.

> `ponytail: detrend lineal (bias constante) nada más. Techo: un bias que rampa dentro de una sola rep deja residuo cuadrático. Upgrade: ajuste cuadrático por mínimos cuadrados sobre la ventana, ~6 líneas — hacerlo solo si los datos reales muestran residuos de v(T) post-detrend que un bias constante no explique.*

Después, integrar `v_corr` a desplazamiento desde `s = 0` en `startIdx`.

#### Desplazamiento como compuerta de sanidad

Tres compuertas sobre la ventana, todas baratas, todas rechazando la rep con un motivo nombrado:

| Compuerta | Valor | Qué atrapa |
|---|---|---|
| `ROM_MIN_M ≤ \|s_max − s_min\| ≤ ROM_MAX_M` | 0.20 – 1.00 m | caminar, rebote de la barra, traqueteo de discos; explosiones absurdas de la integración |
| `\|s_end − s_start\| ≤ ROM_RETURN_MAX_M` | 0.15 m | la barra tiene que volver a donde arrancó — atrapa walkouts, re-racks, y cualquier rep cuya integración se disparó |
| `REP_MIN_MS ≤ T ≤ REP_MAX_MS` | 600 – 8000 ms | tirones; candidatas que nunca cerraron |

La segunda es **el filtro individual de falsas reps más fuerte del sistema** y es la razón por la
que vale la pena calcular desplazamiento. Mantenerla.

#### Buffering — concreto

Un array de registros por muestra, en un `useRef` dentro del provider (§4 — el hook ya tiene
exactamente este patrón para `bufferRef`):

```ts
type Frame = { t: number; aVert: number; still: boolean; lossy: boolean };
```

Cuatro números por muestra a 100 Hz. Retención `HISTORY_S = 20` s = 2000 frames, recortados con el
mismo `splice(0, len - MAX)` del buffer existente. Una rep de sentadilla más su entrada y salida en
reposo no llega a 10 s; `REP_MAX_MS = 8000` garantiza que ninguna candidata sobreviva al buffer.

**Los límites de rep se guardan como índices, y el array se recorta por adelante** — así que los
índices se almacenan como *offsets de un contador monotónico*, no posiciones crudas del array.
(Guardar `frameIndex` al lado y restar el conteo de recortes. Un entero.)

Este buffer vive en el objeto procesador dentro de `vbt.ts`, **no** en React.

### 2.5 Segmentación de reps y fases

Corre en pasada A sobre la velocidad viva. Causal por necesidad.

```
IDLE ──v < V_START──> DESCENDING ──v > V_TURN──> TURNAROUND ──v > V_UP──> ASCENDING ──v < V_END──> IDLE
                           ▲                          │
                           └──── v < V_START ─────────┘   (rebote / re-dip abajo: la misma rep)
```

```ts
export type RepState = 'idle' | 'descending' | 'turnaround' | 'ascending';
```

| Transición | Condición |
|---|---|
| IDLE → DESCENDING | `v < V_START` (−0.15 m/s). Latchear un inicio provisional; **confirmar** solo después de que `v` se haya mantenido bajo `V_START` de forma continua por `MIN_ECC_MS` (250 ms). Si vuelve a subir antes, descartar y volver a IDLE. `startIdx` = el último frame con `still` true; si no hay ninguno en el buffer, el índice del cruce menos `LEAD_MS` (200 ms). |
| DESCENDING → TURNAROUND | `v` sube por encima de `V_TURN` (−0.05 m/s) |
| TURNAROUND → DESCENDING | `v` vuelve a caer bajo `V_START`. **Conservar el `startIdx` original** — alguien que re-dipea abajo hizo una rep, no dos. |
| TURNAROUND → ASCENDING | `v > V_UP` (+0.15 m/s), sostenido `MIN_CON_MS` (200 ms) |
| ASCENDING → IDLE (cierra la rep) | `v` cae bajo `V_END` (+0.05 m/s) y se queda por `END_HOLD_MS` (200 ms), **o** dispara el detector de reposo. `endIdx` = ese frame. Correr pasada B; emitir la rep o un rechazo tipado. |
| cualquiera → IDLE (aborto) | duración total de la candidata > `REP_MAX_MS` (8000 ms), o discontinuidad `dt > DT_MAX_S`. Descartar en silencio. |

No hay tope de permanencia en TURNAROUND más allá de `REP_MAX_MS`: una sentadilla con pausa es una
rep legítima y no se tira.

**Todos estos números son conjeturas de arranque, no mediciones.** Salen de cinemática típica de
back squat, no de este sensor sobre esta barra. Esperar tener que ajustar `V_START`, `V_UP` y
`MIN_ECC_MS` en la primera sesión real. Viven todos en una tabla exportada (§2.7) y el procesador
acepta un `Partial<VbtTuning>` para que el test los fije.

**Rechazo de falsas reps, por mecanismo:**

| Evento | Qué lo mata |
|---|---|
| **Walkout** | El bamboleo vertical de la barra es ~0.03 m a ~2 Hz. Aunque un semiciclo cruce `V_START`, nunca lo sostiene `MIN_ECC_MS`, y la compuerta `ROM_MIN_M = 0.20 m` lo liquida. **La compuerta de ROM es el filtro primario acá** — los umbrales de velocidad solos no alcanzan y no hay que confiar en ellos. |
| **Re-rackear** | Caída seca sobre los ganchos sin ascenso: la FSM queda en DESCENDING/TURNAROUND y aborta por `REP_MAX_MS`. Si igual produce un ascenso, `ROM_RETURN_MAX_M` atrapa el desplazamiento neto hacia abajo. |
| **Des-rackear** | Movimiento puro hacia arriba. De IDLE solo se sale por un cruce *hacia abajo*, así que nunca abre candidata. |
| **Traqueteo de discos, latigazo de barra** | 15–30 Hz. Atenuado por el DLPF, el LPF de 10 Hz, y el 1/f de la integración; después por `MIN_ECC_MS`. |
| **Pérdida de paquetes dentro de una rep** | Cualquier frame con `dt > DT_GAP_S` marca `lossy` en la candidata. **Reportar la rep con la marca en vez de tirarla en silencio** — y mostrar la marca en la UI. Un número equivocado presentado como correcto es peor que un número marcado como sospechoso. |

### 2.6 Métricas por rep

#### Límites de fase: la detección usa umbrales de velocidad, la medición usa extremos de desplazamiento

Esta distinción es un punto de diseño real, no pedantería. Los cruces de umbral de §2.5 son lo que
un detector *causal* puede ver en tiempo real, y están sesgados — la excéntrica "arranca" recién
cuando `v` ya llegó a −0.15 m/s. Para los números reportados, la pasada B es no-causal y puede
hacerlo mejor:

- `onsetIdx` = primer frame después de `startIdx` con `|v_corr| > V_MOVE` (0.05 m/s), retrocedido
  hasta el último cruce por cero anterior.
- `turnIdx` = **argmin de `s`** sobre la ventana — la posición más baja de la barra. Físicamente el
  límite exacto de fase, y exactamente donde `v` cruza cero.
- `offsetIdx` = último frame antes de `endIdx` con `|v_corr| > V_MOVE`.

Excéntrica = `[onsetIdx, turnIdx]`. Concéntrica = `[turnIdx, offsetIdx]`.

```ts
export type PhaseMetrics = {
  peakVelocity: number;    // extremo con signo en la dirección de la fase (ecc: min v, con: max v)
  minVelocity: number;     // extremo con signo en la dirección opuesta
  meanVelocity: number;    // con signo
  durationMs: number;
  rangeOfMotion: number;   // metros, absoluto
};

export type Rep = {
  index: number;
  startedAtMs: number;            // rxAt del inicio de ventana, para la UI/log
  eccentric: PhaseMetrics;
  concentric: PhaseMetrics;
  peakConcentricVelocity: number; // el titular de VBT
  meanConcentricVelocity: number; // el otro titular
  timeToPeakMs: number;
  totalDurationMs: number;
  residualBias: number;           // de detrend(), diagnóstico de calibración vieja
  lossy: boolean;
};

export type RejectedRep = { reason: 'rom' | 'return' | 'duration' | 'gap'; startedAtMs: number };
```

**La velocidad media es desplazamiento sobre duración.** Por la identidad trapezoidal, `∫v dt` sobre
la fase *es* `s_end − s_start`, exactamente, con la misma numérica ya calculada:

```
v̄ = (s_end − s_start) / (t_end − t_start)
```

Una línea, sin segundo loop de acumulación, y garantizado consistente con el ROM reportado.
**No volver a sumar velocidades.**

Exponer los rechazos en vez de tragárselos. Si las compuertas están mal calibradas, la única forma
de enterarse es ver qué tiraron.

#### MPV (Mean Propulsive Velocity): afuera del MVP

La definición estándar (Sánchez-Medina & González-Badillo) es la velocidad media sobre la porción de
la concéntrica en la que la aceleración de la barra es ≥ −g. Con `a_vert` ya sin gravedad, esa
condición es exactamente: la fase propulsiva termina en el primer `i` concéntrico con
`a_vert,i < −gMag`.

**Dejarla afuera.** MPV existe para corregir la fase de frenado en levantamientos no balísticos a
carga submáxima — importa en press de banca y con cargas livianas donde el implemento puede
desacelerar libre. En una sentadilla con la barra en la espalda, la barra prácticamente nunca alcanza
desaceleración de caída libre durante el ascenso, así que MPV y MV coinciden dentro del ruido.
Agregarla ahora sería una métrica que reporta el mismo número que otra.

> `ponytail: solo MV, sin MPV. Techo: MPV y MV divergen para press de banca y levantamientos balísticos a carga liviana. Upgrade: escanear la concéntrica buscando el primer a_vert < -gMag y promediar el prefijo — el buffer de frames ya guarda a_vert, así que son 3 líneas cuando entre press de banca al scope.*

### 2.7 La tabla de tuning — un solo lugar, nombrada, documentada

Exportada arriba de `vbt.ts`. Esto es el requisito de "perillas de calibración" y la respuesta a
"nada de números mágicos desparramados".

```ts
/** Todo número sobre el que el mundo físico tiene voto. Los valores de arranque
 *  están razonados desde cinemática de back squat y la hoja de datos del
 *  MPU6050, NO medidos en este hardware — esperar mover varios después de la
 *  primera sesión real. createVbtProcessor toma un Partial<VbtTuning> para que
 *  los tests los fijen. */
export const VBT_TUNING = {
  // --- base de tiempo (§2.1) ---
  DT_MIN_S: 0.002,          // por debajo: ráfaga de boot del firmware / timestamp duplicado -> descartar
  DT_MAX_S: 0.250,          // por encima: reboot o stall -> reset total del pipeline
  DT_GAP_S: 0.060,          // por encima, dentro de una rep -> marcar la rep lossy

  // --- calibración de gravedad (§2.2) ---
  CALIB_MS: 1000,
  CALIB_MIN_SAMPLES: 50,
  CALIB_STILL_RMS: 0.12,    // m/s^2, desviación 3-D del vector medio. PERILLA MÁS FLOJA —
                            //   subir esta primero si la calibración nunca dispara en el gimnasio.
  CALIB_G_MIN: 8.5,         // m/s^2, rechazar |g| fuera de esto: en movimiento, o registro de rango mal
  CALIB_G_MAX: 11.0,
  RECAL_IDLE_MS: 1500,      // re-estimar gravedad tras este idle-quieto continuo

  // --- filtro (§2.3) ---
  LPF_HZ: 10,               // un polo sobre a_vert. Subir muy alto para desactivar (RC->0 => passthrough).

  // --- detección de reposo / ZUPT (§2.4) ---
  STILL_WIN_MS: 300,        // tiene que superar la permanencia en casi-cero-accel de mitad de descenso
  STILL_ACC_RMS: 0.15,      // m/s^2 sobre el a_vert filtrado
  ZUPT_V_MAX: 0.30,         // m/s, segundo discriminador contra anular a mitad de rep

  // --- segmentación (§2.5) — todos provisorios, ajustar con datos reales ---
  V_START: -0.15,           // m/s, IDLE -> DESCENDING
  MIN_ECC_MS: 250,          // sostén requerido para confirmar el descenso
  V_TURN: -0.05,            // m/s, DESCENDING -> TURNAROUND
  V_UP: 0.15,               // m/s, TURNAROUND -> ASCENDING
  MIN_CON_MS: 200,
  V_END: 0.05,              // m/s, ASCENDING -> IDLE
  END_HOLD_MS: 200,
  V_MOVE: 0.05,             // m/s, refinamiento de límite de fase en pasada B
  LEAD_MS: 200,             // entrada de ventana cuando no hay frame quieto disponible
  REP_MIN_MS: 600,
  REP_MAX_MS: 8000,         // también el timeout de aborto de candidata

  // --- compuertas de sanidad por desplazamiento (§2.4) ---
  ROM_MIN_M: 0.20,
  ROM_MAX_M: 1.00,
  ROM_RETURN_MAX_M: 0.15,   // la barra tiene que volver a donde arrancó

  // --- buffering (§2.4) ---
  HISTORY_S: 20,
} as const;

export type VbtTuning = typeof VBT_TUNING;
```

### 2.8 API pública de `vbt.ts`

```ts
export type RawSample = Pick<VbtSample, 'timestamp' | 'ax' | 'ay' | 'az' | 'sequence'>;
//  ^ el tipo se re-declara a mano en vbt.ts (cero imports); protocol.ts es la fuente de verdad.
//    NO recibe rxAt ni raw: el procesador no toca React ni BLE.

export type LiveState = {
  calibrated: boolean;
  still: boolean;
  state: RepState;
  aVert: number;
  vVert: number;   // aproximada — ver §2.4, "las dos pasadas"
};

export type VbtProcessor = {
  push(s: RawSample): void;
  readonly live: LiveState;
  takeReps(): { reps: Rep[]; rejected: RejectedRep[] };  // drena desde la última llamada
  reset(): void;
};

export function createVbtProcessor(tuning?: Partial<VbtTuning>): VbtProcessor;

/** Entrada batch. Tres líneas: crear procesador, loop, drenar. */
export function analyzeSession(
  samples: readonly RawSample[],
  tuning?: Partial<VbtTuning>,
): { reps: Rep[]; rejected: RejectedRep[]; calibration: Calibration | null };
```

`analyzeSession` **no es una implementación paralela** — es un `for` sobre `push()` más un
`takeReps()`. Esto importa: el test ejercita el camino de código de producción exacto, incluida la
causalidad de la FSM, en vez de un gemelo batch que podría desincronizarse.

---

## 3. Migración a Expo Router

### 3.1 Instalación

```bash
npx expo install expo-router react-native-safe-area-context react-native-screens react-native-svg
```

Omitidos deliberadamente de la línea de instalación de los docs: `expo-linking` y `expo-constants`
(presentes transitivamente, y nada hace deep-link), `expo-status-bar` (ya es dependencia),
`react-native-web`/`react-dom` (app solo Android).

⚠ **Los cuatro son módulos nativos → el dev client instalado queda viejo.** `npx expo run:android`
es obligatorio después de este paso; `npx expo start` solo va a fallar en runtime con "native module
not found". Documentarlo en el README.

### 3.2 Diffs de configuración

`package.json`: `"main": "expo-router/entry"`, y borrar `index.ts`.

`app.json` — dos claves dentro de `expo`:
```json
"scheme": "vbtsensor",
"plugins": ["expo-router", ["react-native-ble-plx", { ...sin cambios... }]]
```

**Omitido:** `experiments.typedRoutes` (requiere ensanchar `tsconfig.include` para levantar
`.expo/types/**/*.ts` y generar esos tipos antes de que `tsc --noEmit` pase; son 4 rutas, todas
alcanzadas tocando el tab bar, cero `router.push()`). También omitido el alias `@/*`:
`src/app/raw.tsx` importando `../stream` son dos puntos.

> `ponytail: sin typedRoutes; prenderlo cuando alguna pantalla empiece a tomar params.*

`tsconfig.json`, `eslint.config.js`, babel, metro: **sin cambios**. No existe `babel.config.js` ni
`metro.config.js` en el proyecto, y `src/app` es auto-detectado por expo-router sin configurar
`root`.

### 3.3 Dónde viven la conexión BLE y el buffer

**Recomendación: un provider de React context plano en `src/app/_layout.tsx`, partido en dos
contextos, apoyado sobre el ref-buffer y el ticker de 100 ms que ya existen. No
`useSyncExternalStore`.**

Lo único que un store a nivel módulo compra por encima de context es suscripción por slice, para que
una publicación a 10 Hz no re-renderice pantallas a las que no les importa. **Partir en dos contextos
compra lo mismo por cuatro líneas**, y no cuesta reescribir el camino de publicación de
`useVbtStream`, ni un set de listeners a mano, ni el footgun de identidad de `getSnapshot`
(`useSyncExternalStore` con un selector que aloca → loop infinito de render; evitarlo significa
devolver el snapshot entero, que re-renderiza a todos, que es el problema del que partiste).

| Contexto | Cambia | Contenido |
|---|---|---|
| `ConnCtx` | solo por acción del usuario / evento BLE | `appState`, `adapterState`, `permissionDenied`, `notice`, `devices[]`, `device`, `rssi`, `calibrated`, `setPhase`, `sets[]`, y las acciones `scan() select() disconnect() startSet() endSet() recalibrate()` |
| `LiveCtx` | republicado cada 100 ms | `rows[]`, `stats`, `win` (6 `number[]` paralelos de los últimos 3 s), `repCount`, `setElapsedMs` |

`src/app/set.tsx` y `src/app/candles.tsx` consumen **solo `ConnCtx`** — leen `sets[sets.length - 1]`,
que es un snapshot congelado publicado una vez al Terminar serie. Son estructuralmente incapaces de
re-renderizar a 10 Hz. `index.tsx` y `raw.tsx` consumen ambos.

Queda un residuo: Live y Raw se suscriben a `LiveCtx`, así que la que está desenfocada igual
re-renderiza a 10 Hz. Se arregla con la plataforma, no con código:
`<Tabs screenOptions={{ freezeOnBlur: true }}>`. **VERIFICAR** que esté cableado en el `Tabs` de
expo-router para SDK 57 y si `enableFreeze()` todavía hay que llamarlo. Si no funciona, el costo es
una pantalla desenfocada reconciliando a 10 fps: sobrevivible. **El diseño no depende de esto.**

### 3.4 Reemplazo del truco `key={sessionId}`

El truco muere: el provider queda por encima del router, así que remontarlo para resetear remontaría
todas las pantallas. No intentar preservarlo con un wrapper interno keyed — cambiar la key de un
componente que recibe `children` igual desmonta ese subárbol.

Se reemplaza por un reset explícito, hecho trivial al colapsar primero **los siete refs de
`useVbtStream` en un solo ref con un objeto**:

```ts
const fresh = () => ({
  rows: [] as LogRow[],
  lastSeq: null as number | null,
  packets: 0, malformed: 0, lost: 0,
  rxTimes: [] as number[],
  win: { t: [] as number[], ax: [] as number[], ay: [] as number[],
         az: [] as number[], a: [] as number[], v: [] as number[] },
  proc: createVbtProcessor(),
  rec: null as Recording | null,          // no-null solo mientras corre una serie
});
const buf = useRef(fresh());

const reset = useCallback(() => {
  buf.current = fresh();
  setRows([]);
  setStats(EMPTY_STATS);
}, []);
```

`reset()` se llama al conectar con éxito. Es una **simplificación neta** del archivo actual (7 refs
→ 1) y, críticamente, agregar un campo nuevo más adelante ya no se puede olvidar en el camino de
reset — cosa que la versión de siete refs permitiría en silencio. Reemplazar también el bloque de
comentario del tope de `useVbtStream.ts`, que documenta el truco ahora muerto.

---

## 4. Pantallas

Cuatro tabs, sin grupo `(tabs)`, sin Stack anidado. `src/app/_layout.tsx` renderiza el provider y
`<Tabs>` directo.

| Ruta | Tab | Dueña de |
|---|---|---|
| `index.tsx` | Live | scan/connect (cuando está desconectado), calibración, Iniciar/Terminar serie, gráficos vivos de accel y velocidad, medias vivas |
| `set.tsx` | Serie | última serie completada: gráficos completos de accel y velocidad, medias, tabla por rep |
| `candles.tsx` | Velas | gráficos de velas excéntrico y concéntrico |
| `raw.tsx` | Raw | el `StreamPanel` de hoy, textual |

Scan/connect queda como condicional en el tab Live, exactamente como hace `App.tsx` hoy — sin ruta
modal, sin stack.

⚠ **`@expo/vector-icons` NO está instalado** y no está en la lista de dependencias permitidas. Los
íconos de tab salen de 4 strings de path SVG inline usando el `react-native-svg` que ya estamos
agregando.

### 4.1 Live — conectado, en reposo

```
┌────────────────────────────────┐
│ VBT Sensor          ● CONNECTED│
│ VBT-ESP32 │ -54 dBm │ 99.8 Hz  │
├────────────────────────────────┤
│  ⚠ Sin calibrar                │
│  [   Calibrar e iniciar serie ]│   ← primario, colors.connected
├────────────────────────────────┤
│   0.00        0.00        0    │   ← StatTile ×3 (reusado tal cual)
│  vel media  acc media    reps  │
├────────────────────────────────┤
│ ACELERACIÓN m/s²    -2.1…2.4   │   ← RN Text, no SVG text
│ ┌────────────────────────────┐ │
│ │        ╱╲    ___           │ │
│ │───────╱──╲──╱───╲──────────│ │   ← línea de cero, colors.surface
│ │            ╲   ╱           │ │
│ └────────────────────────────┘ │
│ -3s                        now │
├────────────────────────────────┤
│ VELOCIDAD m/s       -0.8…1.1   │
│ ┌────────────────────────────┐ │
│ │         ╱‾╲                │ │
│ │────────╱───╲───────────────│ │
│ └────────────────────────────┘ │
│ -3s                        now │
├────────────────────────────────┤
│          [ Disconnect ]        │
└────────────────────────────────┘
```

**Nota sobre el número en vivo** (§2.4): debajo del gráfico de velocidad, en `textSecondary` y letra
chica: `en vivo — aproximado. Los números por rep se calculan al cerrar cada rep.` No es adorno: es
la razón por la que el diseño puede permitirse ser simple, y el usuario tiene que saberlo.

### 4.2 Live — calibrando / grabando

Solo cambia el bloque de acción:

```
│  MANTENÉ QUIETO — 1.4 s        │        │  ● REC  00:08      rep 4      │
│  ▓▓▓▓▓▓▓▓▓░░░░░░░              │        │  [      Terminar serie      ] │
```

**La calibración es automática, no un botón.** El procesador calibra solo desde la primera ventana
quieta que pase las compuertas de §2.2, y re-calibra en idle. La persona ya está parada quieta
armándose. El botón `Iniciar serie` solo consulta `live.calibrated`:

- Si `calibrated` → arranca a grabar directo.
- Si no → muestra `MANTENÉ QUIETO` con la barra de progreso hasta que `calibrated` pase a true,
  y ahí arranca. Si pasan 5 s sin lograrlo, `<Banner tone="warning">Demasiado movimiento — mantené la barra quieta</Banner>`.

Una vez calibrado, aparece un link de texto `Recalibrar` debajo, que llama a `proc.reset()`.

### 4.3 Serie

```
┌────────────────────────────────┐
│ SERIE 3  ·  6 reps  ·  00:21   │
├────────────────────────────────┤
│   0.62        4.8       0.71   │
│ vel media   acc media   mejor  │
│   m/s        m/s²        m/s   │
├────────────────────────────────┤
│ ACELERACIÓN m/s²     -14…19    │
│ ┌────────────────────────────┐ │   3 paths superpuestos: ax/ay/az
│ └────────────────────────────┘ │
│ 0s                       21.0s │
├────────────────────────────────┤
│ VELOCIDAD m/s        -1.2…1.4  │
│ ┌────────────────────────────┐ │
│ └────────────────────────────┘ │
│ 0s                       21.0s │
├────────────────────────────────┤
│ #   ECC max  CON max  CON media│   monospace + tabular-nums
│ 1    -0.91     1.12      0.64  │
│ 2    -0.88     1.09     0.61 ⚠ │   ← ⚠ = rep.lossy
└────────────────────────────────┘
```

Estado vacío: `Todavía no grabaste ninguna serie. Empezá una en el tab Live.`

> `ponytail: muestra solo sets[sets.length-1]; agregar un stepper ◀ ▶ cuando alguien realmente quiera volver a la serie 2.*

#### ⚠ La curva de velocidad del gráfico tiene que ser la corregida, no la viva

Punto de integración fácil de errar. El array `v` que la pasada A fue acumulando durante la serie
arrastra drift y clamps de ZUPT. Si se grafica ese, **el gráfico contradice los números de la tabla**.

Al Terminar serie, reconstruir el array `v` de la serie completa desde las salidas de la pasada B:
para los frames dentro de una rep aceptada, la `v_corr` detrendeada; para los frames entre reps,
cero. Eso hace que el gráfico y las métricas sean la misma medición.

### 4.4 Velas

```
┌────────────────────────────────┐
│ SERIE 3 · 6 reps               │
├────────────────────────────────┤
│ CONCÉNTRICA  m/s    0.0…1.40   │
│  ┌───────────────────────────┐ │
│  │   ▮                       │ │  barra = min..max de velocidad de la fase
│  │ ▮ ▮ ▮ ▮                   │ │  tick  = media de la fase
│  │─▬─▬─▬─▬─▬─▬───────────────│ │
│  │ ▮ ▮ ▮ ▮ ▮ ▮               │ │
│  └───────────────────────────┘ │
│    1 2 3 4 5 6                 │
├────────────────────────────────┤
│ EXCÉNTRICA   m/s   -1.30…0.0   │
│  ┌───────────────────────────┐ │
│  │ ▮ ▮ ▮ ▮ ▮ ▮               │ │
│  │─▬─▬─▬─▬─▬─▬───────────────│ │
│  └───────────────────────────┘ │
│    1 2 3 4 5 6                 │
└────────────────────────────────┘
```

Colores: concéntrica `colors.connected` (arriba = verde), excéntrica `colors.disconnected`
(abajo = rojo). Lee bien para levantamiento y no agrega nada a la paleta.

**Una línea extra que vale la pena:** una rep concéntrica cuya media esté >20% por debajo de la
mejor de la serie va en `colors.warning`. Eso es literalmente el punto de VBT (pérdida de velocidad
como señal de fatiga para cortar la serie) y cuesta un ternario.

---

## 5. Primitivas de gráficos — `src/charts.tsx`

**Un archivo, dos componentes y dos helpers puros.** Todo lo demás es `<Text>` de RN.

```tsx
export type Series = { values: number[]; color: string };
export type Candle = { lo: number; hi: number; mid: number; color: string };

<LineChart series={Series[]} height={120} zeroLine? unit? domain?={[lo,hi]} />
<CandleChart candles={Candle[]} height={140} labels={string[]} />
```

**El ancho sale de `onLayout`, no de un `viewBox` fijo con `preserveAspectRatio="none"`.** El enfoque
de escala no-uniforme distorsiona el ancho de trazo y obliga a `vectorEffect="non-scaling-stroke"`,
que históricamente no es confiable en Android en react-native-svg. Más importante: **la decimación
necesita el ancho real en píxeles** para elegir la cantidad de buckets, así que medir no es overhead,
es requisito. Ambos componentes renderizan `null` hasta que `w > 0` (un frame extra, invisible).

### 5.1 Decimación: bucketing min/max, un bucket por columna de píxel

El muestreo por stride esconde el pico de velocidad concéntrica, que es *el* número por el que
existe toda la app. El bucketing min/max no puede. Lo no-obvio es que **un solo loop maneja
cualquier densidad** — 3000 puntos sobre 340 px y 50 puntos sobre 340 px — porque itera sobre puntos
y descarga al cambiar de columna, en vez de iterar columnas:

```ts
/** Path SVG que preserva picos a cualquier densidad: los puntos se agrupan en
 *  una columna por píxel y cada columna emite su max y después su min. Con <= 1
 *  punto por columna degenera en una polilínea común, así que el gráfico vivo
 *  (300 pt) y el de serie completa (3000+ pt) comparten un solo camino de código. */
export function envelopePath(v: number[], w: number, h: number, lo: number, hi: number): string {
  const n = v.length;
  if (n === 0 || w <= 0) return '';
  const span = hi - lo || 1;
  const y = (val: number) => h - ((val - lo) / span) * h;
  if (n === 1) return `M0 ${y(v[0]).toFixed(1)}H${w.toFixed(1)}`;   // línea plana

  const pts: string[] = [];
  let col = -1, cx = 0, mn = 0, mx = 0;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const c = x | 0;
    if (c !== col) {
      if (col >= 0) pts.push(`${cx.toFixed(1)} ${y(mx).toFixed(1)}`,
                             `${cx.toFixed(1)} ${y(mn).toFixed(1)}`);
      col = c; cx = x; mn = mx = v[i];
    } else {
      if (v[i] < mn) mn = v[i];
      if (v[i] > mx) mx = v[i];
    }
  }
  pts.push(`${cx.toFixed(1)} ${y(mx).toFixed(1)}`, `${cx.toFixed(1)} ${y(mn).toFixed(1)}`);
  return 'M' + pts.join('L');
}
```

La salida está acotada a `2 × w` puntos (~700) **sin importar el tamaño de entrada** — una serie de
10.000 muestras produce el mismo string de ~8 KB que una de 700. `toFixed(1)` porque 0,1 px está más
allá de lo que un teléfono puede mostrar y eso corta el string a la mitad.

```ts
/** Dominio compartido entre todas las series, con 5% de padding; datos planos ±1. */
export function extent(series: number[][]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const v of s) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!isFinite(lo)) return [0, 1];
  if (lo === hi) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.05;
  return [lo - pad, hi + pad];
}
```

### 5.2 Ejes y etiquetas: nada de texto SVG

Los únicos elementos SVG en toda la app son `Svg`, `Path`, `Rect`, `Line`. Las etiquetas son `<Text>`
de RN dispuestos alrededor del SVG: una fila de encabezado (`ACELERACIÓN m/s²` a la izquierda,
`-2.1…2.4` a la derecha) y una de pie (`-3s` izquierda, `now` derecha). Esto elimina todo problema
de métricas de fuente, baseline y escalado de texto, y los números heredan gratis
`fontVariant: ['tabular-nums']` de las convenciones existentes. La única decoración dentro del SVG es
una `<Line>` de cero en `y(0)` con `colors.surface`, dibujada cuando `lo < 0 < hi`.

### 5.3 CandleChart

Sin construcción de paths. Por vela `i` con `step = w / n`:

```tsx
<Rect x={i*step + gap/2} width={step - gap}
      y={yy(c.hi)} height={Math.max(2, yy(c.lo) - yy(c.hi))}
      fill={c.color} rx={2} />
<Line x1={i*step + gap/2} x2={i*step + step - gap/2}
      y1={yy(c.mid)} y2={yy(c.mid)}
      stroke={colors.background} strokeWidth={2} />
```

`Math.max(2, …)` para que una rep con rango de fase casi nulo renderice una marca visible en vez de
desaparecer. Los números de rep son una fila de `<Text>` abajo, `flex: 1` por columna.

### 5.4 Estados

- **Vacío** (`values.length === 0` / `candles.length === 0`): renderizar el marco con un `<Text>`
  centrado `Sin datos`. Un branch, los dos componentes.
- **Un solo punto:** `M0 yH{w}` — línea plana en ese valor. Ya cubierto arriba; sin eso, `n-1 === 0`
  divide por cero.
- Sin animación, sin gestos, sin tooltips.

---

## 6. Performance y modelo de datos

**Los re-renders del tab Live se quedan en 10 Hz — el ticker de 100 ms no cambia.** 100 Hz solo
significa que ahora el ticker drena ~10 muestras por tick en vez de ~0,1. El callback de BLE sigue
siendo una mutación pura de ref.

Lo nuevo a 10 Hz en el tab Live son dos SVGs. El costo está acotado por diseño:

- Cada serie es **un `<Path>` con una prop `d`** — nunca un elemento por punto.
- La ventana viva son las últimas 300 muestras (3 s). A ~340 px de ancho eso es ≤1 punto por columna,
  así que `envelopePath` emite ~600 pares; construir el string está muy por debajo del milisegundo.
- `envelopePath` va envuelto en `useMemo(…, [values, w, lo, hi])` dentro del chart, y ambos
  componentes son `React.memo`. En Live el array cambia de referencia cada tick y el memo no saltea
  — correcto, genuinamente cambió. En Serie/Velas los arrays son snapshots congelados, así que el
  memo saltea todo render después del primero.

**Los gráficos de Serie y Velas renderizan solo desde el snapshot de serie completada.** Consumen
únicamente `ConnCtx`. `sets[]` gana un elemento una vez, al Terminar serie.

**La detección de reps corre dentro del callback de BLE** (`proc.push(sample)`), un paso O(1) de
máquina de estados por muestra — no en el ticker, no en React. Detectar una rep solo incrementa un
contador en `buf.current`; el ticker lo publica.

**Dónde vive el array de la serie:** en `buf.current.rec`, el único objeto mutable de ref — nunca en
estado, nunca en contexto, hasta que la serie termina. Se guarda como **`number[]` paralelos, no
`VbtSample[]`**:

```ts
type Recording = {
  id: number; startedAt: number;
  t: number[]; ax: number[]; ay: number[]; az: number[]; a: number[]; v: number[];
};

export type SetData = Recording & {
  durationMs: number;
  reps: Rep[];               // de vbt.ts, §2.6
  rejected: RejectedRep[];
  meanVelocity: number;      // media de las medias concéntricas
  meanAccel: number;         // media de |a_vert| durante fases concéntricas
};
```

Dos razones, ambas de peso. `VbtSample` carga `raw: Uint8Array` ([protocol.ts:27](src/protocol.ts#L27))
— retener 10.000 de esos ancla 10.000 typed arrays más headers de objeto para datos que solo lee el
toggle de hex. Y `number[]` es *exactamente* lo que consume `envelopePath`, así que Terminar serie no
transforma nada: los arrays se pasan al gráfico por referencia.

> `ponytail: number[] paralelos con append, no ring buffer ni Float32Array. Techo: ~10k muestras (100 s) por serie antes de que valga medir el costo de append. Upgrade: Float32Array en chunks, o cap de largo de serie con aviso.*

**`Session` se omite.** Los `sets: SetData[]` del provider más el tiempo de vida de la app *son* la
sesión; agregar un wrapper ahora sería un struct de un campo sin lector. Se agrega cuando llegue la
persistencia y una sesión necesite id y fecha en disco.

---

## 7. Verificación sin hardware

Comandos sin cambios. `npm test` ya está globbeado como `node --test src/*.test.ts`, así que
`vbt.test.ts` se levanta con cero cambios de script, y `tsconfig.json` ya excluye `**/*.test.ts`.

```bash
npx tsc --noEmit && npm test && npx expo lint
```

`vbt.test.ts` tiene que importar `'./vbt.ts'` **con la extensión**, igual que
[protocol.test.ts:5](src/protocol.test.ts#L5).

### 7.1 El generador de sentadilla sintética

Vive dentro de `vbt.test.ts` (tiene exactamente un consumidor; un archivo aparte sería scaffolding).

**Perfil de velocidad `sin²`**, elegido por tener ground truth de forma cerrada y continuidad C¹:

```
v(t) = V·sin²(πt/T) = (V/2)(1 − cos(2πt/T))
a(t) = dv/dt = (Vπ/T)·sin(2πt/T)
∫₀ᵀ v dt = V·T/2
```

Ground truth, todo exacto: pico de velocidad = `V` (en `t = T/2`); **media = `V/2`** (la aserción más
limpia posible); ROM = `V·T/2`; pico de aceleración = `Vπ/T`; y **`a(0) = a(T) = 0`**, así que no hay
escalón de aceleración en los límites de fase que confunda al filtro. *(Un perfil `sin` simple
arrancaría con aceleración pico — un impulso de jerk no físico. Usar `sin²`.)*

| | valor |
|---|---|
| Concéntrica `Vcon` / `Tc` | 0.90 m/s / 0.80 s → ROM 0.360 m, pico accel 3.53 m/s² |
| Excéntrica `Vecc` / `Te` | 0.60 m/s / 1.20 s → ROM 0.360 m, pico accel 1.57 m/s² |
| Pausa abajo | 0.30 s |

La profundidad coincide subiendo y bajando (`Vecc·Te = Vcon·Tc`), ROM 0.36 m cae dentro de
`[0.20, 1.00]`, y la media concéntrica es exactamente 0.450 m/s.

**Sesión:** 2,0 s quieto (cubre el 1 s de calibración con margen) → N reps separadas por 1,5 s
quieto → 1,5 s quieto.

**Síntesis en marco de sensor.** El sensor está pegado en un ángulo arbitrario, así que se elige un
vector unitario arbitrario `u` (por ejemplo `normalize(0.31, −0.47, 0.83)`) como la representación en
marco de sensor del "arriba" del mundo, y se arman los otros dos ejes con un paso de Gram-Schmidt:

```ts
function worldBasis(u: Vec3): { e1: Vec3; e2: Vec3 } {
  const seed = Math.abs(u.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const e1 = normalize(cross(u, seed));
  const e2 = cross(u, e1);                    // ya unitario: u ⟂ e1, ambos unitarios
  return { e1, e2 };                          // {e1, e2, u} es un marco ortonormal
}
```

Cinco líneas, y *son* las filas de la matriz de rotación. Sin ángulos de Euler, sin librería.

```
a_meas(t) = S·[ û·(G + a_vert(t)) + ê₁·sway_x(t) + ê₂·sway_y(t) ] + b + η(t)
```

- `G = 9.81`, `S = SCALE` (el error de escala modelado), `b = (0.05, −0.08, 0.12)` m/s² (offset de
  cero-g modelado)
- `sway_x(t) = 0.30·sin(2π·1.1·t)`, `sway_y = 0` — **balanceo horizontal de la barra, presente
  específicamente para probar que la proyección lo rechaza.** Sin componente horizontal la base
  completa sería inútil y alcanzaría una construcción escalar solo sobre `u`; con ella, el test
  ejercita de verdad el rechazo entre ejes.
- `η` = gaussiano, σ = 0.02 m/s² por eje (coincide con el MPU6050 a 21 Hz de ancho de banda)

**El determinismo no es negociable.** `Math.random()` dentro de un test con tolerancias numéricas es
un test flaky que va a fallar a las 3 de la mañana sin motivo. Usar mulberry32 con semilla más
Box-Muller, ~6 líneas:

```ts
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) =>
  Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
```

**Timestamps — forzar que el wraparound sea un camino testeado, no uno esperado:**

```ts
const START_US = 2 ** 32 - 3_000_000;   // da la vuelta a los 3 s de sesión, entre calibración y primera rep
const timestamp = (START_US + i * 10_000) % 2 ** 32;
const sequence = i;
```

Una línea, y ahora **todos** los casos de test atraviesan la rama de wraparound. Es la línea de mayor
valor del archivo de test.

**Paquetes perdidos:** una variante que borra 3 muestras consecutivas del medio de una fase
concéntrica. Los `sequence` quedan con un hueco real, igual que en el cable.

### 7.2 Aserciones

Análisis de la recuperación esperada, para que las tolerancias estén razonadas y no ajustadas hasta
que pasen. Proyectando el vector medido sobre el `û` *estimado*:

- El `û` estimado es `normalize(S·G·u + b)`, inclinado respecto del `u` verdadero en
  ≈ `|b_⊥|/(S·G)` ≈ 0.15/10.1 ≈ 0.0149 rad ≈ 0.85°. Eso cuesta `1 − cos(0.85°) ≈ 1.1e-4` sobre la
  proyección — nada — y filtra ~1,5% del sway a `a_vert` (0.0045 m/s², oscilando a 1,1 Hz, de media
  cero, y después eliminado por el detrend).
- `dot(b, û)` queda absorbido exactamente en `gMag`, dejando solo un término de segundo orden
  ≈ `|b_⊥|²/(2SG)` ≈ 0.0011 m/s².
- **El error que sobrevive es el factor de escala: las velocidades recuperadas salen `S ×` la
  verdad.** El algoritmo no puede sacarlo y no debería fingir que sí.

Por eso las aserciones van contra `V·S`, lo que **separa el error del algoritmo del error de hardware
modelado**:

| Caso | Aserción |
|---|---|
| Calibración | `calibration !== null`; `gMag ∈ [9.5, 10.5]`; `hypot(ux,uy,uz) ≈ 1` dentro de 1e-9 |
| `S = 1.00`, bias + sway + ruido, 3 reps | `reps.length === 3`; por rep `peakConcentricVelocity` dentro del **2%** de 0.90; `meanConcentricVelocity` dentro del 2% de 0.450; `concentric.rangeOfMotion` dentro del 3% de 0.360; `eccentric.durationMs` dentro de 60 ms de 1200; `concentric.durationMs` dentro de 60 ms de 800 |
| `S = 1.03` | lo mismo, contra `V·1.03`, al **3%** |
| Solo quieto + ruido, 20 s | `reps.length === 0` |
| Walkout: bamboleo vertical de 0.05 m a 2 Hz por 3 s | `reps.length === 0`, y `rejected` vacío o `reason === 'rom'` (prueba que la compuerta de ROM fue la que atrapó) |
| Dropout de 3 muestras en mitad de concéntrica | mismas aserciones al 5%; `rep.lossy === true` |
| Convención de signo | sensor plano (`u = (0,0,1)`), `+1.0 m/s²` constante hacia arriba → `live.aVert ≈ +1.0` |

Todo con `node:assert/strict`, en el mismo estilo que `protocol.test.ts`. Sin framework, sin
fixtures, sin mocks, sin dependencias nuevas.

---

## 8. Árbol de archivos

```
clients/mobile/
├── app.json              M   + scheme, + plugin expo-router
├── package.json          M   main: expo-router/entry
├── PLAN-V2.md            +   este documento
├── index.ts              D   reemplazado por expo-router/entry
├── App.tsx               D   partido en src/app/index.tsx + raw.tsx + ui.tsx
└── src/
    ├── app/
    │   ├── _layout.tsx   +   SafeAreaProvider + <VbtProvider> + <Tabs>, 4 glifos SVG
    │   ├── index.tsx     +   Live
    │   ├── set.tsx       +   Serie
    │   ├── candles.tsx   +   Velas
    │   └── raw.tsx       +   el StreamPanel de hoy, movido
    ├── ble.ts                sin cambios
    ├── protocol.ts           sin cambios
    ├── protocol.test.ts      sin cambios
    ├── vbt.ts            +   TODO el núcleo de §2. Puro, cero imports.
    ├── vbt.test.ts       +   generador sintético + aserciones (§7)
    ├── charts.tsx        +   LineChart, CandleChart, envelopePath, extent
    ├── ui.tsx            +   colors, Banner, StatTile, StyleSheet compartido (absorbe theme.ts)
    ├── stream.tsx        R   useVbtStream.ts renombrado: contextos + provider + todo el estado
    └── theme.ts          D   fundido en ui.tsx
```

Neto **+5 archivos**, cuatro forzados por la regla archivo-es-ruta de expo-router. Justificación por
archivo (la regla de `PLAN.md` §7 es: plano, pocos archivos, fusionar lo que quede bajo ~20 líneas):

- `src/app/*` — una ruta *es* un archivo bajo expo-router. Imposible de fusionar por definición.
- `charts.tsx` — tres pantallas lo importan. Fundirlo en una hace que las otras dos importen una pantalla.
- `vbt.ts` — **tiene que** estar separado de `stream.tsx` para ser testeable. `node --test` no puede
  cargar `stream.tsx` (React, ble-plx). Mantener la matemática en un archivo con cero imports es lo
  que hace que funcione la verificación sin hardware. **Es la justificación más fuerte de la lista.**
- `ui.tsx` — `Banner`, `StatTile` y el StyleSheet compartido los usan las cuatro pantallas.
  **Absorbe `theme.ts`** (11 líneas, bajo la regla de fusión) y exporta `colors` él mismo, así que el
  conteo de archivos no cambia y cada pantalla tiene un import en vez de dos.
- `stream.tsx` — la máquina de estados de conexión que hoy está en `App.tsx` y el buffer que está en
  `useVbtStream.ts` se vuelven una sola cosa en cuanto el provider es dueño de ambos. Separarlos
  significaría un contexto importando un hook importando un contexto. ~220 líneas, una preocupación:
  todo el estado de la app.

No crear `components/`, `hooks/`, `utils/`, `types/`, `constants/`.

**Bonus gratis:** `App.tsx:7` importa el `SafeAreaView` de RN, que en este mismo `node_modules` está
marcado `@deprecated ... will be removed in a future release`. Expo Router obliga a
`react-native-safe-area-context` igual, así que esto se arregla solo.

---

## 9. Orden de implementación

Cada paso termina en verde con `npx tsc --noEmit && npm test && npx expo lint`.

| # | Paso | Por qué en este orden |
|---|---|---|
| 1 | **Firmware (§1)** y validar en el monitor serie | Sin 100 Hz no hay nada que testear en hardware después. Es el único paso que no depende de nada. |
| 2 | **`vbt.ts` + `vbt.test.ts` (§2, §7)** | Puro, sin Expo, sin router. **Aterrizar la matemática primero: es la única parte que puede estar mal de una forma que los tests atrapen.** |
| 3 | **`charts.tsx` (§5)** | Renderizado puro, solo depende de `react-native-svg`. Se puede probar contra los datos sintéticos de `vbt.test.ts`. |
| 4 | **Migración del router (§3), pantallas vacías** | Instalar, cambiar `main`, agregar `scheme`, crear las 4 rutas como stubs; `App.tsx` intacto y sin referencias. **Reconstruir el dev client acá.** Es donde va a pegar el drift de documentación: aislarlo. |
| 5 | **`stream.tsx` (§3.3, §3.4)** | Colapsar los 7 refs en un objeto, subir la máquina de estados de `App.tsx`, agregar los dos contextos, `reset()`, grabación de serie y calibración. |
| 6 | **Llenar las pantallas (§4)** | `raw.tsx` primero: es un movimiento casi textual de `StreamPanel` y prueba que el provider anda antes de escribir UI nueva. Después `index.tsx`, `set.tsx`, `candles.tsx`. |
| 7 | **Borrar `App.tsx`, `index.ts`, `theme.ts`.** Actualizar README | El README necesita el requisito de reconstruir el dev client y los pasos nuevos del checklist de hardware. |

---

## 10. Verificar contra los docs de SDK 57 — no confiar en lo de arriba

`AGENTS.md` es explícito: no confiar en datos de entrenamiento sobre Expo. La configuración de
expo-router es el área que más cambia entre SDKs. Cada ítem está marcado como confirmado durante el
diseño o explícitamente sin confirmar.

| # | Ítem | Estado |
|---|---|---|
| 1 | `"expo-router"` en los plugins de `app.json` | **SIN CONFIRMAR.** La página de instalación solo documenta `scheme` y `experiments.typedRoutes`; la de SDK 57 dice que el plugin "ya está configurado" en el template por defecto sin aclarar si hace falta en una instalación manual. Chequear `https://docs.expo.dev/versions/v57.0.0/sdk/router/`. |
| 2 | Babel | **SIN CONFIRMAR** que expo-router no necesite nada. No existe `babel.config.js` en el proyecto; los docs dicen *asegurar* `presets: ['babel-preset-expo']`, que es lo que `@expo/metro-config` aplica por defecto sin archivo de config. Si las rutas dan 404: `npx expo customize babel.config.js`. |
| 3 | SDK 56+ **prohíbe** importar de `@react-navigation/*` en código de app | **CONFIRMADO** en la página de router de SDK 57. Todo hook y tipo de navegación sale de `expo-router`. Esto pega en `freezeOnBlur`, `useIsFocused`, y cualquier import de tipo `BottomTabNavigationOptions`. |
| 4 | `freezeOnBlur` en el `Tabs` de expo-router | **SIN CONFIRMAR** para SDK 57, incluido si hay que llamar `enableFreeze()` de react-native-screens a nivel módulo. La arquitectura funciona sin esto. |
| 5 | Versión de `react-native-svg` | La página de SDK 57 no da pin. Usar `npx expo install react-native-svg` y tomar lo que resuelva. **Nunca una versión de memoria.** |
| 6 | Reconstrucción del dev client | Los cuatro paquetes nuevos son nativos. `npx expo run:android` es obligatorio; `npx expo start` contra el client viejo tira error. |
| 7 | Auto-detección de `src/app` | **CONFIRMADO:** tiene precedencia sobre `app/` en la raíz, no necesita config `root`, y `app/` en la raíz no debe existir también. |
| 8 | `SafeAreaView` de RN | **CONFIRMADO** deprecado en este mismo `node_modules`. Usar `react-native-safe-area-context` en `_layout.tsx`. |

---

## 11. Checklist de validación en hardware real

El agente no puede correr esto. Va al README para el usuario. Extiende el checklist de `PLAN.md` §8.1.

1. Monitor serie: los `SEQ` avanzan de a `SERIAL_DEBUG_EVERY`, y el delta de `TIME` entre líneas
   consecutivas es `SERIAL_DEBUG_EVERY × 10000 µs ± 5%`. **Si el delta es mayor, el loop no llega.**
2. App → Scan → conectar. Tab **Raw**: `rate` marca **~100 Hz** (era ~1 Hz), `lost` ≈ 0, `malformed` = 0.
3. Con el sensor quieto sobre la mesa, tab **Live**: `Sin calibrar` desaparece solo en ~1 s. La
   velocidad viva se queda en 0.00 y **no deriva** mirándola 30 s. Si deriva, subir `STILL_ACC_RMS`
   o revisar §2.2.
4. Levantar el sensor 30 cm a mano y bajarlo: el gráfico de aceleración se mueve, el de velocidad
   hace un pulso y vuelve a cero. **Si no vuelve a cero, el ZUPT no está disparando.**
5. Pegar el sensor a la barra **en un ángulo claramente torcido** (es el caso de diseño). Repetir
   el paso 3: la calibración tiene que funcionar igual.
6. Iniciar serie → 5 sentadillas → Terminar serie. Tab **Serie**: 5 reps en la tabla. El ROM
   concéntrico tiene que parecerse a la profundidad real (~0.4–0.6 m para una sentadilla completa).
   **Si el ROM está sistemáticamente alto o bajo por un factor constante, es el error de escala del
   MPU6050 de §2.2** — ese es el dato que justifica la calibración de seis posiciones.
7. Velocidades concéntricas plausibles: 0.5–1.0 m/s con carga moderada. Las excéntricas negativas.
8. Tab **Velas**: 5 velas por gráfico, las concéntricas verdes arriba de cero, las excéntricas rojas
   abajo. Con fatiga, las últimas velas concéntricas tienen que bajar respecto de las primeras.
9. Hacer un walkout y re-rackear **sin** hacer reps → **0 reps detectadas**. Si aparecen reps
   fantasma, revisar `ROM_MIN_M` y `V_START` (§2.5).
10. Alejar el dispositivo hasta que se corte → `Device disconnected`, vuelta al scan sin crashear.
    Reconectar → `reset()` limpia todo (§3.4).

**Anotar los valores observados al ajustar cualquier perilla de `VBT_TUNING`.** El comentario de la
tabla dice que son conjeturas; convertirlas en mediciones es el trabajo de la primera sesión real.

---

## 12. Ledger de atajos deliberados

Todos marcados con comentarios `ponytail:` en el código, siguiendo la convención de
[useVbtStream.ts:39](src/useVbtStream.ts#L39).

| Atajo | Techo | Camino de upgrade |
|---|---|---|
| Calibración de gravedad de una sola pose | ~3% de error absoluto de velocidad por el factor de escala del MPU6050; los ratios no se ven afectados | Calibración estática de seis posiciones, guardada por dispositivo |
| Vector de gravedad fijo, re-estimado solo en idle | Se rompe para levantamientos donde la barra rota (arranque, envión, press en arco) | Giróscopo en el paquete v2 + filtro complementario |
| Detrend lineal (bias constante) por rep | Un bias que rampa dentro de una rep deja residuo cuadrático | Ajuste cuadrático por mínimos cuadrados, ~6 líneas, solo si los datos lo piden |
| Solo MV, sin MPV | Diverge de MV para press de banca y cargas balísticas livianas | 3 líneas; `a_vert` ya está bufferado |
| Escaneo O(ventana) para el detector de reposo | ~30 iteraciones/muestra a 100 Hz | Suma corrida de cuadrados con índices head/tail |
| `number[]` paralelos con append para la serie | ~10k muestras (100 s) por serie | `Float32Array` en chunks, o cap con aviso |
| Solo `sets[sets.length-1]` en la pantalla Serie | No se puede volver a una serie anterior | Stepper ◀ ▶ sobre `sets[]` |
| Sin `typedRoutes` | Sin type-safety en rutas | Prenderlo cuando una pantalla tome params |
| Arreglo de boot del firmware sin guarda de stall | Un stall de varios segundos a mitad de sesión reproduce la ráfaga | Guarda de catch-up en el `loop()`; el cliente ya se defiende con `DT_MIN_S` |
