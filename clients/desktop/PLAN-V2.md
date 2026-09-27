# PLAN V2 — Algoritmos del cliente desktop con giróscopo y temperatura

> Documento de implementación. Mismo rol que `clients/desktop/PLAN.md`: las decisiones ya están
> argumentadas acá, el código las implementa sin re-discutirlas.
> Es la continuación directa de `PLAN.md §10` ("el paquete v1 no lleva giróscopo, y eso pone un
> techo a lo que cualquier filtro puede lograr") y presupone implementado `firmware/PLAN.md`
> (paquete v2). Las referencias a `vbt.ts` apuntan a `clients/mobile/src/`.

---

## 0. Contexto

El firmware ahora emite paquetes **VBT v2 de 42 bytes** (`<BBBBIIh7f`): magic, version `0x02`,
`flags`, `txDropped`, `timestamp` (µs, **hora agendada**, no la de lectura), `sequence`,
`jitterUs` (int16), `ax/ay/az` (m/s²), **`gx/gy/gz` (rad/s)** y **`tempC` (°C, temperatura del die
del MPU6050)**. El cliente desktop ya los parsea, los graba al CSV y los grafica
(`protocol.py`, `dsp.Grid`, pestañas Accel/Stats/Filters). **Pero ningún algoritmo los usa
todavía**: `project_vertical()` (`dsp.py:393`) sigue proyectando sobre un vector de gravedad
fijo tomado en reposo, `apply_zupt()` (`dsp.py:439`) sigue detectando reposo solo con el
acelerómetro, y la temperatura es un número en la barra de estado.

**El problema que esto destraba.** `PLAN.md §5.2` rechazó Kalman / Madgwick / complementario
con una sola razón: "necesitan giróscopo, y el paquete v1 no lo lleva". Esa razón ya no existe.
Y `PLAN.md §8.5` dejó planteada la hipótesis de que el error dominante en la doble integración
no es ruido sino **fuga de gravedad por inclinación**, sin forma de medirla. Ahora se puede
medir, y se puede corregir.

**El objetivo de esta iteración:** sumar al banco de algoritmos del cliente todo lo que el giro,
la temperatura y los flags habilitan, **al lado** de lo que ya existe — no en reemplazo — para
poder comparar con la misma captura qué gana cada algoritmo nuevo sobre el viejo.

**El entregable final sigue siendo una decisión de firmware.** Las decisiones nuevas que esta
herramienta tiene que poder producir, con datos:

1. ¿Hace falta fusión de orientación en el micro, o alcanza con el snapshot fijo? Si hace falta,
   ¿cuál (complementario / Mahony / Madgwick) y con qué ganancias?
2. ¿Qué detector de reposo usa el ZUPT (solo acelerómetro, solo giro, o ambos)?
3. ¿Hace falta un modelo térmico de bias en el micro, o alcanza con re-estimar bias en cada reposo?
4. ¿Qué pasa-bajos va sobre la aceleración vertical ya rotada al mundo?

Cada una termina en un snippet de C exportable, igual que el banco de filtros de `PLAN.md §5.6`.

**Fuera de alcance (decidido):** detección de reps (sigue en `vbt.ts`), cliente móvil
(`protocol.ts` sigue rechazando v2; es otro PR), magnetómetro (el MPU6050 no tiene), y posición /
trayectoria 3D de la barra.

---

## 1. Decisiones tomadas

| Decisión | Elegido |
|---|---|
| Dónde vive el código nuevo | **`imu.py`** nuevo (orientación, reposo, térmica, Allan, brazo de palanca). `dsp.py` queda para señales 1-D |
| Fusión por defecto | **Mahony con rechazo de aceleración**, inicializado desde "Capturar reposo" |
| Referencias contra las que se mide | Madgwick (validado contra `ahrs`) y la **integración entre anclas de reposo** (no causal) |
| Convención de orientación | Cuaternión Hamilton `[w, x, y, z]`, **cuerpo → mundo**, Z del mundo hacia arriba (en reposo el acelerómetro lee `+g` en Z mundo) |
| Guiñada (yaw) | Se integra pero se muestra como **no observable**. Ningún número VBT depende de ella |
| Dónde va el banco de filtros | **Sobre `a_vert` ya rotada al mundo**, no sobre los 6 ejes crudos antes de fusionar |
| Detector de reposo | Selector `{RMS |a| (vbt.ts), ARE (giro), SHOE (ambos)}`. Default sigue siendo RMS |a| hasta que los datos digan otra cosa |
| Temperatura | Monitor + guardas (calentamiento, calibración vieja) + ajuste lineal de bias vs T offline. Corrección opcional |
| Procesamiento en vivo | **Incremental con estado**, indexado por `seq`. Es el primer algoritmo que rompe la regla de re-filtrado stateless de `PLAN.md §6` (medido, ver §6) |
| Dependencias nuevas | `ahrs` **solo para tests** (skip si falta). Allan escrito a mano (~15 líneas). **Sin `imufusion`** |
| Compatibilidad v1 | Todo lo nuevo se apaga solo cuando `gyro_available()` es `False` (`dsp.py:530`) |

Por qué no `imufusion` como dependencia: es una extensión en C y el venv corre **Python 3.14.7**;
no hay garantía de wheel, y este repo ya pagó caro los problemas de `pip` (SSL, PySide6 completo).
`ahrs` es numpy puro. `imufusion` queda citado como la referencia de diseño del rechazo de
aceleración (§5.3), no como código.

---

## 2. Estructura de archivos

```
clients/desktop/
  requirements.txt        # + ahrs (solo lo usa test_imu.py)
  protocol.py             # sin cambios
  ble.py                  # sin cambios
  dsp.py                  # + to_grid trata IMU_READ_FAILED como hueco; Calibration con giro y T;
                          #   detrend por segmentos; exportador con plantillas nuevas
  imu.py                  # NUEVO ~350 líneas — cuaterniones, fusión, a_vert mundo, reposo,
                          #   bias online, térmica, Allan, brazo de palanca
  app.py                  # + pestañas Orientation y Sensor; selectores nuevos en Velocity
  test_dsp.py             # + tests de flags / Calibration extendida
  test_imu.py             # NUEVO — mismo estilo: asserts planos, `python test_imu.py`
```

---

## 3. Catálogo completo de algoritmos

Esta es la lista **única** de todo lo que el cliente sabe hacer después de este plan. Lo que ya
existe se lista igual, para que se vea dónde se enchufa cada cosa nueva.
Columna **Datos**: `a` acelerómetro, `ω` giro, `T` temperatura, `F` flags, `J` jitter.

### 3.1 Preprocesado de muestras

| # | Algoritmo | Estado | Datos | ¿Causal? | Dónde |
|---|---|---|---|---|---|
| P1 | Grilla uniforme por `sequence` + interpolación de huecos | existente | seq | — | `dsp.to_grid` |
| P2 | Corte de segmento ante salto > 250 ms / `SCHED_RESYNC` | existente | seq, F | — | `dsp.to_grid` |
| P3 | Estadística de jitter (p95, spread, tardías) | existente | J, F | — | `dsp.timing_stats` |
| P4 | **Muestras `IMU_READ_FAILED` tratadas como hueco** (interpoladas + `filled`) | **nuevo** | F | — | `dsp.to_grid` |
| P5 | **Marcado de clipping** (accel / giro) y propagación a "rep no confiable" | **nuevo** | F | sí | `imu.py` + UI |

### 3.2 Calibración

| # | Algoritmo | Estado | Datos | Dónde |
|---|---|---|---|---|
| C1 | "Capturar reposo": vector de gravedad + guardas `8.5 ≤ |g| ≤ 11`, RMS ≤ 0.12 | existente | a | `dsp.calibrate` |
| C2 | **Bias del giro en reposo** (media de 1 s, los 3 ejes) | **nuevo** | ω | `dsp.calibrate` |
| C3 | **Orientación inicial desde el vector de reposo** (tilt, yaw = 0) | **nuevo** | a | `imu.tilt_quat` |
| C4 | **Re-estimación de bias del giro en cada reposo detectado** | **nuevo** | ω + detector | `imu.OnlineBias` |
| C5 | **Guarda de calentamiento** (`|dT/dt|` alto) y **calibración vieja** (`|T − T_cal|` alto) | **nuevo** | T | `imu.py` + UI |
| C6 | **Modelo térmico de bias** `b(T) = b₀ + k·(T − T_ref)` por eje | **nuevo** | a, ω, T | `imu.thermal_fit` |

### 3.3 Banco de filtros 1-D (sin cambios de algoritmo)

Los 10 filtros de `PLAN.md §5.2` quedan exactamente como están. Lo único que cambia es **sobre
qué señal se aplican**: ahora el combo de Filters también ofrece `gx/gy/gz` (ya implementado) y
**`a_vert (mundo)`** (nuevo, §5.4).

| # | Filtro | ¿Causal? | Costo en MCU |
|---|---|---|---|
| 0 | Passthrough | — | — |
| 1 | Un polo / EMA | sí | 3 flops, 1 float |
| 2 | Butterworth LP 2º | sí | 1 biquad |
| 3 | Butterworth LP 4º | sí | 2 biquads |
| 4 | Butterworth LP fase cero | **no** | N/A (referencia) |
| 5 | Savitzky–Golay | no | FIR W |
| 6 | Media móvil | sí | 2 flops + ring |
| 7 | Mediana 3–5 | sí | sort de 3–5 |
| 8 | Butterworth HP | sí | 1 biquad |
| 9 | Notch | sí | 1 biquad |

### 3.4 Orientación — el banco nuevo

Es el análogo del banco de filtros, con la misma lógica: una línea base, candidatos causales
exportables, y una referencia no causal contra la cual medir cuánto cuesta la causalidad.

| # | Estimador | ¿Causal? | Costo en MCU (por muestra) | Por qué está en la lista |
|---|---|---|---|---|
| O0 | **Snapshot fijo** (lo de hoy: `ĝ₀` de C1) | sí | 0 | La línea base. Es lo que hacen `vbt.ts` y `project_vertical` |
| O1 | **Solo giro** (integración pura del cuaternión) | sí | ~30 flops + 1 sqrt | Muestra la deriva del giro sin corrección. Cota de lo que aporta el acelerómetro |
| O2 | **Solo acelerómetro** (tilt por muestra) | sí | ~10 flops + 1 sqrt | La cota opuesta: correcto quieto, basura en movimiento |
| O3 | **Complementario** (= Mahony con `Ki = 0`) | sí | ~50 flops + 2 sqrt, 4 floats | El más barato que corrige ambas derivas. 1 parámetro: `τ = 1/Kp` |
| O4 | **Mahony** (PI: `Kp`, `Ki`) | sí | ~55 flops + 2 sqrt, 7 floats | Estima el bias del giro online con el término integral. **Candidato por default** |
| O5 | **Madgwick IMU** (`β`) | sí | ~100 flops + 2 sqrt, 4 floats | El de la literatura VBT (PMC9784026, deadlift). Sin estado de bias en la versión IMU |
| O6 | **Integración entre anclas de reposo** | **no** | N/A | La *referencia*: qué orientación hubo "de verdad" durante la rep |

O3–O5 aceptan todos el mismo modificador: **rechazo de aceleración** (§5.3). No es un estimador
aparte, es un checkbox con dos umbrales.

### 3.5 Gravedad y aceleración vertical

| # | Algoritmo | Estado | Datos | Dónde |
|---|---|---|---|---|
| G1 | `a_vert = a·ĝ₀ − |g|` (proyección fija) | existente | a | `dsp.project_vertical` |
| G2 | **`a_vert = a·ĝ(t) − |g|` con `ĝ(t)` del estimador O1–O6** | **nuevo** | a, ω | `imu.vertical_world` |
| G3 | **Fuga de gravedad** = G1 − G2, y su integral | **nuevo** | a, ω | `imu.py` + UI |
| G4 | **Aceleración horizontal en el mundo** `|a_h|` (diagnóstico) | **nuevo** | a, ω | `imu.py` |
| G5 | **Compensación de brazo de palanca** `α×r + ω×(ω×r)` | **nuevo, opcional** | a, ω | `imu.lever_arm` |

### 3.6 Integración y deriva

| # | Algoritmo | Estado | Datos | Dónde |
|---|---|---|---|---|
| I1 | Trapecio `cumulative_trapezoid` | existente | — | `dsp.integrate_velocity` |
| I2 | Detrend lineal sobre toda la ventana | existente | — | `dsp.detrend_linear` |
| I3 | HP Butterworth como alternativa al detrend | existente | — | filtro #8 |
| I4 | **Detrend por segmentos entre reposos** (`v = 0` en ambos extremos de cada movimiento) | **nuevo** | detector | `dsp.detrend_segments` |

### 3.7 Detección de reposo y ZUPT

| # | Detector | Estado | Datos | ¿Vectorizable? |
|---|---|---|---|---|
| Z1 | RMS de `|a|` filtrada ≤ umbral + guarda `|v| < 0.3` (`isStill()` de `vbt.ts:454`) | existente | a | sí |
| Z2 | **ARE** — energía de velocidad angular | **nuevo** | ω | sí |
| Z3 | **SHOE** — GLRT de Skog et al. (acelerómetro + giro normalizados por su ruido) | **nuevo** | a, ω | sí |

La acción ZUPT (clampear `v = 0`, `apply_zupt`) no cambia; cambia **quién decide** dónde hay
reposo. Y el mismo detector alimenta a C4 (bias online), O6 (anclas) e I4 (detrend por segmentos):
**un detector de reposo bueno paga cuatro veces**.

### 3.8 Análisis (herramientas que eligen, no que corrigen)

| # | Herramienta | Estado | Datos |
|---|---|---|---|
| A1 | PSD de Welch crudo vs filtrado | existente | cualquiera |
| A2 | Residuos de Winter → corte recomendado | existente | cualquiera |
| A3 | Retardo de grupo (ms y muestras) | existente | — |
| A4 | **Desviación de Allan** (ARW, inestabilidad de bias) por eje | **nuevo** | a, ω |
| A5 | **Bias vs temperatura** (dispersión + ajuste + R²) por eje | **nuevo** | a, ω, T |
| A6 | **Inclinación de la barra θ(t)** y máximo por ventana | **nuevo** | a, ω |

### 3.9 Exportación a C

| # | Snippet | Estado |
|---|---|---|
| E1 | Biquad cascade / un polo / mediana / SMA | existente (`dsp.export_c_snippet`) |
| E2 | **Mahony (y complementario) con rechazo + `a_vert` mundo** | **nuevo** |
| E3 | **Madgwick IMU + `a_vert` mundo** | **nuevo** |
| E4 | **Corrección térmica** (6 pendientes + `T_ref`) | **nuevo** |

---

## 4. El pipeline nuevo

```
                    ┌──────────── Capturar reposo: ĝ₀, |g|, b_ω, T_cal ─────────────┐
                    │                                                                 │
a, ω ──[P4 huecos]──[− b_ω(T)]──[fusión O0..O6]──> q(t) ──> ĝ(t) ──[G2: a·ĝ − |g|]──> a_vert
             ☑             ☑            ▲                                              │
                                        │ re-ancla + re-bias en cada reposo            │
                    detector Z1/Z2/Z3 ──┴──────────────────────────────┐               │
                                                                        ▼               ▼
                                     a_vert ──[filtro §3.3]──[∫dt]──[I2 / I4]──[ZUPT]──> v_vert
                                                   ☑                     ☑       ☐
```

Tres observaciones que el agente tiene que respetar:

1. **La fusión corre sobre las señales sin filtrar** (ya pasadas por el DLPF on-chip). El
   pasa-bajos de `PLAN.md §5.2` va **después**, sobre el escalar `a_vert`. Razón: con `R(q)`
   variando en el tiempo, filtrar-y-rotar ≠ rotar-y-filtrar; y filtrar el giro antes de integrarlo
   agrega retardo de fase entre giro y acelerómetro, que desalinea la corrección. En el micro,
   además, es 1 biquad en vez de 6.
2. **Giro y acelerómetro ya llegan alineados en el tiempo.** Con `MPU6050_BAND_21_HZ` el datasheet
   da 8,5 ms de retardo para el acelerómetro y 8,3 ms para el giro: 0,2 ms de diferencia, 2% de
   una muestra. No hace falta compensar retardo entre sensores. **Si** alguien decide filtrar las
   entradas de la fusión, tiene que aplicar el mismo filtro a los 6 ejes.
3. **G2 es la misma fórmula que G1.** `project_vertical` hace `a·ĝ₀ − |g|`. La fusión solo
   reemplaza el vector constante `ĝ₀` por `ĝ(t)`, la tercera fila de `R(q)`:
   `ĝ(t) = [2(q₁q₃ − q₀q₂), 2(q₀q₁ + q₂q₃), q₀² − q₁² − q₂² + q₃²]` — que es exactamente el vector
   `v` que Mahony y Madgwick ya calculan adentro. En el micro, `a_vert` sale con 3 mul + 3 add
   extra.

El toggle "integración cruda" de `PLAN.md §5.3` se mantiene. El pipeline viejo (O0 + Z1 + I2) se
mantiene seleccionable **y es el default**: es el único número comparable contra la app móvil.

---

## 5. Detalle de cada algoritmo nuevo

### 5.1 Flags como datos (P4, P5)

`firmware/src/main.cpp` marca `IMU_READ_FAILED` cuando `mpu.getEvent()` falla, y en ese caso los
`sensors_event_t` traen **la lectura anterior**. Hoy `to_grid` los trata como muestras reales:
repite un valor viejo como si fuera nuevo, que para la integración es un escalón falso.

- **P4**: en `to_grid`, excluir del conjunto de muestras "reales" las que tengan
  `FLAG_IMU_READ_FAILED`, y dejar que la interpolación existente las rellene y las marque en
  `filled`. Es un cambio de 3 líneas y reusa todo lo que ya existe (incluido el warning de
  `filled.mean() > 0.05`).
- **P5**: `ACCEL_CLIPPED` / `GYRO_CLIPPED` **no** se interpolan — el valor riel es un piso de la
  magnitud real, no un valor inventado. Se pintan como marcas rojas, se cuentan en Stats, y:
  - accel clippeado ⇒ la muestra entra al fusor como "aceleración rechazada" (§5.3) y la ventana
    de velocidad que la contiene se marca "no confiable".
  - giro clippeado ⇒ la orientación queda marcada **degradada** hasta el próximo re-anclaje en
    reposo (§5.5). Un giro de >500 °/s integrado con el valor riel subestima el ángulo sin remedio.

**Rechazado:** reconstruir el tramo clippeado (spline, ajuste de parábola). Es inventar señal
justo en el pico, que es la métrica que importa.

### 5.2 Cuaterniones y orientación inicial (O1, O2, C3)

Todo en `imu.py`, funciones puras sobre escalares y arrays, sin clases de "servicio":

```python
def quat_integrate(q, gx, gy, gz, dt):      # q ⊗ [1, ω·dt/2], renormalizado
def gravity_body(q):                         # ĝ(t) en el marco del sensor (3ª fila de R)
def tilt_quat(ax, ay, az):                   # cuaternión con roll/pitch del vector medido, yaw = 0
def tilt_angle(q, q0):                       # θ entre ĝ(t) y ĝ₀, en grados
```

- **Orientación inicial = `tilt_quat(calib.bias)`** del "Capturar reposo". El mismo vector que hoy
  alimenta `project_vertical` define el cero de orientación: con eso, **O0 y O4 coinciden
  exactamente mientras la barra no rota**, y cualquier diferencia entre ambos es rotación real.
- Sin calibración: tomar la media de los primeros 0,5 s del segmento. Nunca `q = [1,0,0,0]` a
  ciegas: el sensor puede estar montado en cualquier orientación (`PLAN.md §11.4`).
- **Guiñada**: con 6 ejes es inobservable, así que deriva sin corrección. No importa: `ĝ(t)`
  no depende de ella. Mostrarla en gris con la etiqueta "no observable — deriva".

### 5.3 Mahony, complementario y rechazo de aceleración (O3, O4)

Mahony (Mahony, Hamel & Pflimlin 2008) es un filtro complementario sobre SO(3) con término
integral. El error es el producto vectorial entre la gravedad medida y la estimada; la parte
proporcional corrige la orientación y la integral aprende el bias del giro:

```python
# Lazo explícito, escalares y `math`. NO indexar filas de numpy (ver §6).
def mahony_step(st, gx, gy, gz, ax, ay, az, dt, kp, ki, g_ref, tol_mag, tol_ang_cos):
    q0, q1, q2, q3 = st.q
    vx = 2*(q1*q3 - q0*q2); vy = 2*(q0*q1 + q2*q3); vz = q0*q0 - q1*q1 - q2*q2 + q3*q3
    n = math.sqrt(ax*ax + ay*ay + az*az)
    accept = n > 0 and abs(n - g_ref) < tol_mag
    if accept:
        ax, ay, az = ax/n, ay/n, az/n
        accept = ax*vx + ay*vy + az*vz > tol_ang_cos
    if accept:
        ex, ey, ez = ay*vz - az*vy, az*vx - ax*vz, ax*vy - ay*vx
        st.ix += ki*ex*dt; st.iy += ki*ey*dt; st.iz += ki*ez*dt
        gx += kp*ex; gy += kp*ey; gz += kp*ez
    gx += st.ix; gy += st.iy; gz += st.iz    # el bias aprendido se sigue aplicando
    st.q = quat_integrate(st.q, gx, gy, gz, dt)
    st.accepted = accept
```

- `Kp` acá es el `twoKp` del código de referencia de Mahony: la constante de tiempo de la
  corrección de inclinación es **`τ ≈ 1/Kp` segundos**. Default `Kp = 1.0` (τ = 1 s), `Ki = 0.05`.
  El bias estimado es `−(ix, iy, iz)`; graficarlo.
- **Complementario (O3) = Mahony con `Ki = 0`.** No se escribe otro filtro. Es el mismo código con
  un parámetro en cero, y eso vuelve la comparación O3 vs O4 honesta por construcción.
- El integral **solo aprende las componentes del bias perpendiculares a la gravedad** (el error es
  un producto vectorial con `ĝ`). El eje del sensor alineado con la vertical no se aprende online;
  por eso C2 (bias en reposo, 3 ejes) y C4 (re-bias en cada reposo) siguen haciendo falta.

**Rechazo de aceleración.** Todos estos filtros asumen que el acelerómetro mide solo gravedad.
Durante una rep eso es falso. La solución estándar (Fusion de x-io, `imufusion`) es dejar de
corregir cuando la medición no parece gravedad, y seguir solo con el giro:

- **Umbral de magnitud** `| |a| − |g| | < tol_mag` (default **1,0 m/s²**). Protege del caso
  patológico: en una caída rápida (recepción de una cargada) `|a| → 0` y normalizarla amplifica
  ruido.
- **Umbral de ángulo** entre `a` medida y `ĝ(t)` estimada `< tol_ang` (default **10°**, el de
  Fusion). Detalle clave para barra: **una aceleración vertical no cambia la dirección de `a`**, así
  que no corrompe la inclinación y el umbral de ángulo la deja pasar; la que corrompe es la
  horizontal (1 m/s² horizontal inclina el vector medido `atan(1/9.81) = 5,8°`). La hipótesis
  §9.4 es que en barra el umbral de ángulo hace casi todo el trabajo.
- El integral **no aprende** mientras se rechaza.
- `st.accepted` se guarda por muestra y se pinta como región sombreada, igual que `filled`.

**Por qué esto funciona para VBT en particular:** una serie tiene reposo entre reps cada pocos
segundos. El filtro corrige durante el reposo y corre solo con el giro durante 1–3 s de
movimiento. El presupuesto de error de ese tramo se calcula en §9.2.

### 5.4 Aceleración vertical en el mundo y fuga de gravedad (G2, G3, G4)

```python
def vertical_world(ax, ay, az, gb, g_mag):   # gb = gravity_body(q) por muestra, (N, 3)
    return ax*gb[:, 0] + ay*gb[:, 1] + az*gb[:, 2] - g_mag
```

- `g_mag` es el `|g|` de la calibración, **no 9.80665**: absorbe el error de escala del
  acelerómetro, igual que hoy `project_vertical`.
- **G3 — fuga de gravedad:** `a_leak = project_vertical(...) − vertical_world(...)` y su integral
  `v_leak`. Es la respuesta directa a `PLAN.md §8.5`, en m/s por rep. Si la barra se inclina θ
  y está quieta, O0 da `−g(1 − cos θ)`: 0,037 m/s² a 5°, 0,149 m/s² a 10°, 0,334 m/s² a 15°.
  Sobre una rep de 2 s, eso es 0,07 / 0,30 / 0,67 m/s de error de velocidad **antes** del detrend.
- **G4 — horizontal:** `a_h = R(q)·a − [0, 0, |g|]`, componentes x/y. Mostrar solo `|a_h|` y
  `|v_h|`: las componentes separadas dependen de la guiñada (que deriva), la magnitud no.
  Es diagnóstico ("¿la barra se va hacia adelante?"), no métrica: el error en horizontal es de
  **primer orden** en el error de inclinación (`g·sin δ`) mientras que en vertical es de segundo
  orden (`g(1 − cos δ) ≈ gδ²/2`). Por eso la vertical es robusta y la horizontal no (§9.2).

### 5.5 Detección de reposo con giro (Z2, Z3) y todo lo que cuelga de ella (C4, O6, I4)

Skog et al. (2010) compararon los cuatro detectores clásicos de velocidad cero (varianza de
aceleración, magnitud de aceleración, energía angular, SHOE) y concluyeron que **el giro es el que
más información de velocidad cero lleva**, y que SHOE, que combina ambos pesados por su ruido, es
el más robusto. Ojo: eso es para pies, que *siempre* rotan al moverse. Ver §9.3 antes de cambiar
el default.

Ambos se vectorizan con `np.convolve(..., mode="same")` — centrado, mismo argumento que
`rolling_rms` (`dsp.py:426`): offline no hay razón para aceptar el retardo de una ventana causal.

```python
def are(gyr, fs, sigma_g, window_s=0.15):
    k = _box(window_s, fs)
    return np.convolve((gyr**2).sum(1), k, "same") / sigma_g**2

def shoe(acc, gyr, fs, sigma_a, sigma_g, g_mag, window_s=0.15):
    k = _box(window_s, fs)
    mean_a = np.stack([np.convolve(acc[:, i], k, "same") for i in range(3)], axis=1)
    u = mean_a / np.linalg.norm(mean_a, axis=1, keepdims=True)
    # (1/W)·Σ‖a_k − g·u‖² = mean(‖a‖²) − 2g·(u·mean(a)) + g²
    term_a = np.convolve((acc**2).sum(1), k, "same") - 2*g_mag*(u*mean_a).sum(1) + g_mag**2
    return term_a / sigma_a**2 + are(gyr, fs, sigma_g, window_s)
```

- `σ_a`, `σ_g`: el desvío estándar de cada sensor medido en el mismo "Capturar reposo" (o la
  densidad de ruido de Allan, §5.8). No usar los del datasheet: son de población, no de esta placa.
- Umbral `γ`: **relativo al reposo, no absoluto** — `γ = 3 × mediana(estadístico)` sobre la
  captura de reposo, editable. Un umbral absoluto como los de `gaitmap` depende de unidades y de
  ruido de otra IMU; uno relativo se auto-calibra con cada placa.
- La guarda `|v| < v_max` de `apply_zupt` se mantiene para los tres detectores.

**C4 — bias online.** En cada intervalo de reposo detectado de al menos 1 s, con `|mean(ω)|` bajo
3 °/s (el criterio de Fusion): `b_ω ← mean(ω)` sobre ese intervalo, los 3 ejes. En el mismo
intervalo, **re-anclar la inclinación** con `tilt_quat(mean(a))` conservando la guiñada. Esto es
lo que vuelve irrelevante la deriva térmica lenta del giro (§5.7) sin modelo térmico.

**O6 — integración entre anclas (la referencia no causal).** Entre el fin de un reposo `t_a` y el
comienzo del siguiente `t_b`, la inclinación se conoce en ambos extremos (del acelerómetro quieto).
Integrar el giro desde `q_a`; en `t_b` el error de inclinación es `δ = q_b ⊗ q_int(t_b)⁻¹`;
repartirlo linealmente en el tiempo con `slerp(1, δ, (t − t_a)/(t_b − t_a)) ⊗ q_int(t)`.
**Es el `detrend_linear` de la orientación**: un bias constante del giro produce un error de ángulo
lineal en el tiempo, y esto es su inversa exacta, no un ajuste a ojo. Cumple el mismo rol que el
filtro #4 (`sosfiltfilt`): lo imposible en el micro, contra lo que se mide lo posible.

**I4 — detrend por segmentos.** Mismo razonamiento aplicado a la velocidad: en cada segmento de
movimiento entre dos reposos, integrar desde `v(t_a) = 0` y restar la rampa que lleva `v(t_b)` a 0.
`detrend_linear` (`dsp.py:407`) es el caso particular de un solo segmento; se reusa por segmento.
A diferencia del clamp de `apply_zupt`, **no deja discontinuidades** en `v`. Es no causal dentro
de la rep, pero la velocidad media de una rep se reporta al terminarla, así que en el micro es
viable con un buffer de la rep (≤ 5 s × 100 Hz = 500 floats).

### 5.6 Madgwick IMU (O5)

Portar `MadgwickAHRSupdateIMU` del código de referencia publicado con el reporte de Madgwick
(2010): un paso de descenso por gradiente hacia la gravedad medida, con ganancia `β`. Default
`β = 0.033` (el de `ahrs`); barrer 0,01–0,2 en la UI.

- Mismo rechazo de aceleración que §5.3 (si se rechaza, el paso es solo la integración del giro).
- **Equivalencia contra `ahrs.filters.Madgwick`** con las mismas ganancias, `q0` y sin rechazo:
  `np.allclose`. Es el mismo patrón que el un-polo contra `lfilter` de `PLAN.md §5.2`: la prueba
  de que el lazo propio (el que se exporta a C) es el filtro publicado. Mismo test para Mahony
  contra `ahrs.filters.Mahony`. Si `ahrs` discretiza distinto (exponencial cerrada en vez de Euler),
  comparar con una tolerancia que lo refleje y documentarla en el test — no cambiar nuestro lazo
  para que coincida.
- La versión IMU de Madgwick **no estima bias** (la compensación de deriva del reporte es para la
  versión MARG). Es una diferencia estructural con Mahony que la hipótesis §9.5 tiene que medir.

### 5.7 Temperatura (C5, C6, A5)

El datasheet del MPU-6000/6050 da cotas de población, no pendientes típicas, pero alcanzan para
saber que el orden de magnitud importa:

| Magnitud | Cota del datasheet | Por °C (cota) |
|---|---|---|
| ZRO del giro vs T (−40 a +85 °C) | ±20 °/s | **≈ 0,16 °/s/°C** |
| Zero-g del accel X/Y vs T (0 a 70 °C) | ±35 mg | ≈ 0,5 mg/°C ≈ 0,005 m/s²/°C |
| Zero-g del accel Z vs T (0 a 70 °C) | ±60 mg | ≈ 0,86 mg/°C ≈ 0,008 m/s²/°C |
| Sensibilidad del accel vs T | ±0,02 %/°C | despreciable |

`tempC` es la temperatura **del die**, que incluye el autocalentamiento: es exactamente la que
correlaciona con el bias. Resolución 1/340 °C.

- **C5a — guarda de calentamiento.** `dT/dt` sobre una media móvil de 10 s. Si
  `|dT/dt| > 0.2 °C/min` (default a validar), "Capturar reposo" avisa "sensor en calentamiento —
  la calibración va a envejecer rápido". Avisa, no bloquea.
- **C5b — calibración vieja.** `Calibration` guarda `temp_c`. Si `|T − T_cal| > 2 °C`, la barra de
  estado lo marca. 2 °C × 0,16 = 0,32 °/s de bias de giro en el peor caso: ya se ve en O1.
- **C6 / A5 — modelo térmico.** Sobre una grabación larga de reposo desde el encendido en frío
  (≥ 15 min, desde CSV): ventanas de 10 s, media por eje y media de T por ventana,
  `np.polyfit(T, bias, 1)` por eje. Reportar pendiente, R² y RMS del residuo. Corrección:
  `x − (polyval(p, T) − polyval(p, T_ref))` con `T_ref = T_cal`. Grado 2 como opción; más no:
  la literatura de calibración térmica del MPU6050 no encuentra mejora significativa con 4º orden.
  Ajustar solo el tramo de calentamiento; si hay tramo de enfriamiento, mostrarlo en otro color
  para ver histéresis en vez de promediarla.
- El acelerómetro en reposo mezcla bias y proyección de gravedad, pero si el sensor no se mueve la
  proyección es constante y la **pendiente** sigue siendo la del bias. Por eso la captura tiene que
  ser sin tocar la placa.

### 5.8 Desviación de Allan (A4)

Escrita a mano en ~15 líneas (no hace falta `allantools` para una fórmula), sobre datos de tasa:

```python
def oadev(y, fs, m_list):
    theta = np.concatenate([[0.0], np.cumsum(y) / fs])   # "fase" = integral de la tasa
    out = []
    for m in m_list:
        tau = m / fs
        d = theta[2*m:] - 2*theta[m:-m] + theta[:-2*m]
        out.append(np.sqrt(np.sum(d**2) / (2 * tau**2 * len(d))))
    return np.asarray(m_list) / fs, np.asarray(out)
```

`m_list` en octavas (1, 2, 4, …, N/10). Lecturas:
- **ARW / VRW**: valor de la recta de pendiente −½ evaluada en τ = 1 s. Para el giro del MPU6050
  el datasheet da 0,005 °/s/√Hz ⇒ ADEV(1 s) ≈ 0,005 °/s. Mostrar el medido al lado.
- **Inestabilidad de bias**: `min(ADEV) / 0.664`, y el τ donde ocurre.
- **Pendiente +1 a τ largos** = rampa de tasa: ahí es donde se ve la deriva térmica. Superponer
  la curva de T de la misma grabación.

Solo desde CSV: el buffer en vivo son 60 s, y para ver la inestabilidad de bias hace falta τ de
cientos de segundos (grabación ≥ 30 min). Para qué sirve: `σ_g` y `σ_a` de SHOE (§5.5), la cota
de cuánto bias puede aprender `Ki`, y un EKF si algún día se justifica (§10).

### 5.9 Brazo de palanca (G5, opcional)

El acelerómetro no está sobre el eje de la barra. En el marco del sensor:

```
a_medida = a_eje + α × r + ω × (ω × r)        α = dω/dt,  r = vector sensor → eje de la barra
```

- `r` lo **ingresa el usuario** (3 campos en mm, medidos con calibre). Con una sola IMU no hay
  forma de estimarlo: las estimaciones por mínimos cuadrados de la literatura necesitan una
  referencia de `a_eje`.
- `α` = derivada de `ω` con `signal.savgol_filter(ω, w, 3, deriv=1, delta=1/fs)` offline (no
  causal); diferencia hacia atrás sobre `ω` ya pasado por un LP para la versión causal.
- **Primero medir si importa**: mostrar el RMS de `ω×(ω×r)` sobre la captura. Barra olímpica de
  28 mm con el sensor en un clip a ~30 mm del eje, rodando a 3 rad/s: `ω²r = 0,27 m/s²`. En
  sentadilla la barra casi no rueda y el término es ~0; en arranque/cargada puede no serlo. Si el
  RMS queda bajo 0,05 m/s², la UI lo dice y el checkbox no aporta.

---

## 6. Rendimiento: el primer algoritmo con estado

`PLAN.md §6` decidió re-filtrar el buffer entero (6000 muestras) en cada frame de 33 ms y dejó
anotado el techo. Los filtros de scipy están vectorizados; **la fusión no se puede vectorizar**:
cada cuaternión depende del anterior. Medido en este venv (Python 3.14.7, lazo de Mahony sobre
6000 muestras):

| Implementación | Tiempo por pasada completa |
|---|---|
| Indexando filas de un `np.ndarray` | **50,7 ms** — no entra en el frame |
| Sobre listas de Python + `math` | **18,8 ms** — entra, pero se come medio frame |

Decisión:

- **`OrientationTracker` incremental.** Guarda el estado (`q`, integral, último `seq` procesado)
  y en cada frame procesa **solo las muestras nuevas** (~3 por frame a 100 Hz). Guarda `q` por
  muestra en un `deque(maxlen=6000)` paralelo al `LiveBuffer`. Como los estimadores son causales,
  descartar muestras viejas por la izquierda no cambia las de la derecha.
- **Recomputar completo** solo al cambiar un parámetro, recalibrar, o abrir un CSV. Ahí 19 ms una
  vez es irrelevante.
- Los lazos iteran sobre `.tolist()`, no sobre filas de numpy (factor 2,7 medido).
- Corte de segmento (P2) o `SCHED_RESYNC` ⇒ reiniciar el tracker desde la inclinación del próximo
  reposo; no integrar giro a través del hueco.
- O6 (anclas) y A4/A5 son no causales o de grabación completa: se computan a demanda (al pausar,
  al abrir CSV o con un botón), nunca por frame.
- SHOE/ARE son convoluciones: siguen la regla stateless vieja sin problema.

```python
# ponytail: tracker incremental por seq; recompute completo solo al cambiar parámetros.
# Techo: el recompute completo es O(N) en Python puro (~19 ms / 6000 muestras). Si el
# buffer crece a varios minutos, recomputar en un QThread o cachear por segmento.
```

---

## 7. `app.py` — la UI

La barra de estado suma **T actual** y, si hay calibración, **ΔT desde la calibración** (en
amarillo si supera los 2 °C de §5.7). Todo lo nuevo se deshabilita con un texto explicativo si la
captura es v1 (`gyro_available()` falso): **nunca** fabricar ceros de giro.

| Pestaña | Cambios |
|---|---|
| **1 · Stream** | Sin cambios (ya muestra giro, T y flags) |
| **2 · Accel** | Marcas rojas en muestras clippeadas (P5); regiones `IMU_READ_FAILED` sombreadas como `filled` |
| **3 · Velocity** | Combo **"Fuente de `v_vert`"**: `Proyección fija (vbt.ts)` / `Orientación: O1…O6`. Las dos curvas superpuestas en el 4º plot (fija en gris, dinámica en color) + lectura de `v_leak` al final de la ventana. Combo **"Detector de reposo"**: Z1/Z2/Z3 con su umbral. Checkbox **"Detrend por segmentos"** (I4). Checkbox **"Brazo de palanca"** + 3 campos de `r` y la lectura de RMS de §5.9 |
| **4 · Stats** | Filas nuevas: `a_vert (mundo)`, `θ inclinación`, `|a_h|`. Contador de muestras clippeadas en el ámbito |
| **5 · Filters** | El combo de señal suma `a_vert (mundo)`. Botones de export nuevos (§8) |
| **6 · Orientation** (nueva) | Combo de estimador O0–O6 + parámetros (`Kp`, `Ki`, `β`, `tol_mag`, `tol_ang`, checkbox de rechazo). Plots enlazados en X: roll, pitch, yaw (gris, "no observable"), **θ total**, **fuga `g(1 − cos θ)`**, bias estimado del giro (3 curvas). Sombreado donde se rechazó la aceleración. Si hay un estimador de referencia elegido, se superpone en punteado |
| **7 · Sensor** (nueva) | T vs tiempo + `dT/dt`; dispersión bias vs T por eje con la recta ajustada, pendiente y R² (A5); Allan log-log de los 6 ejes con ARW e inestabilidad anotadas (A4). Botones **[Export calibración térmica]** |

"Capturar reposo" pasa a guardar también `b_ω` (3 ejes), `T_cal`, `σ_a`, `σ_g` y el umbral de
SHOE/ARE relativo (§5.5). Las guardas existentes (`8.5 ≤ |g| ≤ 11`, RMS ≤ 0.12) no cambian; se
suma una sobre el giro: `|mean(ω)| < 3 °/s`, porque si no, no estaba quieto.

---

## 8. Exportador de C — los snippets nuevos

Mismo contrato que `PLAN.md §5.6`: el snippet sale de **los mismos parámetros** que produjeron la
curva en pantalla, con un encabezado que dice qué es, a qué `fs`, con qué costo.

- **E2 — Mahony** (`Ki = 0` ⇒ se rotula "complementario"): plantilla escrita a mano, con `Kp`,
  `Ki`, `dt`, `|g|`, `tol_mag` y `cos(tol_ang)` como `static const float`. Estado: `q[4]`,
  `integral[3]`. La función devuelve `a_vert` (§4.3), así que el pasa-bajos exportado con E1 se
  engancha a su salida sin nada en el medio. Incluye `q0` inicial desde el vector de reposo
  (`tilt_quat` portado).
- **E3 — Madgwick IMU**: ídem, con `β`.
- **E4 — Corrección térmica**: 6 pendientes + `T_ref` + la función `x -= k*(T - T_ref)` por eje.
  Se exporta **solo si** el R² del ajuste supera 0,8 en al menos un eje; si no, el snippet sale
  como comentario diciendo por qué no hace falta.

Lo que el test puede verificar sin compilador: que la plantilla no deja placeholders sin
reemplazar, que los floats salen con sufijo `f`, y que un lazo Python **escrito con la misma
secuencia de operaciones que el C** coincide con `mahony_step`. La verificación de que compila
es `pio run` (§12).

---

## 9. Hipótesis a validar

El plan no presupone la respuesta. Estas son las formas que se esperan, para no construir de más.

1. **La fuga de gravedad puede ser menor de lo que `PLAN.md §8.5` sospechaba.** Entra al vertical
   en segundo orden: `g(1 − cos θ) ≈ gθ²/2`. En sentadilla o banca la barra se inclina pocos
   grados: a 5° son 0,037 m/s², y el detrend absorbe la parte constante. En arranque y cargada, o
   si el sensor va en el extremo de la barra y esta cabecea, puede no serlo. **G3 lo mide por rep;
   ese número decide si el micro necesita fusión.**
2. **La deriva del giro dentro de una rep es despreciable para el vertical, si el bias se
   re-estima en cada reposo.** Con bias residual de 0,1 °/s durante 3 s de movimiento, el error de
   inclinación es 0,3°: en vertical `g(1 − cos 0,3°) ≈ 1,3·10⁻⁴ m/s²` (nada); en horizontal
   `g·sin 0,3° ≈ 0,05 m/s²` (no despreciable — por eso G4 es diagnóstico). **Sin** re-estimación,
   el peor caso térmico del datasheet (0,16 °/s/°C × 5 °C de autocalentamiento = 0,8 °/s) da 2,4°
   en 3 s: todavía chico en vertical, grande en horizontal.
3. **El giro ayuda menos a detectar reposo en barra que en pies.** Skog et al. validaron sobre
   pies, que rotan siempre que se mueven. Una barra que sube a velocidad constante sin rotar tiene
   `ω ≈ 0` y `|a| ≈ g`: **ARE y el acelerómetro fallan juntos**, y SHOE también. Es exactamente el
   caso de las reps lentas cerca del máximo (< 0,3 m/s), donde además la guarda `v_max = 0.3` deja
   de proteger. Esperado: SHOE ≈ Z1 con algo menos de falsos positivos; ARE solo, peor. **Por eso
   el default sigue siendo Z1** hasta que una captura con reps lentas diga otra cosa.
4. **En barra, el umbral de ángulo del rechazo hace casi todo el trabajo** (§5.3): la aceleración
   dominante es vertical, que no cambia la dirección de `a`.
5. **Mahony ≈ Madgwick en exactitud; gana el más barato.** Mahony además estima bias. Si la
   diferencia contra O6 es menor que la diferencia contra la variabilidad entre reps, elegir
   Mahony y no discutir más.
6. **El calentamiento de los primeros minutos domina la deriva térmica;** después, el re-bias en
   reposo (C4) alcanza y el modelo térmico (C6) no hace falta en el micro. Si A5 da R² alto pero
   la corrección no mejora la velocidad con C4 activo, no se exporta E4.
7. **El brazo de palanca es despreciable en sentadilla y banca** (§5.9). Medirlo una vez y cerrar
   el tema.

Orden de trabajo sugerido una vez implementado: (1) 30 min de reposo desde frío → A4 + A5, decide
6; (2) rotaciones a mano → valida O1–O5 y el signo de G2; (3) 5 reps de sentadilla y 5 lentas →
G3 decide 1, detectores deciden 3; (4) A/B O4 vs O5 vs O6 → decide 5; (5) exportar.

---

## 10. Rechazados explícitamente

- **EKF / UKF / ESKF de orientación.** Es la respuesta "de libro" y los parámetros de ruido
  saldrían de Allan (§5.8). Pero con reposos cada pocos segundos, un complementario con re-bias
  llega al mismo lugar sin matrices de covarianza que sintonizar ni ~miles de flops por muestra.
  Reabrir **solo** si O4 queda lejos de O6 en las capturas reales.
- **Algoritmos MARG / con magnetómetro, y cualquier cosa que dependa de la guiñada.** No hay
  magnetómetro, y cerca de discos de hierro no serviría.
- **INS completo / posición 3D / trayectoria de la barra.** La horizontal es sensible en primer
  orden al error de inclinación y la guiñada es inobservable (§5.4). Queda `|v_h|` como
  diagnóstico.
- **Detectores de reposo aprendidos (LSTM, umbral adaptativo por ML).** No hay datos etiquetados,
  no hay camino razonable al ESP32, y el problema de §9.3 es de observabilidad, no de umbral.
- **Calibración de escala/desalineación del giro con mesa rotatoria.** El ±3% de escala del
  datasheet a 10° de inclinación son 0,3°: segundo orden en vertical. El test de rotación de 90° a
  mano (§12.2) alcanza para confirmar que no hay un error groseramente mayor.
- **Reconstrucción de tramos clippeados.** Ver §5.1.
- **Re-muestreo con `jitterUs`.** El error de amplitud por jitter es `|da/dt|·Δt`; con 50 m/s³ y
  200 µs son 0,01 m/s², debajo del ruido. `timing_stats` ya lo mide; reabrir solo si el spread
  medido lo contradice.
- **`imufusion` como dependencia.** Ver §1.

---

## 11. `test_imu.py` — el chequeo corrible

Asserts planos, sin framework, igual que `test_dsp.py`. Corre con `python test_imu.py`.
Los tests que usan `ahrs` imprimen `SKIP` si no está instalado, no fallan.

1. **Integración del cuaternión** — `ω` constante 0,5 rad/s en X durante 2 s ⇒ ángulo 1,0 rad
   (`atol 1e-3`). Y `gravity_body` después de 90° en X lleva `[0,0,1]` a `[0,1,0]` o `[0,−1,0]`
   según la convención — el test fija cuál y lo documenta.
2. **Reposo nivelado** — `a = (0, 0, g)`, `ω = 0` ⇒ `q` se queda en `[1,0,0,0]` con O1–O5, y
   `vertical_world ≈ 0`.
3. **La fuga de gravedad** — rotación pura de 0° a 20° en X y vuelta, sin traslación, con `a`
   consistente (`g·ĝ(t)`) y `ω` exacto. `project_vertical` da `−g(1 − cos θ)` ≠ 0; `vertical_world`
   con O1 da `|a| < 1e-3` y `|v| < 0.01 m/s` al final.
4. **Bias por el integral de Mahony** — reposo con 0,02 rad/s de bias inyectado en X (eje
   horizontal); tras 60 s, `−ix` dentro del 10% y error de inclinación < 0,5°. Con `Ki = 0` el
   error de inclinación es mayor (assert de la desigualdad, no de un número).
5. **Rechazo de aceleración** — reposo inclinado 10° + 1 s de 3 m/s² horizontales: con rechazo,
   error de inclinación < 0,5°; sin rechazo, mayor.
6. **Equivalencia con `ahrs`** — Madgwick y Mahony propios vs `ahrs.filters`, mismos parámetros,
   mismo `q0`, sin rechazo, 10 s de señal sintética rotando: `np.allclose` (ver §5.6 sobre la
   tolerancia).
7. **Detectores** — quieto 2 s / moviendo y rotando 2 s / quieto 2 s, con ruido: Z2 y Z3 marcan
   los reposos con error de borde ≤ una ventana.
8. **Detrend por segmentos** — bias constante de accel + dos reposos ⇒ `v` exactamente 0 en ambos,
   y continua en los bordes (a diferencia del clamp).
9. **Anclas (O6)** — bias constante de giro entre dos reposos ⇒ O6 recupera la inclinación
   verdadera en todo el tramo (`< 0.1°`), O1 no.
10. **Modelo térmico** — `b = b₀ + k(T − T₀) + ruido` sintético ⇒ el ajuste recupera `k` dentro
    del 5% y R² > 0,9.
11. **Allan** — ruido blanco de σ conocido ⇒ pendiente log-log −0,5 ± 0,05 y `ADEV(τ₀) ≈ σ`.
12. **Brazo de palanca** — rotación constante alrededor de un eje desplazado `r` ⇒ la aceleración
    medida es `ω×(ω×r)` y la compensada `≈ 0`.
13. **Tracker incremental ≡ pasada completa** — procesar una señal en trozos de 3 muestras y de una
    sola vez da los mismos cuaterniones (`np.allclose`). Blinda §6.

En `test_dsp.py`: **14.** `to_grid` con una muestra `IMU_READ_FAILED` en el medio ⇒ esa muestra
queda `filled` e interpolada; **15.** captura v1 (giro NaN) ⇒ las funciones de `imu.py` devuelven
`None` y nada lanza.

**El #3 es el que importa**: es el que falla si alguien usa `R` donde iba `Rᵀ`, invierte el signo
de la gravedad o confunde grados con radianes — y cualquiera de esos errores produce curvas que se
ven razonables.

---

## 12. Orden de implementación y verificación

| # | Paso | Verificación |
|---|---|---|
| 1 | P4 en `to_grid`; `Calibration` con `b_ω`, `T_cal`, `σ_a`, `σ_g` | tests 14–15 pasan; `test_dsp.py` completo sigue pasando |
| 2 | `imu.py`: núcleo de cuaterniones, `tilt_quat`, `vertical_world` | tests 1–3 |
| 3 | Mahony + rechazo + `OrientationTracker` incremental | tests 4, 5, 13 |
| 4 | Madgwick | test 6 |
| 5 | Velocity: selector de fuente de `v_vert` y superposición | abrir un CSV v2: con la barra quieta, ambas curvas coinciden |
| 6 | Detectores Z2/Z3, bias online (C4), detrend por segmentos (I4) | tests 7–8 |
| 7 | Pestaña Orientation | con el sensor: rotar a mano, roll/pitch siguen, yaw deriva |
| 8 | Anclas (O6) | test 9 |
| 9 | Temperatura: guardas C5, ajuste C6, pestaña Sensor | test 10 |
| 10 | Allan | test 11 |
| 11 | Brazo de palanca (opcional) | test 12 |
| 12 | Exportador E2–E4 + `README.md` | el snippet pegado en `main.cpp` compila con `pio run` |

Solo los pasos 7 y la verificación de punta a punta necesitan el hardware. Todo el resto se
desarrolla contra señales sintéticas o CSVs v2 grabados.

**Verificación de punta a punta**, con el ESP32 encendido:

```bash
cd clients/desktop
.venv/Scripts/python test_dsp.py && .venv/Scripts/python test_imu.py
.venv/Scripts/python app.py
```

1. **Reposo 60 s** tras "Capturar reposo": O4 mantiene θ < 0,5°; O1 deriva, y la pendiente de esa
   deriva es el bias residual del giro.
2. **Rotación de 90° a mano** en un eje y vuelta a reposo: O1 integra 90° ± 3% (tolerancia de
   escala del datasheet). En Velocity, la proyección fija baja hasta `−|g|` a los 90° y la
   dinámica se queda cerca de 0. **Ese contraste es la demostración** de que G2 funciona.
3. **Inclinado 20° y quieto**: la fija da `−g(1 − cos 20°) = −0,59 m/s²` constante y su `v`
   es una rampa; la dinámica, plana.
4. **Deslizar la placa sobre la mesa** (aceleración horizontal): con rechazo, θ no se mueve; sin
   rechazo, se inclina.
5. **5 reps normales + 5 lentas**: leer `v_leak` por rep (hipótesis 1) y comparar los detectores en
   las lentas (hipótesis 3).
6. **Encender en frío y grabar 30 min quieto**: pestaña Sensor — curva de T, pendientes de bias,
   Allan con ARW cerca de 0,005 °/s en τ = 1 s (hipótesis 6).
7. **Open…** un CSV v1: las pestañas nuevas deshabilitadas con su texto; Velocity cae a proyección
   fija; nada lanza.
8. **Export** E2 → pegar en `main.cpp` → `pio run`.

El paso 2 es el que cierra el objetivo: es la primera vez que la herramienta puede mostrar el error
de `PLAN.md §10` y su corrección sobre la misma curva.

---

## Fuentes consultadas

- [Zero-Velocity Detection — An Algorithm Evaluation (Skog, Händel, Nilsson, Rantakokko, IEEE TBME 57(11), 2010)](https://doi.org/10.1109/TBME.2010.2060723) — los cuatro detectores (varianza de accel, magnitud, ARE, SHOE); el giro lleva la información de velocidad cero más confiable; SHOE como GLRT normalizado por ruido.
- [Revisión de detectores de velocidad cero (arXiv 2008.09208)](https://arxiv.org/abs/2008.09208) — estado del arte posterior, incluidos los detectores aprendidos que §10 rechaza.
- [gaitmap — ShoeZuptDetector](https://gaitmap.readthedocs.io/) — implementación de referencia de SHOE (ventana 0,15 s, varianzas de ruido por sensor, umbral por grid search).
- [An efficient orientation filter for inertial and inertial/magnetic sensor arrays (Madgwick, 2010)](https://x-io.co.uk/downloads/madgwick_internal_report.pdf) — Madgwick IMU/MARG, parámetro β, compensación de deriva solo en MARG.
- [Nonlinear Complementary Filters on the Special Orthogonal Group (Mahony, Hamel, Pflimlin, IEEE TAC 2008)](https://doi.org/10.1109/TAC.2008.923738) — filtro complementario explícito con término integral de bias.
- [Fusion (x-io Technologies)](https://github.com/xioTechnologies/Fusion) / [imufusion](https://pypi.org/project/imufusion/) — rechazo de aceleración por ángulo (10°), período de recuperación, algoritmo de bias en reposo (< 3 °/s durante 3 s).
- [AHRS: Attitude and Heading Reference Systems (docs)](https://ahrs.readthedocs.io/) — implementaciones numpy de Madgwick, Mahony, complementario, EKF, `acc2q`; referencia de los tests de equivalencia.
- [NXP AN5087 — Allan Variance: Noise Analysis for Gyroscopes](https://www.nxp.com/docs/en/application-note/AN5087.pdf) — ARW en τ = 1 s sobre la pendiente −½, inestabilidad de bias = mínimo / 0,664.
- [allantools](https://github.com/aewallin/allantools) — referencia de la fórmula de ADEV solapada (no se usa como dependencia).
- [MPU-6000/MPU-6050 Product Specification](https://invensense.tdk.com/wp-content/uploads/2015/02/MPU-6000-Datasheet1.pdf) — ZRO y zero-g vs temperatura, densidades de ruido, retardos del DLPF, 340 LSB/°C.
- [PX4 — Sensor Thermal Compensation](https://docs.px4.io/main/en/advanced_config/sensor_thermal_calibration.html) — calibración de bias vs temperatura por polinomio, corrección relativa a `T_ref`, arranque en frío.
- [Validation of an Automatic Inertial Sensor-Based Methodology for Detailed Barbell Velocity Monitoring](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9784026/) — LP + Madgwick para quitar gravedad + ZUPT al inicio de cada concéntrica.
- [Validación de una IMU en peso muerto (biomechanics.iauh.ac.ir)](https://biomechanics.iauh.ac.ir/article-1-418-en.pdf) — 120 Hz, LP 25 Hz, Madgwick + ZUPT; ICC ≈ 0,86 y RMSE ≈ 0,16 m/s en velocidad media; la velocidad pico se subestima hasta −0,19 m/s.
- [Validation of Inertial Sensor to Measure Barbell Kinematics across a Spectrum of Loading Conditions](https://www.mdpi.com/2075-4663/8/7/93) — referencia de exactitud contra la cual comparar.
- [Validez de dispositivos inerciales para medir velocidad de barra (IJERPH 18(17):9170)](https://www.mdpi.com/1660-4601/18/17/9170) — dispersión entre dispositivos IMU comerciales.
- [Revisión sistemática de dispositivos de VBT (PMC8038306)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8038306/) — contexto de qué exactitud es "suficiente" para VBT.
- [Compensación de brazo de palanca en IMUs (arXiv 2607.25784)](https://arxiv.org/abs/2607.25784) — `α×r + ω×(ω×r)`, derivada de ω por kernel suavizado, estimación de `r` con referencia.
