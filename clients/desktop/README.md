# VBT Sensor — cliente de escritorio

Osciloscopio de debug para el sensor VBT: conecta por BLE, muestra el stream
crudo, integra a velocidad, calcula estadísticos, y trae un banco de
filtros con las herramientas (PSD, análisis de residuos de Winter) para
elegir cuál implementar en el firmware — y lo exporta como snippet de C.
Ver [PLAN.md](PLAN.md) para el diseño completo del banco de filtros.

Con el paquete v2 (giroscopio + temperatura) también trae fusión de
orientación (Mahony/Madgwick con rechazo de aceleración), detectores de
reposo (ARE/SHOE), re-estimación de bias en vivo, corrección térmica y
compensación de brazo de palanca — ver [PLAN-V2.md](PLAN-V2.md) para el
diseño completo de esa parte (implementada en `imu.py` + extensiones de
`dsp.py`/`app.py`).

## Instalar y correr

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

Requiere Python 3.11+ (probado con 3.12). Si `python3 -m venv` usa una
versión muy nueva (3.13+) y `pip install` falla por falta de wheels de
PySide6/bleak, apuntá el venv a una versión más asentada, p. ej. con pyenv:

```bash
~/.pyenv/versions/3.12.13/bin/python3 -m venv .venv
```

## Verificar sin hardware

```bash
.venv/bin/python test_dsp.py
.venv/bin/python test_imu.py
```

`test_dsp.py` corre los asserts de parsers v1 y v2, despacho por versión,
wraparound de timestamp, reconstrucción de grilla con y sin giroscopio
(incluido tratar `IMU_READ_FAILED` como hueco), coherencia entre
`timestamp` y `sequence`, estadísticos de jitter, integración,
equivalencia con el filtro de `vbt.ts`, sanidad del pasa-bajos y sanidad
de los exportadores de C (filtro, Mahony/Madgwick, térmica) — sin
necesitar el sensor.

`test_imu.py` cubre la fusión de orientación de `imu.py`: integración de
cuaterniones, filtros Mahony/Madgwick con rechazo de aceleración, fuga de
gravedad, detectores de reposo ARE/SHOE, re-estimación de bias, anclas O6,
ajuste térmico, desviación de Allan y compensación de brazo de palanca. Un
test compara el Mahony propio contra `ahrs.filters.Mahony` si el paquete
opcional `ahrs` está instalado (`pip install ahrs`); si no está, ese test
imprime SKIP y el resto corre igual.

## Uso

1. **Conectar**: escanea y conecta a `VBT-ESP32` en un solo paso (no hay
   selector de dispositivo — el firmware solo anuncia uno).
2. **Rec**: graba la sesión a `sessions/YYYY-MM-DD_HHMMSS.csv`.
3. **Abrir…**: recarga una grabación para comparar filtros offline sobre
   la misma captura, sin el sensor encendido.
4. Pestaña **Filters**: todo lo relacionado a procesar la señal vive acá
   en una sola vista con scroll, sin tabs adicionales, para poder combinar
   filtro + orientación + térmica sin ir y volver:
   - **Filtro de señal**: elegí un filtro del banco — ese mismo filtro es
     el que se aplica en las pestañas Accel/Velocity/Stats. Con
     giroscopio disponible, el eje `a_vert (mundo)` usa la orientación
     dinámica en vez de la proyección fija. **Export firmware snippet**
     genera el C con los coeficientes reales, listo para pegar en
     `firmware/src/main.cpp`.
   - **Orientación** (necesita giroscopio + "Capturar reposo"): elegí el
     estimador (O1–O5), sus ganancias/tolerancias de rechazo, si querés
     re-bias automático en reposo (C4), y una referencia O6 (anclas, no
     causal) superpuesta punteada sobre θ. Exporta Mahony/Madgwick
     (E2/E3).
   - **Sensor / térmica**: temperatura en vivo y su derivada, ajuste de
     bias-vs-temperatura por eje, desviación de Allan por eje (ARW /
     inestabilidad de bias), y export de la corrección térmica (E4, una
     vez ajustada arriba).

   Todos los plots (PSD/Winter del filtro, roll/pitch/yaw/θ/fuga/bias de
   orientación, temperatura/térmica/Allan) están apilados con scroll en
   la misma columna de la derecha — no hace falta cambiar de pestaña para
   verlos juntos.
5. Pestaña **Velocity**: "Capturar reposo" calibra bias/temperatura y
   habilita todo lo que sigue. El selector de fuente de `v_vert` elige
   entre la proyección fija (O0, la de siempre) y la orientación dinámica
   (configurada en Filters → Orientación); el selector de detector de
   reposo (Z1/Z2/Z3) alimenta tanto el ZUPT como el detrend por segmentos
   y la re-estimación de bias; el brazo de palanca compensa un
   acelerómetro montado fuera del eje de giro.

## Notas de implementación

- **BLE**: `bleak` corre en un hilo aparte con su propio loop de asyncio;
  los paquetes llegan a la UI por una `queue.SimpleQueue` que un `QTimer`
  de 33 ms drena (ver `ble.py`). Si `bleak` empieza a quejarse de correr
  su loop fuera del hilo principal en algún macOS/versión puntual, la
  salida es `qasync` (un solo loop compartido Qt+asyncio) — no está
  implementado porque no hizo falta todavía.
- **`get_rssi()`** no existe en bleak 3.x (se removió). El RSSI se
  captura una sola vez, en el momento del scan, desde los datos de
  advertising — no se actualiza en vivo mientras está conectado.
- El struct del paquete BLE (ver `protocol.py`) es la misma fuente de
  verdad que `firmware/src/main.cpp` y `clients/mobile/src/protocol.ts`.
  Si el paquete cambia, cambian los tres.
- **Protocolo v2** (42 bytes): agrega giroscopio, temperatura, un byte de
  flags y el diagnóstico de tiempo (`timestamp` agendado + `jitterUs`).
  Ver [../../firmware/PLAN.md](../../firmware/PLAN.md). `parse_packet`
  despacha por el byte de versión y sigue leyendo v1, así que las
  grabaciones viejas se abren igual — sin giro, temperatura ni jitter,
  que aparecen como NaN y no como ceros.
- **El cliente móvil todavía no habla v2** y no recibe nada del firmware
  actual hasta que `clients/mobile/src/protocol.ts` despache por versión.
