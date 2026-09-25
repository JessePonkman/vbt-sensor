# VBT Sensor — cliente de escritorio

Osciloscopio de debug para el sensor VBT: conecta por BLE, muestra el stream
crudo, integra a velocidad, calcula estadísticos, y trae un banco de
filtros con las herramientas (PSD, análisis de residuos de Winter) para
elegir cuál implementar en el firmware — y lo exporta como snippet de C.
Ver [PLAN.md](PLAN.md) para el diseño completo.

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
```

Corre los asserts de `test_dsp.py` (parsers v1 y v2, despacho por
versión, wraparound de timestamp, reconstrucción de grilla con y sin
giroscopio, coherencia entre `timestamp` y `sequence`, estadísticos de
jitter, integración, equivalencia con el filtro de `vbt.ts`, sanidad del
pasa-bajos, sanidad del exportador de C) sin necesitar el sensor.

## Uso

1. **Conectar**: escanea y conecta a `VBT-ESP32` en un solo paso (no hay
   selector de dispositivo — el firmware solo anuncia uno).
2. **Rec**: graba la sesión a `sessions/YYYY-MM-DD_HHMMSS.csv`.
3. **Abrir…**: recarga una grabación para comparar filtros offline sobre
   la misma captura, sin el sensor encendido.
4. Pestaña **Filters**: elegí un filtro del banco — ese mismo filtro es el
   que se aplica en las pestañas Accel/Velocity/Stats. El botón **Export
   firmware snippet** genera el C con los coeficientes reales, listo para
   pegar en `firmware/src/main.cpp`.

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
