# PLAN — Benchmark de algoritmos aceleración → velocidad para el firmware VBT

> Documento de ejecución para un agente. **Vos (el agente) no decidís el alcance: está acá.** Seguí
> las fases en orden, generá cada archivo que se pide, y no saltees los criterios de "terminado".
> Mismo rol que `PLAN.md` y `PLAN-V2.md`: las decisiones de método ya están tomadas; tu trabajo es
> ejecutarlas, medir y reportar.

---

## 0. Misión

Decidir, **con datos**, qué algoritmo (cadena completa: calibración → orientación → gravedad →
filtro → integración → control de deriva) tiene que correr **en el ESP32 antes del stream BLE**
para convertir aceleración en velocidad vertical de la barra.

Concretamente:

1. Probar **todos los algoritmos que ya existen** en `clients/desktop/dsp.py` e `imu.py` (y el
   pipeline de `clients/mobile/src/vbt.ts`) contra la sesión real
   `clients/desktop/sessions/2026-09-25_163821.csv` y contra un banco semisintético con verdad
   conocida (§4).
2. Determinar cuál entrega **el mejor stream de datos para integrar aceleración en velocidad**.
3. Implementar y probar los **algoritmos adicionales investigados** (§3.2) para ver si alguno
   mejora al mejor existente.
4. Escribir un **informe final** (`clients/desktop/analysis/INFORME.md`) que explique cada
   algoritmo investigado y cada algoritmo usado, **por qué no sirve para esta aplicación** (con
   números), y **por qué el elegido es el definitivo** para el firmware.

> Nota: el usuario nombró el archivo `2026-09-25-163821.csv`; el nombre real en disco es
> `2026-09-25_163821.csv` (guion bajo). Está en `sessions/`, que está en `.gitignore`: el archivo
> existe localmente pero no en git. No lo borres ni lo muevas.

### 0.1 Reglas duras (leer antes de tocar nada)

1. **No modifiques** `dsp.py`, `imu.py`, `app.py`, `protocol.py`, `ble.py`, los tests existentes,
   `clients/mobile/` ni `firmware/`. Solo **importalos**. Si encontrás un bug, se documenta en el
   informe (§7, sección "Hallazgos"); no se arregla en este trabajo.
2. Todo lo nuevo va en `clients/desktop/analysis/` (estructura en §2.3).
3. **Nunca inventes un número.** Cada número del informe sale de un archivo en
   `clients/desktop/analysis/out/`, y el informe cita la ruta de ese archivo.
4. Semillas fijas (`0..19`) en todo lo aleatorio. Un tercero tiene que poder re-correr todo con
   `run_all.py` y obtener lo mismo.
5. Las variantes que usan verdad de terreno (orientación verdadera, reposos verdaderos) llevan el
   sufijo `_oracle` en el nombre. Sirven para **aislar** una etapa; **nunca** pueden ser la
   elección final.
6. Si una dependencia opcional no instala (§2.2), el algoritmo se marca **"no evaluado —
   dependencia"** en el informe, con el error textual. No pierdas más de 15 minutos por
   dependencia.
7. Idioma de código: inglés (como el resto del repo). Idioma del informe y comentarios de
   resultados: español.
8. Si un paso te da un resultado que contradice una hipótesis de §8, **no lo "arregles"**:
   reportalo. Las hipótesis no son el resultado esperado obligatorio.

---

## 1. Contexto que tenés que conocer

### 1.1 Hardware y datos

- Placa: **ESP32-S3** (`firmware/platformio.ini`, 240 MHz, FPU de precisión simple). IMU:
  **MPU6050**, ±8 g, ±500 °/s, DLPF on-chip en 21 Hz (~8,5 ms de retardo), muestreo 100 Hz.
- Paquete BLE v2 (42 bytes): `seq`, `t_us` (hora **agendada**), `ax..az` (m/s²), `gx..gz`
  (rad/s), `temp_c`, `flags`, `tx_dropped`, `jitter_us`. Ver `protocol.py`.
- Convención de orientación (`imu.py`): cuaternión Hamilton `[w,x,y,z]`, **cuerpo → mundo**,
  Z del mundo hacia arriba. En reposo nivelado el acelerómetro lee `+g` en Z.
- `a_vert` positivo = hacia arriba. `a_vert = a · ĝ − |g|`.

### 1.2 Auditoría de la captura (ya hecha — verificala en F0, no la asumas)

| Hecho | Valor |
|---|---|
| Muestras | 1710, `seq` 3006–4715, **0 huecos**, 0 duplicados |
| `fs` reconstruida por `dsp.to_grid` | 100,0 Hz; duración 17,09 s |
| Flags | `LATE` en **el 100 %** de las muestras; 0 `CLIP`, 0 `GCLIP`, 0 `I2C`, 0 `RESYNC`; `tx_dropped` = 0 |
| `jitter_us` | 10 836–10 955 µs (constante ≈ 1 muestra; dispersión p95−p5 ≈ 40 µs) |
| Temperatura | 26,07–26,17 °C (rango de 0,1 °C) |
| `|a|` | p1 5,94 · p50 9,34 · p99 12,42 m/s² |
| `|ω|` | p50 17,7 · p99 76,9 · máx 104,9 °/s |
| Reposo | **Ninguna ventana de 0,3 / 0,5 / 1 s pasa `dsp.calibrate`**. La ventana de 1 s más quieta (t = 15,61 s) tiene un RMS de 0,44 m/s², y el umbral es 0,12. Solo los últimos ~90 ms (t ≥ 17,00 s) están quietos (desvío de `|a|` = 0,033) |
| Movimiento | ~4 ciclos de período ~3–3,5 s entre t ≈ 2,5 y 15,5 s (`|a|` cae a ~6,3–7 m/s² cerca de t ≈ 5,0 / 8,25 / 11,75 / 15,0 s). El sensor **rota todo el tiempo** (10–45 °/s de media por ventana) |

Consecuencias que el plan ya incorpora:

- **El pipeline actual no corre tal cual sobre esta captura**: todo lo que depende de "Capturar
  reposo" (`dsp.calibrate`) falla. §4.4 define estrategias de calibración alternativas.
- **Sin reposos intermedios**, todo lo basado en ZUPT / detrend por segmentos / anclas O6 tiene
  a lo sumo un reposo (el final). Por eso existe el banco semisintético (§4.2): la captura real
  sola no alcanza para puntuar esos algoritmos.
- **La temperatura no varía**: los algoritmos térmicos (C5, C6, A5, E4) **no son evaluables** con
  esta captura. Se listan en el informe como "no evaluable — ΔT = 0,1 °C".
- **`|g|` medido ≈ 9,34 m/s²**, un 4,8 % menos que 9,80665: hay error de escala u offset. Los
  valores absolutos de velocidad heredan ~5 % de incertidumbre; eso se reporta, no se corrige.
- **`LATE` no es pérdida de datos**: no descartes muestras por ese flag (ver §9, trampa 1).
- No sabemos qué gesto se grabó (parece movimiento a mano, no necesariamente una barra). F0 pide
  describir lo observado y el informe lo tiene que decir como limitación.

### 1.3 El pipeline actual (lo que hay que batir)

```
a, ω ──[P4 huecos]──[fusión O0..O6]──> ĝ(t) ──[a·ĝ − |g|]──> a_vert ──[filtro F0..F9]──[∫ trapecio]──[I2/I3/I4]──[ZUPT Z1/Z2/Z3]──> v_vert
```

- Móvil (`vbt.ts`), **línea base B0**: proyección fija O0 + un polo a 10 Hz + trapecio + ZUPT Z1
  en vivo + detrend lineal por rep (`closeRep`, `vbt.ts:503-603`).
- Desktop por default, **línea base B1**: O0 + Butterworth LP de 2º orden a 6 Hz + trapecio +
  detrend lineal sobre la ventana.

---

## 2. Preparación del entorno

### 2.1 Venv existente

```bash
cd /Users/mariano.saez/Personal/side-projects/vbt-sensor/clients/desktop
.venv/bin/python --version            # esperado: 3.12.x
.venv/bin/python -c "import numpy, scipy; print(numpy.__version__, scipy.__version__)"
.venv/bin/python test_dsp.py && .venv/bin/python test_imu.py   # esperado: 19 y 13 tests OK
```

Si los tests no pasan, **pará** y reportalo: sin esa base, nada de lo que sigue es confiable.

### 2.2 Dependencias de análisis

```bash
.venv/bin/pip install matplotlib vqf ahrs
.venv/bin/pip install imufusion        # opcional; tiene extensión en C y puede no compilar
```

Verificación:

```bash
.venv/bin/python -c "import matplotlib; from vqf import VQF, offlineVQF; import ahrs; print('ok')"
.venv/bin/python -c "import imufusion; print(imufusion.__version__ if hasattr(imufusion,'__version__') else 'ok')"
```

Si `vqf` no instala, probá `vqf.PyVQF` (Python puro, viene en el mismo paquete). Si ni eso, aplicá
la regla dura 6.

**No agregues estas dependencias a `requirements.txt`**: son del análisis, no de la app. Anotalas
en `analysis/requirements-analysis.txt`.

### 2.3 Estructura de archivos a crear

```
clients/desktop/analysis/
  requirements-analysis.txt
  common.py            # carga CSV -> Grid, calibraciones CAL-A..D, métricas (§4.3)
  synth.py             # generador semisintético (§4.2)
  candidates.py        # algoritmos nuevos N1..N11 (§3.2, Apéndice A)
  pipelines.py         # catálogo de pipelines: nombre -> función (interfaz en §2.4)
  test_candidates.py   # asserts planos, estilo test_dsp.py (§5, F1)
  f0_audit.py
  f1_synth_validate.py
  f2_filters.py
  f3_orientation.py
  f4_rest.py
  f5_drift.py
  f6_end_to_end.py
  f7_real_capture.py
  f8_firmware_cost.py
  run_all.py           # corre f0..f8 en orden
  out/                 # todo lo generado: CSV de métricas, PNG, JSON
  INFORME.md           # entregable final (§7)
```

Cada `fN_*.py` se corre como `cd clients/desktop && .venv/bin/python analysis/fN_*.py`, y tiene que
poder importar `dsp`, `imu` y `protocol`. Poné al principio de cada script:

```python
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # clients/desktop
```

### 2.4 Interfaz única de pipeline

Todo pipeline (existente o nuevo) se expone con la misma firma, para que los scripts de
evaluación no tengan casos especiales:

```python
@dataclass
class PipelineOut:
    a_vert: np.ndarray        # (N,) m/s², la señal que entraría a la integración
    v: np.ndarray             # (N,) m/s, velocidad vertical final
    quats: np.ndarray | None  # (N,4) si el pipeline estima orientación
    causal_class: str         # "per-sample" | "per-rep-buffer" | "offline"
    notes: str = ""

def run_pipeline(acc, gyr, fs, calib, rest_mask=None, rep_windows=None) -> PipelineOut: ...
```

- `acc` (N,3) m/s², `gyr` (N,3) rad/s, `fs` Hz, `calib` = `dsp.Calibration`.
- `rest_mask` / `rep_windows` solo se pasan a variantes `_oracle`. Los pipelines normales
  detectan reposos por su cuenta.
- `causal_class` es obligatorio y se justifica en `notes`. Definición:
  - **per-sample**: cada salida depende solo de muestras pasadas (se puede streamear por BLE tal cual).
  - **per-rep-buffer**: necesita ver el final de la rep, pero con un buffer acotado (≤ 8 s × 100 Hz).
  - **offline**: necesita la grabación entera o más de 8 s de futuro. Solo sirve como referencia.

---

## 3. Catálogo de algoritmos

### 3.1 Existentes en la base de código (todos se prueban)

| ID | Algoritmo | Dónde | Parámetros a barrer |
|---|---|---|---|
| **Calibración** ||||
| C1 | Vector de reposo + guardas | `dsp.calibrate` | — (falla en la captura real; en sintético sí corre) |
| C2 | Bias de giro en reposo | `dsp.calibrate` | — |
| C3 | Orientación inicial por tilt | `imu.tilt_quat` | — |
| C4 | Re-bias de giro en cada reposo | `imu.OnlineBias` + `OrientationTracker.set_gyro_bias` | on/off (**ojo con el signo, §9 trampa 2**) |
| C5/C6 | Guardas térmicas / modelo térmico | `imu.thermal_fit` | **no evaluable** (ΔT = 0,1 °C) |
| **Filtros sobre `a_vert`** (`dsp.FILTER_BANK`) ||||
| F0 | Passthrough | | — |
| F1 | Un polo / EMA (igual a `vbt.ts`) | `apply_onepole` | fc ∈ {3, 5, 8, 10, 15} Hz |
| F2 | Butterworth LP 2º orden | `apply_butter_lp(order=2)` | fc ∈ {3, 4, 5, 6, 8, 10, 12, 15} |
| F3 | Butterworth LP 4º orden | `apply_butter_lp(order=4)` | ídem |
| F4 | Butterworth fase cero (referencia) | `apply_butter_lp_zerophase` | ídem, orden 2 y 4 |
| F5 | Savitzky–Golay | `apply_savgol` | ventana ∈ {7, 11, 21}, orden ∈ {2, 3} |
| F6 | Media móvil | `apply_sma` | ventana ∈ {3, 5, 9} |
| F7 | Mediana | `apply_median` | kernel ∈ {3, 5} (y mediana 3 + F2) |
| F8 | Butterworth HP sobre `a_vert` | `apply_butter_hp` | fc ∈ {0,1, 0,3, 0,5} |
| F9 | Notch | `apply_notch` | solo si la PSD de F2 muestra un pico aislado; si no, "no aplica" |
| **Orientación** (`imu.OrientationTracker`) ||||
| O0 | Snapshot fijo (`project_vertical`) | `dsp.project_vertical` | — |
| O1 | Solo giro | `estimator="O1"` | — |
| O2 | Solo acelerómetro | `"O2"` | — |
| O3 | Complementario (Mahony con Ki = 0) | `"O3"` | Kp ∈ {0,5, 1, 2, 5}; rechazo on/off; tol_ang ∈ {5, 10, 20}° |
| O4 | Mahony | `"O4"` | Kp ∈ {0,5, 1, 2, 5}; Ki ∈ {0,02, 0,05, 0,1}; rechazo; tol_ang |
| O5 | Madgwick IMU | `"O5"` | β ∈ {0,01, 0,033, 0,1, 0,2}; rechazo; tol_ang |
| O6 | Anclas entre reposos (referencia no causal) | `imu.integrate_between_rest_anchors` | — (necesita ≥ 2 reposos) |
| **Gravedad** ||||
| G1 / G2 | `a·ĝ₀ − |g|` / `a·ĝ(t) − |g|` | `project_vertical` / `imu.vertical_world` | — |
| G3 | Fuga de gravedad G1 − G2 | derivado | se reporta, no se elige |
| G5 | Brazo de palanca | `imu.lever_arm_correction` | **no evaluable** sin `r` medido; reportar `lever_arm_rms` con r = (0, 0, 0,03) m como orden de magnitud |
| **Integración y deriva** ||||
| I1 | Trapecio | `dsp.integrate_velocity` | — (siempre) |
| I2 | Detrend lineal (ventana entera o por rep) | `dsp.detrend_linear` | — |
| I3 | HP Butterworth sobre `v` | `apply_butter_hp` | fc ∈ {0,1, 0,3, 0,5}, orden 1–2 |
| I4 | Detrend por segmentos entre reposos | `dsp.detrend_segments` | — |
| **Detección de reposo + ZUPT** ||||
| Z1 | RMS de `a_vert` filtrada ≤ umbral | `dsp.rolling_rms_rest_mask` | umbral ∈ {0,1, 0,15, 0,25}; ventana ∈ {200, 300, 500} ms |
| Z2 | ARE (giro) | `imu.are` + `rest_mask_from_statistic` | factor ∈ {2, 3, 5} o γ absoluto (§9 trampa 4) |
| Z3 | SHOE (acelerómetro + giro) | `imu.shoe` | ídem |
| ZUPT | Clamp `v = 0` si reposo y \|v\| < v_max | `dsp.apply_zupt_mask` | v_max ∈ {0,1, 0,3, ∞} |
| **Pipelines de referencia** ||||
| B0 | Pipeline móvil (`vbt.ts`) | reconstruido con funciones de `dsp` (§5, F6) | — |
| B1 | Default de desktop | ídem | — |

### 3.2 Algoritmos adicionales investigados (se implementan y prueban)

Tier 1 = obligatorio. Tier 2 = hacelo si Tier 1 está terminado. Pseudocódigo en el Apéndice A.

| ID | Algoritmo | Familia | Tier | Causalidad | Implementación | Por qué está en la lista |
|---|---|---|---|---|---|---|
| **N1** | **VQF** (Laidig & Seel, 2023): orientación 6D con estimación de bias del giro **en reposo y en movimiento** | Orientación | 1 | per-sample (`VQF`) / offline (`offlineVQF`) | `pip install vqf` | Estado del arte en orientación 6D y el único que estima bias **en movimiento**: justo lo que esta captura sin reposos necesita. C++ con licencia MIT, portable al ESP32 |
| **N2** | **EKF de orientación** (`ahrs.filters.EKF`) | Orientación | 1 | per-sample | `ahrs` | La respuesta "de libro" que `PLAN-V2.md §10` rechazó sin medirla. Acá se mide |
| **N3** | **Fusion AHRS de x-io** (rechazo de aceleración + recuperación + offset de giro en reposo) | Orientación | 2 | per-sample | `imufusion` (opcional) | Diseño de referencia del rechazo que ya copia `imu.py`; compara la versión "original" contra la nuestra |
| **N4** | **Kalman 1-D `[v, b]` con ZUPT** (bias de acelerómetro como estado; medición de pseudo-velocidad `v = 0` en reposo) | Integración/deriva | 1 | per-sample | a mano, ~40 líneas | Reemplazo causal y continuo de ZUPT-clamp + detrend: estima el bias en línea y no deja escalones en `v` |
| **N5** | **N4 + suavizador RTS** (Rauch–Tung–Striebel) por rep | Integración/deriva | 1 | per-rep-buffer | a mano, ~30 líneas más | Versión óptima (en sentido de mínimos cuadrados) del detrend por segmentos; lo usan los sistemas ZUPT-INS (OpenShoe, gaitmap `RtsKalman`) |
| **N6** | **Integración directa-inversa** (forward–backward con peso sigmoide, Zok et al.) | Integración/deriva | 1 | per-rep-buffer | a mano, ~15 líneas | Cumple `v = 0` en ambos extremos sin asumir que el bias es constante (el detrend lineal sí lo asume) |
| **N7** | **Detrend lineal a tramos con ajuste dentro de cada reposo** (gaitmap `PieceWiseLinearDedriftedIntegration`) | Integración/deriva | 2 | per-rep-buffer | a mano, ~20 líneas | Variante de I4 que también corrige la deriva **durante** el reposo |
| **N8** | **Detrend cuadrático con restricción de desplazamiento** (`v(t_a) = v(t_b) = 0` **y** `s(t_b) = s(t_a)`) | Integración/deriva | 1 | per-rep-buffer | a mano, sistema 2×2 | Es el "upgrade" que el propio `vbt.ts:180-183` deja anotado. La barra vuelve a la altura inicial, y esa segunda restricción permite estimar un bias que varía linealmente |
| **N9** | **Integración en frecuencia** ("omega arithmetic": `V(f) = A(f)/(j2πf)` con corte de baja frecuencia) | Integración/deriva | 2 | offline | `numpy.fft`, ~15 líneas | Método estándar en vibraciones; sirve como referencia offline |
| **N10** | **Integrador con fuga** `v_k = λ·v_{k−1} + ∫a` con `λ = e^(−dt/τ)` | Integración/deriva | 1 | per-sample | 1 línea | La alternativa causal más barata al detrend; es un HP de 1er orden integrado en el propio integrador |
| **N11** | **Gravedad por pasa-bajos del acelerómetro** (sin giro; estilo `TYPE_LINEAR_ACCELERATION`) | Gravedad | 1 | per-sample | `apply_butter_lp` a 0,2–0,5 Hz por eje | Cota inferior "sin giro, pero dinámica". Hay que mostrar por qué no alcanza |
| **N12** | **ESKF de 15 estados + ZUPT (+RTS)** (INS completo estilo OpenShoe) | INS | 2 | per-sample / per-rep | a mano, o `gaitmap` en un venv aparte | La solución "máxima". Si N1+N4/N5 quedan cerca, no justifica su complejidad |

### 3.3 Investigados pero solo evaluados en forma teórica (no se implementan)

Cada uno necesita, en el informe, un párrafo con la razón concreta **y** la condición que haría
falta para reabrirlo:

| ID | Algoritmo | Razón para no implementarlo acá |
|---|---|---|
| T1 | Regresión con ML (CNN/LSTM de IMU → velocidad) | No hay datos etiquetados; no hay camino razonable de despliegue en el ESP32 sin un dataset de miles de reps con referencia |
| T2 | Invariant EKF | Misma clase que N12; si N12 no se justifica, este tampoco |
| T3 | Fusión con barómetro / magnetómetro | El hardware no lo tiene (MPU6050 = 6 ejes) |
| T4 | Denoising con wavelets | Ya rechazado en `PLAN.md §5.2`; el error dominante es el bias, no el ruido de banda ancha |
| T5 | Reglas de integración de mayor orden (Simpson, Boole) | Hacé **una** comparación rápida trapecio vs Simpson en F5; si la diferencia de MCV es < 0,005 m/s, cerrá el tema con ese número |
| T6 | Calibración de 6 posiciones (escala + offset por eje) | Es un procedimiento de calibración, no un algoritmo de stream; se recomienda en el informe como mejora de exactitud absoluta (el ~5 % de §1.2) |
| T7 | Detectores de reposo aprendidos | Ya rechazado en `PLAN-V2.md §10` |

---

## 4. Metodología de evaluación

### 4.1 Por qué hace falta un banco semisintético

La captura real **no tiene verdad de terreno** (nadie midió la velocidad real con un transductor
lineal o una cámara), **no tiene reposos intermedios** y **no tiene variación térmica**. Con eso
solo se puede medir plausibilidad, no exactitud. Por eso:

- **Métrica primaria = banco semisintético** (§4.2): trayectorias verticales conocidas,
  orientación conocida, y ruido, bias, escala, DLPF y cuantización del MPU6050, calibrados para
  parecerse a la captura real.
- **Métrica secundaria = captura real** (§4.3.2): chequeos de plausibilidad y robustez que
  confirman o desempatan.

### 4.2 Generador semisintético (`analysis/synth.py`)

Todo en el marco del mundo con Z hacia arriba. Generá a **1000 Hz**, filtrá y decimá a 100 Hz.

**4.2.1 Trayectoria vertical.** Cada fase es un perfil de mínimo jerk entre dos alturas:

```
s(τ) = s0 + D·(10τ³ − 15τ⁴ + 6τ⁵),   τ = (t − t0)/T ∈ [0, 1]
v(τ) = (D/T)·(30τ² − 60τ³ + 30τ⁴)
a(τ) = (D/T²)·(60τ − 180τ² + 120τ³)
```

Una rep = reposo `R1` → excéntrica (baja `ROM` en `T_ecc`) → pausa `P` → concéntrica (sube `ROM`
en `T_con`) → reposo `R2`. Guardá por muestra: `s_true`, `v_true`, `a_true`, `rest_true` (bool) y
los límites de cada fase (`rep_windows`).

Horizontal: balanceo `x(t) = A_x·sin(2πt/T_rep)` con `A_x` = 0,02 m (genera aceleración horizontal
para probar el rechazo de aceleración).

**4.2.2 Orientación.** Ángulos de Euler analíticos (ZYX):

```
roll(t)  = θ_r · sin(2π f_rot t + φ_r)
pitch(t) = θ_p · sin(2π f_rot t + φ_p)
yaw(t)   = ω_yaw · t                       # deriva lenta, inobservable
q(t) = q_z(yaw) ⊗ q_y(pitch) ⊗ q_x(roll)   # usá imu.quat_mul
```

`q_x(α) = [cos(α/2), sin(α/2), 0, 0]` y análogos para y, z.

Velocidad angular del cuerpo, derivada numéricamente a 1 kHz (así es consistente con la
integración de `imu.quat_integrate` por construcción):

```
dq = quat_mul(quat_conj(q_k), q_{k+1});  si dq[0] < 0: dq = −dq
ω_body_k = 2·dq[1:4] / dt
```

**4.2.3 Lectura del sensor ideal**:

```
f_world = a_true_world + [0, 0, g]                     # fuerza específica, g = 9.80665
f_body  = rotate_body_to_world(quat_conj(q), f_world)  # mundo -> cuerpo
```

**4.2.4 Modelo de error del MPU6050** (en este orden):

1. DLPF on-chip: `butter(2, 21 Hz)` causal a 1 kHz sobre los 6 ejes.
2. Decimá a 100 Hz (una muestra de cada 10).
3. Escala: `f_body *= (1 + e_s)` por eje, con `e_s ~ U(−0,06, −0,02)` (el |g| real mide −4,8 %).
4. Bias de acelerómetro: `b_a ~ U(−0,3, 0,3)` m/s² por eje. Bias de giro: `b_g ~ U(−5, 5)` °/s
   por eje (la tolerancia de ZRO del datasheet es ±20 °/s; esto es sin calibrar).
5. Ruido blanco: `σ_a = 0,04` m/s², `σ_g = 0,06` °/s (valores de partida). **Recalibralos** con
   la captura real: `σ` = desvío de `x − butter_lp_zerophase(x, 15 Hz)` por eje, promediado. Usá
   el mayor entre ambos.
6. Cuantización: accel `9.80665/4096` m/s² (±8 g); giro `1/65.5` °/s (±500 °/s).

**4.2.5 Escenarios** (cada uno con 20 semillas; la semilla sortea los bias, la escala, el ruido y
las fases `φ`):

| Escenario | Descripción | Parámetros |
|---|---|---|
| **S1** gimnasio ideal | 5 reps, reposos de 2 s, 2 s de reposo inicial | ROM 0,5 m; T_ecc 1,2 s; T_con 0,6–1,2 s (MCV ~0,4–0,9 m/s); θ_r = θ_p = 3°; f_rot = 1/T_rep |
| **S2** imita la captura real | 4 ciclos continuos **sin reposos** entre ellos; 1 s de reposo solo al final (sin reposo inicial) | Período 3,3 s; ROM inicial 0,6 m; θ 15°. **Ajustá** ROM y θ hasta que los percentiles 1/50/99 de `|a|` y 50/99 de `|ω|` queden a ±15 % de §1.2 |
| **S3** reps lentas | 3 reps con reposos de 2 s | MCV 0,15–0,30 m/s (T_con 1,7–3,3 s); θ 3° |
| **S4** mucha inclinación | Como S1 | θ_p = 25°, θ_r = 10° (sensor en la punta de la barra, que cabecea) |
| **S5** rápidas | Como S1 | MCV 1,0–1,3 m/s, pico ~1,8 m/s |

Partición anti-sobreajuste: **los parámetros de cada algoritmo se eligen en S1 + S2 ("train")**
y se reportan en S3 + S4 + S5 ("hold-out") sin re-tunear. El informe muestra ambas.

**4.2.6 Validación del generador** (F1): superponé PSD, histogramas de `|a|` y `|ω|` de S2
contra la captura real (`out/f1_synth_vs_real.png`). Si los percentiles no quedan dentro de
±15 %, ajustá S2 y repetí. Sin este chequeo, el banco no representa el problema.

### 4.3 Métricas

#### 4.3.1 Semisintéticas (primarias)

Los límites de fase salen de la verdad (`rep_windows`), así la detección de reps no contamina la
medición del algoritmo de velocidad.

| Métrica | Definición |
|---|---|
| **MCV err** | `mean(v_est[con]) − mean(v_true[con])` en la fase concéntrica. **La métrica VBT principal** |
| **PCV err** | `max(v_est[con]) − max(v_true[con])` |
| MEV err | Igual que MCV, en la fase excéntrica |
| RMSE_mov | RMSE de `v_est − v_true` sobre las muestras en movimiento |
| v_rest | `mean(|v_est|)` sobre las muestras de reposo verdadero (deriva residual) |
| ROM err | `(max − min)` de `cumtrapz(v_est)` en la rep vs la verdad |
| Tilt err (solo orientación) | ángulo entre `gravity_body(q_est)` y `gravity_body(q_true)`, RMS y máximo, en grados |

Agregados por algoritmo y escenario, sobre todas las reps y semillas: **MAE, sesgo (media), LoA
95 % (sesgo ± 1,96·SD) y % de reps con |MCV err| < 0,05 m/s**.

Umbrales de trabajo para calificar el MCV: MAE ≤ 0,05 m/s **excelente**; ≤ 0,10 **aceptable**;
> 0,10 **no apto**. Referencia de la literatura a mejorar: una IMU de bajo costo en peso muerto
reporta RMSE ≈ 0,16 m/s en velocidad media y subestima el pico hasta −0,19 m/s (ver Fuentes).

#### 4.3.2 Captura real (secundarias)

| Métrica | Definición | Cuándo no aplica |
|---|---|---|
| R1 v_tail | `mean(|v|)` en t ≥ 17,00 s (el único reposo) | Métodos que **fuerzan** `v(fin) = 0` (I2, I4, N5, N6, N8): marcar "N/A — forzado" |
| R2 dist_ref | RMSE de `v` contra la referencia no causal REF_real (definida en F7) | La propia referencia |
| R3 cierre de ciclo | Tomá los mínimos locales de `s = cumtrapz(v)` (uno por ciclo; debería haber ~4). Ajustá una recta a `s` en esos puntos: **pendiente en m/s** (deriva de altura; ideal 0) y **CV del ROM por ciclo** | Si no se identifican ≥ 3 ciclos, reportarlo |
| R4 fuga G3 | RMS de `a_vert(O0) − a_vert(pipeline)` y su integral al final | Pipelines que usan O0 |
| R5 sensibilidad a la calibración | Rango (máx − mín) del pico de velocidad por ciclo al cambiar CAL-A..D (§4.4) | — |
| R6 plausibilidad | `|v|max < 3` m/s; ROM por ciclo entre 0,1 y 1,5 m | — |

### 4.4 Estrategias de calibración para la captura real

`dsp.calibrate` rechaza todas las ventanas (§1.2). Construí `dsp.Calibration(...)` a mano con
cada estrategia y corré **todos** los pipelines con las cuatro:

| ID | Vector de gravedad y \|g\| | Bias de giro | σ_a, σ_g (para SHOE/ARE) |
|---|---|---|---|
| **CAL-A** (primaria) | `mean(acc)` sobre toda la captura. Justificación: si la velocidad inicial y final coinciden, el promedio temporal de la fuerza específica es `g` | `mean(gyr)` sobre toda la captura. Solo es válido si la orientación final ≈ la inicial: verificalo comparando `tilt_quat` de los primeros 0,3 s y de los últimos 0,09 s, y reportá el ángulo | Desvío del residuo de alta frecuencia (§4.2.4 punto 5) |
| CAL-B | Media de las últimas 9 muestras (t ≥ 17,00 s) | Media de las mismas 9 muestras | Ídem |
| CAL-C | Ventana de 1 s más quieta (arranque en t ≈ 15,61 s), guardas ignoradas | Media de esa ventana | Ídem |
| CAL-D | `tilt_quat(mean(primeros 0,5 s))` como `q0` (regla de `PLAN-V2.md §5.2`); \|g\| = mediana de `|a|` | **0** (queda a cargo del estimador: Ki de Mahony, VQF) | Ídem |

Reportá en `out/f0_calibrations.json` los vectores, |g|, bias y ángulos de cada una.

En sintético: S1, S3, S4 y S5 tienen reposo inicial, así que **C1 corre normal**. S2 no lo tiene,
así que usá CAL-A / CAL-D igual que en la captura real.

---

## 5. Fases de ejecución

Cada fase termina con un **criterio de terminado** verificable. No avances si no se cumple.

### F0 — Auditoría de la captura (`f0_audit.py`)

1. Cargá el CSV con `from app import _load_csv` (funciona sin display; si falla por PySide6,
   copiá la función `_load_csv` de `app.py:200-225` a `common.py`). Pasalo por `dsp.to_grid`.
2. Reproducí cada fila de la tabla de §1.2 e imprimila.
3. Graficá `ax, ay, az, |a|, gx, gy, gz, |ω|, temp_c` vs t (`out/f0_raw.png`) y describí en 3–5
   líneas qué gesto parece ser y cuántos ciclos ves.
4. Calculá CAL-A..D (§4.4) → `out/f0_calibrations.json`.
5. Corré las **pruebas de conformidad** de §9 (trampas 2 y 3) y guardá el resultado en
   `out/f0_findings.md`.

**Terminado cuando:** los números de §1.2 coinciden (o documentaste la diferencia),
`f0_calibrations.json` existe con las 4 estrategias, y `f0_findings.md` tiene el resultado de las
dos pruebas de conformidad.

### F1 — Candidatos nuevos + generador (`candidates.py`, `synth.py`, `test_candidates.py`, `f1_synth_validate.py`)

1. Implementá N4, N5, N6, N8, N10 y N11 según el Apéndice A (y N7 y N9 si llegás; N1, N2 y N3 son
   wrappers). Wrappers:
   - **N1 VQF**: `VQF(1/fs).updateBatch(np.ascontiguousarray(gyr), np.ascontiguousarray(acc))["quat6D"]`.
     Variante offline: `offlineVQF(gyr, acc, None, 1/fs)["quat6D"]` (confirmá la firma exacta con
     `help(offlineVQF)`). Unidades: rad/s y m/s².
   - **N2 EKF**: `ahrs.filters.EKF(gyr=gyr, acc=acc, frequency=fs, frame="ENU").Q`.
   - **N3 Fusion**: la API cambió entre versiones; seguí el ejemplo de
     `Examples/Python/` del repo de Fusion **para la versión instalada**. Espera el giro en
     **°/s** y la aceleración en **g**.
2. **Chequeo de convención obligatorio para N1/N2/N3** (§9 trampa 5): con reposo inclinado 20°
   sintético, `imu.gravity_body(q)` tiene que coincidir con `acc/|acc|` (error < 1°). Si da el
   vector espejado, aplicá `quat_conj` y documentalo.
3. `test_candidates.py` (asserts planos, `python analysis/test_candidates.py`):
   - N4 con ruido 0 y sin reposos ≡ `dsp.integrate_velocity` (`np.allclose`).
   - N4 con bias constante de 0,2 m/s² y reposos cada 3 s: `|v|` en reposo < 0,02 m/s y bias
     estimado dentro del 10 %.
   - N5 ≈ I4 (`dsp.detrend_segments`) con bias constante (RMSE < 0,01 m/s).
   - N6 y N8: sobre un perfil de mínimo jerk con bias constante, recuperan `v_true` (RMSE < 0,01).
     N8 con un bias en rampa: RMSE menor que I2 (assert de la desigualdad).
   - N10 con τ → ∞ ≡ I1.
   - Generador: con error 0 (sin ruido, sin bias, sin escala, sin DLPF), el pipeline
     `O*_oracle + F0 + I1` recupera `v_true` (RMSE < 1e-3). **Este es el test que atrapa errores de
     signo y de convención del generador.**
4. `f1_synth_validate.py`: §4.2.6 → `out/f1_synth_vs_real.png` y `out/f1_synth_stats.csv`.

**Terminado cuando:** `test_candidates.py` pasa entero y S2 queda dentro de ±15 % de la captura
real en los percentiles pedidos.

### F2 — Filtro sobre `a_vert` (`f2_filters.py`)

Aislá el filtro: usá **orientación verdadera** (`_oracle`) y **deriva I4 con reposos verdaderos**
(`_oracle`), así el único factor que varía es el filtro.

1. Captura real (con CAL-A + O4 por default): PSD de Welch de `a_vert` (`dsp.psd`) y el corte
   recomendado por Winter (`dsp.winter_residual_analysis`) → `out/f2_psd_winter.png`, `fc_winter`
   en `out/f2_summary.json`.
2. En sintético (S1 + S2), barré F0–F8 con los parámetros de §3.1. Métricas: MCV/PCV MAE,
   RMSE_mov y retardo de grupo (`dsp.group_delay_ms` sobre `dsp.design_lowpass_sos`; para
   F1/F6/F7 usá las fórmulas de `dsp._render_*_c`).
3. Tabla `out/f2_filters.csv` (una fila por filtro × parámetro) y gráfico MCV MAE vs retardo
   (`out/f2_tradeoff.png`).
4. Elegí los **2 mejores filtros causales** (per-sample, exportables), con este criterio: el menor
   PCV MAE entre los que tienen MCV MAE ≤ 1,1 × el mínimo, y retardo ≤ 50 ms.

**Terminado cuando:** hay 2 filtros finalistas con sus parámetros, justificados con filas de
`f2_filters.csv`.

### F3 — Orientación (`f3_orientation.py`)

Fijá el mejor filtro de F2 y la deriva I4 `_oracle`. Variá solo el estimador.

1. Candidatos: O0, O1, O2, O3, O4, O5, O6 (referencia), N1 (online y offline), N2, N3, N11. Cada
   uno con y sin rechazo de aceleración donde aplique, y O3/O4 con y sin C4 (**con el signo
   corregido**, §9 trampa 2).
2. Barrido de parámetros solo en S1 + S2 (§3.1); guardá el mejor por estimador y reportalo en S3–S5.
3. Métricas: tilt err (RMS/máx), RMSE de `a_vert` contra `a_vert` verdadera, MCV/PCV MAE, y en la
   captura real R4 (fuga).
4. Salidas: `out/f3_orientation.csv`, `out/f3_tilt_S2.png` (tilt err vs t de cada estimador en
   una semilla de S2) y `out/f3_real_theta.png` (θ(t) en la captura real con cada estimador).
5. Elegí **2 finalistas causales**.

**Terminado cuando:** hay 2 estimadores finalistas y el CSV muestra train vs hold-out.

### F4 — Detección de reposo (`f4_rest.py`)

1. Sintético: Z1, Z2 y Z3 con barrido de umbrales (§3.1), además del detector de reposo interno de
   N1 (VQF expone su estado de reposo; ver `help(VQF)`, flag `restDetected`). Métricas por muestra
   contra `rest_true`: **precisión, recall, F1** y error de borde (ms). Reportá S3 (reps lentas)
   por separado: es el caso que `PLAN-V2.md §9.3` predice difícil.
2. Captura real: cuántos intervalos de reposo ≥ 0,3 s detecta cada uno y dónde. Esperable: ~1 (el
   final). Si un detector marca "reposo" en medio del movimiento, es un falso positivo: reportalo.
3. Salidas: `out/f4_rest.csv`, `out/f4_rest_real.png`.
4. Elegí **el detector finalista** (el mayor F1 en S1 + S2, con precisión ≥ 0,95: un falso reposo
   a mitad de rep es mucho peor que un reposo no detectado).

**Terminado cuando:** hay un detector elegido con umbral fijo, y está documentado cómo se
comporta en S3.

### F5 — Integración y control de deriva (`f5_drift.py`)

Fijá el filtro de F2 y la orientación `_oracle`. Variá solo la integración/deriva, con el
detector de F4 (y una variante `_oracle` con reposos verdaderos para ver el techo).

1. Candidatos: I1 solo; I1 + I2 (ventana entera); I1 + I2 por rep; I1 + I3 (fc barrida); N10
   (τ ∈ {1, 2, 5} s); I4; ZUPT-clamp con v_max barrido; N4; N5; N6; N7; N8; N9; y trapecio vs
   Simpson (T5).
2. Métricas: todas las de §4.3.1. Separá por escenario, porque **S2 (sin reposos) es el que
   discrimina**.
3. Salidas: `out/f5_drift.csv`, `out/f5_v_S1.png` y `out/f5_v_S2.png` (v_true vs los 6 mejores en
   una semilla).
4. Elegí **2 finalistas**: uno `per-sample` (lo que puede ir en el stream en vivo) y uno
   `per-rep-buffer` (lo que refina la rep al cerrarla). La arquitectura final puede usar ambos.

**Terminado cuando:** hay un finalista per-sample y uno per-rep-buffer, con números de S2 y S3.

### F6 — Pipelines de punta a punta (`f6_end_to_end.py`)

1. Armá como máximo ~20 pipelines combinando los finalistas de F2–F5 (**sin** `_oracle`), más:
   - **B0 (móvil)**: `project_vertical` + `apply_onepole(fc=10)` + `integrate_velocity` +
     `apply_zupt` (Z1: 300 ms, 0,15 m/s², v_max 0,3) para el stream; y por rep (ventanas desde el
     inicio de la excéntrica hasta el fin de la concéntrica), re-integrar desde `v = 0` +
     `detrend_linear`, igual que `closeRep` en `vbt.ts:526-531`.
   - **B1 (desktop)**: O0 + F2 (6 Hz) + I1 + I2 sobre la ventana entera.
   - **REF**: el mejor pipeline `offline` (el techo alcanzable sin restricción de causalidad).
2. Corré S1–S5 × 20 semillas. Métricas de §4.3.1, más el tiempo de CPU en Python por muestra
   (solo como indicador relativo).
3. Salidas: `out/f6_end_to_end.csv` (una fila por pipeline × escenario, con MAE/sesgo/LoA/%<0,05),
   `out/f6_bland_altman_<top3>.png` y `out/f6_ranking.md` (ranking por la regla de §6).

**Terminado cuando:** existe el ranking, y B0 y B1 aparecen en él.

### F7 — Captura real (`f7_real_capture.py`)

1. Definí **REF_real** = el pipeline REF de F6 con CAL-A.
2. Corré los ~20 pipelines de F6 con CAL-A, CAL-B, CAL-C y CAL-D. Métricas R1–R6.
3. Salidas: `out/f7_real.csv`, `out/f7_v_real.png` (v(t) de los top 5 + B0 + B1 + REF_real, con
   CAL-A), `out/f7_s_real.png` (desplazamiento, para ver el cierre de ciclo) y
   `out/f7_cal_sensitivity.png`.
4. Si la captura real **contradice** el ranking de F6 (por ejemplo, el ganador sintético da un
   desplazamiento que diverge), reportalo y explicá la causa probable. No re-rankees a mano.

**Terminado cuando:** están las 3 figuras y el CSV, y el texto de interpretación está en
`out/f7_notes.md`.

### F8 — Factibilidad en firmware (`f8_firmware_cost.py`)

Para los **top 3** de F6:

1. **Costo por muestra**: contá flops y `sqrtf` leyendo el código (tomá como referencia las
   cuentas ya documentadas en los exportadores de `dsp.py`: Mahony ~55 flops + 2 sqrt, Madgwick
   ~100 flops + 2 sqrt, biquad 5 mul + 4 add). Para VQF, estimalo leyendo `vqf.cpp` (su C++ es la
   fuente). El presupuesto del ESP32-S3 a 100 Hz es de ~2,4 M ciclos por muestra, así que el costo
   casi seguro **no** decide: reportalo igual.
2. **RAM**: estado persistente + buffer por rep (floats × 4 bytes).
3. **Latencia**: retardo de grupo del filtro + el del DLPF (8,5 ms).
4. **Precisión float32**: re-corré el top 1 con todo en `np.float32` (arrays y escalares) sobre
   S1 y S2. La diferencia de MCV contra float64 tiene que ser < 0,002 m/s.
5. **Camino a C**: ¿ya existe exportador (E1/E2/E3 en `dsp.py`)? ¿Hay C/C++ de referencia con
   licencia compatible (VQF: MIT)? ¿Hay que escribirlo a mano (N4/N5: ~40 líneas)?
6. **Qué va al paquete BLE**: proponé los campos nuevos (por ejemplo `a_vert`, `v_vert`,
   `rest_flag`, `bias_est`) y su tamaño, sin romper el despacho por versión (magic y versión en
   los bytes 0–1).

Salida: `out/f8_firmware.md` con una tabla por candidato.

**Terminado cuando:** los 3 candidatos tienen costo, RAM, latencia, resultado de float32 y camino
a C.

### F9 — Decisión

Aplicá la regla de §6 **mecánicamente** sobre `f6_end_to_end.csv` + `f7_real.csv` + `f8_firmware.md`.
Escribí el resultado en `out/f9_decision.md`: el ganador, el segundo, y el margen entre ambos.

### F10 — Informe (`INFORME.md`)

Seguí la plantilla de §7 al pie de la letra.

---

## 6. Regla de decisión

### 6.1 Restricciones duras (si no se cumplen, el candidato queda descartado)

1. La parte que va al stream en vivo es `per-sample`. La parte que refina cada rep es, como
   máximo, `per-rep-buffer` (≤ 8 s × 100 Hz = 800 floats por señal).
2. Latencia total (DLPF + filtro) ≤ 50 ms.
3. RAM ≤ 16 KB para el algoritmo completo.
4. Existe un camino a C sin dependencias externas (o con código MIT/BSD vendorizable).
5. La diferencia float32 vs float64 en MCV es < 0,002 m/s.
6. No usa ningún componente `_oracle`.

### 6.2 Puntaje (entre los que pasan las restricciones duras)

| Peso | Criterio | Fuente |
|---|---|---|
| 40 % | MCV MAE promedio en hold-out (S3 + S4 + S5) | `f6_end_to_end.csv` |
| 15 % | MCV MAE en el peor escenario (incluido S2) | ídem |
| 15 % | PCV MAE promedio en hold-out | ídem |
| 10 % | Robustez en la captura real: R3 (pendiente de cierre) + R5 (sensibilidad a la calibración) | `f7_real.csv` |
| 10 % | Simplicidad: cantidad de parámetros a tunear + líneas de C estimadas | `f8_firmware.md` |
| 10 % | Costo: flops + RAM | `f8_firmware.md` |

Normalizá cada criterio entre 0 (el peor candidato) y 1 (el mejor), y ponderá. **Desempate**: si
dos candidatos quedan a menos de 0,05 de puntaje, o su diferencia de MCV MAE es menor que 0,01 m/s,
gana **el más simple** (misma filosofía que el resto del repo).

---

## 7. Plantilla del informe (`analysis/INFORME.md`)

```markdown
# Informe — Algoritmo aceleración → velocidad para el firmware VBT

## 1. Resumen ejecutivo (≤ 15 líneas)
- Algoritmo elegido (cadena completa) y en qué parte corre (firmware per-sample / firmware por rep / cliente).
- MCV MAE y PCV MAE del elegido vs B0 (móvil actual) vs B1 (desktop actual) vs REF (techo offline).
- Qué cambia en el paquete BLE.
- Las 3 limitaciones más importantes del análisis.

## 2. Datos y método
- Captura real: lo que se observó en F0 (gesto, ciclos, falta de reposo, T constante, LATE al 100 %).
- Banco semisintético: escenarios, cómo se calibró contra la captura real (figura f1).
- Métricas y regla de decisión (resumen de §4.3 y §6 del plan).

## 3. Resultados por etapa
### 3.1 Filtro (F2)     — tabla corta + figura de trade-off + finalistas
### 3.2 Orientación (F3) — tabla + figura de tilt + finalistas
### 3.3 Reposo (F4)      — tabla + comportamiento en reps lentas
### 3.4 Deriva (F5)      — tabla por escenario (S2 destacado)
### 3.5 Punta a punta (F6) — ranking + Bland-Altman del top 3
### 3.6 Captura real (F7) — figuras de v y s + sensibilidad a la calibración
### 3.7 Firmware (F8)    — tabla de costo/latencia/RAM/float32

## 4. Catálogo: veredicto por algoritmo
Una ficha por CADA algoritmo de §3.1, §3.2 y §3.3 del plan, con este formato exacto:

### <ID> — <nombre>
- **Qué hace:** 1–3 líneas.
- **Causalidad / costo:** per-sample | per-rep-buffer | offline; flops y RAM aproximados.
- **Resultado:** MCV MAE (hold-out), PCV MAE, peor escenario; o "no evaluado — <razón>".
- **Veredicto:** Elegido | Finalista | Descartado | No evaluable.
- **Por qué no sirve para esta aplicación** (o por qué sí): una razón concreta con un número y la
  ruta del archivo de out/ que lo respalda. Prohibido "no rinde bien" sin número.
- **Qué haría falta para reconsiderarlo:** una condición verificable.

## 5. Decisión y justificación
- Tabla de puntaje de §6.2 con los finalistas.
- Por qué el elegido gana (margen, en qué escenarios, a qué costo).
- Diagrama de la cadena elegida, marcando qué corre en el firmware antes del BLE y qué en el cliente.
- Parámetros finales (fc, Kp/Ki o los de VQF, umbrales, τ, Q/R del Kalman) listos para portar a C.

## 6. Hallazgos colaterales (bugs y observaciones del código existente)
Incluir como mínimo los resultados de las pruebas de conformidad de §9 (trampas 1, 2 y 3).

## 7. Limitaciones y próximos pasos
- Qué no se pudo validar sin verdad de terreno real.
- Protocolo de captura recomendado (Apéndice B del plan).

## 8. Reproducibilidad
Comandos exactos, versiones de paquetes (`pip freeze` de lo usado) y semillas.
```

---

## 8. Hipótesis (qué forma se espera — **no** es el resultado obligatorio)

1. **O0 pierde mucho en esta captura**: el sensor rota 10–45 °/s de forma sostenida. Con 15° de
   inclinación, la fuga `g(1 − cos θ)` es ~0,33 m/s²; integrada durante un ciclo de 3 s son ~1 m/s
   de error antes del detrend. Esperable: B0 y B1 quedan últimos en S2 y S4.
2. **Entre los estimadores con giro, las diferencias son chicas en S1 y grandes en S2**: sin
   reposos, gana el que estima el bias del giro **en movimiento** (N1 VQF, o O4 con Ki). O3 (sin
   bias) y O5 (Madgwick IMU, sin bias) deberían derivar con los 5 °/s de bias sin calibrar.
3. **El filtro importa poco para el MCV y bastante para el PCV**: la integración ya es un
   pasa-bajos. Esperable: F2 entre 6 y 10 Hz ≈ el mejor causal.
4. **Sin reposos (S2), todo lo que depende de ZUPT se degrada**, y los métodos con restricción de
   ciclo (N8) o de bias como estado (N4/N5) degradan con más gracia.
5. **N4 (Kalman `[v, b]` + ZUPT) ≈ ZUPT-clamp + detrend en S1, pero sin escalones en `v`**; N5
   (RTS) ≈ I4. Si N5 no mejora a I4 en más de 0,01 m/s, gana I4 por simplicidad.
6. **N12 (ESKF 15 estados) no justifica su complejidad** si N1 + N4/N5 queda a menos de 0,01 m/s.
7. Candidato esperado (a confirmar o refutar): **VQF u O4 (per-sample) → Butterworth LP de 2º
   orden → Kalman `[v, b]` con ZUPT en el stream + RTS o N8 al cerrar cada rep.**

---

## 9. Trampas conocidas (leer antes de F0)

1. **`LATE` en el 100 % de las muestras no es pérdida de datos.** En `firmware/src/main.cpp`
   `loop()`, la muestra se dispara cuando `now − lastSampleTime ≥ SAMPLE_INTERVAL_US`, pero se
   estampa con `scheduledUs = lastSampleTime` (el slot **cuyo intervalo acaba de terminar**). Por
   eso `jitter ≈ 10 ms + ~0,85 ms` y `SCHED_LATE` queda siempre encendido. Es un offset constante
   (dispersión ~40 µs): la grilla uniforme sigue siendo válida. **No descartes muestras por `LATE`.**
   Va al informe como hallazgo: el flag perdió su significado.
2. **Signo de `OrientationTracker.set_gyro_bias` (C4).** `mahony_step` **suma** `st.ix` al giro, y
   el integral aprende `ix ≈ −bias`. Pero `app.py:940` llama `set_gyro_bias(*bias_est)` con
   `bias_est = mean(ω en reposo)`, es decir, el bias con signo positivo: eso **duplica** el error en
   vez de corregirlo. Verificado: con 2 °/s de bias durante 5 s, O1 termina inclinado 20° con
   `+bias` y 0° con `−bias`. **En el análisis, llamá siempre `set_gyro_bias(-bx, -by, -bz)`**.
   Reproducilo en F0 y reportalo como bug.
3. **La guarda de giro de `dsp.calibrate` rechaza sensores quietos.** Compara `|mean(ω)|` (que
   **es** el bias) contra 3 °/s, pero la tolerancia de ZRO del MPU6050 sin calibrar es ±20 °/s.
   Prueba de conformidad en F0: un reposo sintético perfecto con 5 °/s de bias en el giro →
   `dsp.calibrate(...)` devuelve `None`. Si se confirma, es un hallazgo (la guarda debería mirar
   `std(ω)`, no la media).
4. **El umbral relativo de Z2/Z3** (`γ = 3 × mediana(estadístico)`) asume que la captura es
   **mayormente reposo**. En esta captura es mayormente movimiento, así que la mediana es alta y
   el detector va a marcar movimiento lento como "reposo". Probá también γ absoluto derivado de un
   reposo sintético con el ruido calibrado, y reportá ambos.
5. **Convenciones de las librerías externas.** VQF y `ahrs` devuelven `[w, x, y, z]`, pero
   confirmá que es **sensor → tierra** (igual que `imu.py`) con el chequeo de F1, paso 2. Fusion
   (`imufusion`) usa **°/s y g**, no rad/s y m/s². `VQF.updateBatch` exige arrays `float64`
   C-contiguos (`np.ascontiguousarray`).
6. **`OrientationTracker.run_full` no aplica C4.** Si querés C4 en modo batch, procesá por tramos
   con `process_new`, y al terminar cada intervalo de reposo llamá `set_gyro_bias` (con el signo
   corregido) antes de seguir, igual que `app.py:_advance_orientation`, pero sin el bug.
7. **No calibres con `dsp.calibrate` sobre la captura real**: devuelve `None` en todas las
   ventanas. Usá las estrategias de §4.4 construyendo `dsp.Calibration(bias=..., g_mag=...,
   gyro_bias=..., temp_c=nan, sigma_a=..., sigma_g=...)` a mano.
8. **Métricas triviales**: los métodos que imponen `v(fin) = 0` sacan R1 = 0 por construcción.
   Marcalo "N/A — forzado", no lo cuentes como victoria.
9. **Sobreajuste**: si tuneás un parámetro mirando S3–S5 o la captura real, invalidaste el
   hold-out. Tuneá solo en S1 + S2.
10. **Bucles lentos**: los filtros de orientación son bucles escalares en Python (~3 µs por
    muestra). 20 pipelines × 5 escenarios × 20 semillas × ~3000 muestras entra en minutos. Si algo
    tarda > 30 min, reducí a 10 semillas y documentalo; no vectorices los filtros de estado.

---

## 10. Checklist final (el agente marca cada ítem antes de dar el trabajo por terminado)

- [ ] `test_dsp.py` y `test_imu.py` siguen pasando (no tocaste nada existente: `git status` solo
      muestra `clients/desktop/analysis/` y este plan).
- [ ] `analysis/test_candidates.py` pasa.
- [ ] `run_all.py` corre de punta a punta sin intervención y regenera `out/`.
- [ ] S2 validado contra la captura real (±15 %).
- [ ] Cada algoritmo de §3.1, §3.2 y §3.3 tiene su ficha en `INFORME.md §4`.
- [ ] Cada número del informe cita un archivo de `out/`.
- [ ] B0, B1 y REF aparecen en el ranking.
- [ ] Los hallazgos de §9 (trampas 1, 2 y 3) están en `INFORME.md §6` con su resultado.
- [ ] La decisión se tomó con la regla de §6, y el margen está reportado.
- [ ] Parámetros finales listos para portar a C en `INFORME.md §5`.

---

## Apéndice A — Pseudocódigo de los algoritmos nuevos

Todos operan sobre `a` = `a_vert` ya filtrada (m/s²), `dt = 1/fs`, y devuelven `v` (m/s).

### A.1 N4 — Kalman 1-D `[v, b]` con ZUPT (per-sample)

```python
# Estado x = [v, b]  (b = bias residual de a_vert). Entrada u_k = a_k.
F = [[1, -dt], [0, 1]];  B = [dt, 0]
Q = [[(sigma_a*dt)**2, 0], [0, (sigma_b**2)*dt]]   # sigma_a ~ ruido de a_vert; sigma_b ~ 0.005-0.05 m/s²/√s (barrer)
H = [1, 0];  R = sigma_zupt**2                      # sigma_zupt ~ 0.01-0.05 m/s (barrer)
x = [0, 0];  P = diag([0.01, 0.1])
for k in range(N):
    x = F @ x + B * a[k];  P = F @ P @ F.T + Q          # predicción
    if rest[k]:                                         # ZUPT: medición v = 0
        S = H @ P @ H + R;  K = P @ H / S
        x = x + K * (0 - H @ x);  P = (I - outer(K, H)) @ P
    v[k] = x[0]
# Guardá x_pred, P_pred, x_filt, P_filt por muestra para N5.
```

Costo: ~20 flops por muestra, 6 floats de estado. Barré `sigma_b` y `sigma_zupt` solo en S1 + S2.

### A.2 N5 — RTS sobre N4 (per-rep-buffer)

```python
xs[N-1], Ps[N-1] = x_filt[N-1], P_filt[N-1]
for k in range(N-2, -1, -1):
    C = P_filt[k] @ F.T @ inv(P_pred[k+1])
    xs[k] = x_filt[k] + C @ (xs[k+1] - x_pred[k+1])
    Ps[k] = P_filt[k] + C @ (Ps[k+1] - P_pred[k+1]) @ C.T
v = xs[:, 0]
```

En firmware se aplica sobre el buffer de la rep, al cerrarla (entre el reposo previo y el
siguiente).

### A.3 N6 — Integración directa-inversa (per-rep-buffer), segmento `[ta, tb]` con `v(ta) = v(tb) = 0`

```python
v_f = cumulative_trapezoid(a, t, initial=0)   # desde v(ta) = 0
v_b = v_f - v_f[-1]                           # = −∫_t^tb a dt: integral inversa desde v(tb) = 0
tau = (t - t[0]) / (t[-1] - t[0])
w = 1 / (1 + np.exp(-(tau - 0.5) / 0.08))     # sigmoide; 0.08 = default de gaitmap (barrer 0.04-0.2)
v = (1 - w) * v_f + w * v_b                   # ≡ v_f − w·v_f[-1]
```

Nota: esto es un detrend cuyo perfil de deriva es una sigmoide en vez de la rampa de I2. Es
exactamente la diferencia que F5 tiene que medir: ¿la deriva real de una rep se parece más a una
rampa (bias constante) o se concentra en el medio?

### A.4 N7 — Detrend lineal a tramos con ajuste dentro de cada reposo

Integrá `v` sobre toda la señal. En cada intervalo de reposo ajustá una recta a `v` (`np.polyfit`,
grado 1) y evaluala dentro del intervalo: ese es el modelo de deriva en los reposos. Fuera de los
reposos, interpolá linealmente el modelo entre el final de un reposo y el comienzo del siguiente.
`v_corr = v − modelo`.

### A.5 N8 — Detrend cuadrático con restricción de desplazamiento (per-rep-buffer)

Modelo de bias `b(t) = c0 + c1·(t − ta)`, con `T = tb − ta` y `τ = t − ta`:

```
error de velocidad:       e_v(τ) = c0·τ + c1·τ²/2
error de desplazamiento:  e_s(τ) = c0·τ²/2 + c1·τ³/6
Condiciones: v_int(T) − e_v(T) = 0   y   s_int(T) − e_s(T) = 0     (la barra vuelve a la altura inicial)
→ [[T, T²/2], [T²/2, T³/6]] · [c0, c1]ᵀ = [v_int(T), s_int(T)]ᵀ
v = v_int − e_v(τ)
```

Solo es válido si el segmento empieza y termina en reposo **a la misma altura** (una rep
completa). Para un segmento que no cumple eso, caé a I2.

### A.6 N9 — Integración en frecuencia (offline)

```python
x = a - a.mean();  n = next_pow2(4 * len(x))
A = np.fft.rfft(x * tukey(len(x), 0.1), n);  f = np.fft.rfftfreq(n, dt)
V = np.zeros_like(A);  m = f >= f_c                       # f_c ∈ {0.2, 0.3, 0.5} Hz
V[m] = A[m] / (2j * np.pi * f[m])
v = np.fft.irfft(V, n)[:len(x)]
```

### A.7 N10 — Integrador con fuga (per-sample)

```python
lam = np.exp(-dt / tau)                                    # tau ∈ {1, 2, 5} s
v[k] = lam * v[k-1] + 0.5 * (a[k] + a[k-1]) * dt
```

### A.8 N11 — Gravedad por pasa-bajos (sin giro)

```python
g_est = np.stack([apply_butter_lp(acc[:, i], fs, fc_g, order=2) for i in range(3)], 1)  # fc_g ∈ {0.2, 0.5} Hz
g_hat = g_est / np.linalg.norm(g_est, axis=1, keepdims=True)
a_vert = np.sum(acc * g_hat, axis=1) - calib.g_mag
```

### A.9 N12 — ESKF 15 estados + ZUPT (Tier 2)

Si lo hacés: estados de error `[δp, δv, δθ, δb_a, δb_g]`, propagación con la mecanización de
`imu.quat_integrate` + `rotate_body_to_world`, y medición ZUPT `v = 0` con el detector de F4.
Referencia de estructura: `gaitmap.trajectory_reconstruction.RtsKalman` y el paper de OpenShoe
(ver Fuentes). Alternativa aceptable: instalar `gaitmap` en un venv **separado**
(`python3 -m venv .venv-gaitmap`) y usar `RtsKalman` como caja negra. Documentá cuál de las dos
hiciste.

---

## Apéndice B — Protocolo de captura para validar la decisión (recomendación del informe, no se ejecuta acá)

La decisión de este plan descansa en un banco sintético. Antes de portar el algoritmo a C, el
informe tiene que recomendar estas capturas:

1. **Reposo de 30 min desde frío**: habilita A4/A5/C6 (térmica, Allan), que hoy no son evaluables.
2. **Desplazamiento conocido**: mover el sensor contra una regla vertical, 0 → 50 cm → 0, con 3 s
   de reposo en cada extremo, 10 veces. Verdad de terreno de ROM (y de MCV si se cronometra con
   video a 240 fps).
3. **Serie de sentadilla con barra real**: 3 s quieto → 5 reps con 2 s de pausa arriba → 3 s
   quieto. Una serie normal y una lenta (< 0,3 m/s).
4. Si hay acceso: la misma serie con un transductor lineal de posición o una cámara, como
   referencia para Bland–Altman real.

---

## Fuentes

- Laidig, D. & Seel, T. — [VQF: Highly Accurate IMU Orientation Estimation with Bias Estimation and Magnetic Disturbance Rejection](https://arxiv.org/abs/2203.17024), Information Fusion 91 (2023). Paquete: [vqf en PyPI](https://pypi.org/project/vqf/), [documentación](https://vqf.readthedocs.io/).
- [AHRS: Attitude and Heading Reference Systems](https://ahrs.readthedocs.io/) — EKF, Madgwick, Mahony en numpy.
- [Fusion (x-io Technologies)](https://github.com/xioTechnologies/Fusion) / [imufusion](https://pypi.org/project/imufusion/) — rechazo de aceleración, recuperación, offset de giro. Ejemplo aplicado: [Gait-Tracking](https://github.com/xioTechnologies/Gait-Tracking).
- Nilsson, Skog, Händel, Hari — [Foot-mounted INS for Everybody — An Open-Source Embedded Implementation (OpenShoe)](https://www.diva-portal.org/smash/get/diva2:548755/FULLTEXT01.pdf), PLANS 2012 — ESKF + ZUPT + detector SHOE.
- [Smoothing for ZUPT-aided INSs](https://exa.ai/library/publication/sbxnzmvgfxp) (Nilsson et al.) — RTS sobre ZUPT-INS, segmentación por paso.
- [gaitmap — RtsKalman](https://github.com/mad-lab-fau/gaitmap/blob/05ad971/gaitmap/trajectory_reconstruction/trajectory_methods/_rts_kalman.py), [ForwardBackwardIntegration](https://gaitmap.readthedocs.io/en/latest/modules/generated/trajectory_reconstruction/gaitmap.trajectory_reconstruction.ForwardBackwardIntegration.html), [PieceWiseLinearDedriftedIntegration](https://github.com/mad-lab-fau/gaitmap/blob/05ad971/packages/gaitmap_mad/src/gaitmap_mad/trajectory_reconstruction/position_methods/_piece_wise_linear_dedrifted_integration.py) — implementaciones de referencia de N5, N6 y N7.
- [Benchmarking Foot Trajectory Estimation Methods for Mobile Gait Analysis](https://exa.ai/library/publication/qjpll7jlmlk) — comparación de integración directa-inversa (Zok et al.), dedrift lineal y métodos de Kalman.
- Skog, Händel, Nilsson, Rantakokko — [Zero-Velocity Detection — An Algorithm Evaluation](https://doi.org/10.1109/TBME.2010.2060723), IEEE TBME 2010 — ARE / SHOE.
- [Vibrationdata — Unit 14: integración en el dominio del tiempo](https://www.vibrationdata.com/Course_Units/UNIT14.pdf) y [Prosig — omega arithmetic](https://blog.prosig.com/tag/omega-arithmetic/) — integración en el tiempo vs en la frecuencia, manejo del DC.
- [Validation of a Low-Cost Inertial Sensor for Estimating Barbell Velocity During Deadlift Concentric Phase](http://biomechanics.iauh.ac.ir/article-1-418-en.pdf) — fusión + ZUPT; velocidad media: sesgo ≈ 0,02 m/s, RMSE ≈ 0,16 m/s; el pico se subestima hasta −0,19 m/s.
- [Valid and Reliable Barbell Velocity Estimation Using an Inertial Measurement Unit](https://www.mdpi.com/1660-4601/18/17/9170) — validación de IMU comercial (VmaxPro) para MCV.
- [Validation of Inertial Sensor to Measure Barbell Kinematics across a Spectrum of Loading Conditions](https://www.mdpi.com/2075-4663/8/7/93) — el acuerdo en el pico empeora con la carga.
- [IMU-velocity-and-displacement-measurements](https://github.com/Wojtek120/IMU-velocity-and-displacement-measurements) — VBT con MPU barato: Madgwick + ZUPT.
- [MPU-6000/MPU-6050 Product Specification](https://invensense.tdk.com/wp-content/uploads/2015/02/MPU-6000-Datasheet1.pdf) — ruido, ZRO, DLPF, sensibilidades.
- Documentos internos: `clients/desktop/PLAN.md`, `clients/desktop/PLAN-V2.md`, `firmware/PLAN.md`, `clients/mobile/src/vbt.ts`.
