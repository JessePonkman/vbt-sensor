# Comparativa de pipelines — antes y después

Generado con `npm run bench -- --md`. Simulador con verdad conocida (`src/sim.ts`), sentadilla.

- **ORIGINAL**: la máquina de estados en streaming de `src/vbt.ts`.
- **NUEVO, acelerómetro**: detector por desplazamiento (`src/reps.ts`), inclinación estimada solo con el acelerómetro.
- **NUEVO + giroscopio**: igual, pero con la orientación fusionada Mahony (`src/orientation.ts`, portada de `clients/desktop/imu.py`).

Reps = encontradas / reales. Fant. = reps detectadas que no existen. Pico / media / ROM = error medio relativo a la verdad sobre las reps emparejadas.

| Escenario | orig reps | fant. | pico | media | ROM | acc reps | fant. | pico | media | ROM | gyro reps | fant. | pico | media | ROM |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| normal | 4/4 | 0 | +0% | -0% | +0% | 4/4 | 0 | +0% | +7% | +0% | 4/4 | 0 | +0% | +7% | +0% |
| rapida | 4/4 | 0 | +0% | -28% | -1% | 4/4 | 0 | +1% | +6% | +0% | 4/4 | 0 | +1% | +5% | -0% |
| pausa_corta | 4/4 | 0 | +0% | -1% | +0% | 4/4 | 0 | +0% | +7% | +0% | 4/4 | 0 | +0% | +7% | +0% |
| pausa_larga | 4/4 | 0 | +0% | -1% | +0% | 4/4 | 0 | +0% | +7% | -0% | 4/4 | 0 | +0% | +7% | +0% |
| tempo_lento | 0/4 | 0 | — | — | — | 4/4 | 0 | +0% | +8% | -0% | 4/4 | 0 | +0% | +8% | +0% |
| tempo_pausa | 0/4 | 0 | — | — | — | 4/4 | 0 | -0% | +8% | -1% | 4/4 | 0 | +0% | +8% | -1% |
| rebote_suave | 4/4 | 0 | +0% | +0% | -0% | 4/4 | 0 | +1% | +6% | +0% | 4/4 | 0 | +0% | +5% | -0% |
| rebote_brusco | 4/4 | 0 | -0% | -4% | -2% | 4/4 | 0 | -0% | +5% | -1% | 4/4 | 0 | -0% | +5% | -1% |
| limite | 0/4 | 0 | — | — | — | 4/4 | 0 | -1% | +5% | -0% | 4/4 | 0 | -1% | +5% | -0% |
| limite_extremo | 0/2 | 0 | — | — | — | 2/2 | 0 | -1% | +5% | -0% | 2/2 | 0 | -1% | +5% | -1% |
| fatiga | 3/6 | 0 | +0% | -1% | +0% | 6/6 | 0 | +0% | +8% | -0% | 6/6 | 0 | +0% | +8% | -0% |
| inclinada_suave | 4/4 | 0 | +1% | -0% | +0% | 4/4 | 0 | +1% | +7% | +0% | 4/4 | 0 | +0% | +7% | +0% |
| inclinada_fuerte | 4/4 | 0 | -1% | -4% | -1% | 4/4 | 0 | -1% | +5% | -1% | 4/4 | 0 | +0% | +7% | +0% |
| rotacion_real | 1/4 | 0 | -4% | -27% | -7% | 4/4 | 0 | +1% | -1% | +3% | 4/4 | 0 | +0% | +7% | +0% |
| walkout_inclinada | 0/4 | 1 | — | — | — | 4/4 | 0 | +0% | +10% | -0% | 4/4 | 0 | -0% | +10% | -1% |
| walkout | 0/4 | 0 | — | — | — | 4/4 | 0 | +0% | +10% | -0% | 4/4 | 0 | -0% | +10% | -1% |
| walkout_lento | 0/3 | 0 | — | — | — | 3/3 | 0 | +0% | +9% | -0% | 3/3 | 0 | +0% | +9% | +0% |
| **TOTAL** | **36/67** | 1 |  |  |  | **67/67** | 0 |  |  |  | **67/67** | 0 |  |  |  |

## Grabaciones reales (sin verdad conocida)

```
2026-09-25_163821.csv  (1710 muestras)
  ORIGINAL (vbt.ts)    reps 0  ROM —                    pico —                    media —
  NUEVO, acelerómetro  reps 4  ROM 0.61 0.59 0.67 0.68  pico 1.12 1.06 1.15 1.21  media 0.67 0.67 0.72 0.73
  NUEVO + giroscopio   reps 4  ROM 0.61 0.59 0.67 0.68  pico 1.13 1.06 1.15 1.21  media 0.68 0.66 0.73 0.73
2026-10-30_193155.csv  (3051 muestras)
  ORIGINAL (vbt.ts)    reps 0  ROM —                    pico —                    media —
  NUEVO, acelerómetro  reps 4  ROM 0.65 0.67 0.76 0.81  pico 0.87 0.76 1.17 1.00  media 0.56 0.49 0.60 0.53
  NUEVO + giroscopio   reps 4  ROM 0.66 0.69 0.75 0.85  pico 0.88 0.77 1.16 1.02  media 0.57 0.49 0.59 0.54
```

## Dataset aleatorio

```
DATASET ALEATORIO — 600 sesiones, 2412 reps (32 sorteos descartados por no ser una sentadilla físicamente posible)

pipeline              reps halladas     fantasmas  sesiones perfectas  error pico (mediana / p95)  error media (med / p95)   error ROM (med / p95)
------------------------------------------------------------------------------------------------------------------------------------------------------
ORIGINAL (vbt.ts)     68/2412 (2.8%)    16         5/600 (1%)          3% / 7%                     5% / 64%                  3% / 8%
NUEVO, acelerómetro   2384/2412 (98.8%) 22         564/600 (94%)       3% / 11%                    9% / 27%                  4% / 24%
NUEVO + giroscopio    2404/2412 (99.7%) 4          590/600 (98%)       3% / 9%                     9% / 23%                  3% / 17%

POR TIPO DE SESIÓN — % de reps halladas (fantasmas entre paréntesis)

tipo                sesiones  ORIGINAL (vbt.ts)       NUEVO, acelerómetro     NUEVO + giroscopio      
------------------------------------------------------------------------------------------------------
bounce              127       2.7% (4)                98.6% (11)              99.8% (3)               
con_giro            508       2.2% (13)               98.8% (20)              99.8% (2)               
grind               150       0.0% (0)                98.4% (5)               99.1% (0)               
lento               239       0.4% (1)                98.9% (7)               99.2% (1)               
paquetes_perdidos   239       2.5% (3)                98.5% (10)              99.6% (3)               
pausa_corta         157       5.2% (5)                99.2% (4)               100.0% (0)              
pausa_larga         129       1.7% (6)                98.1% (3)               99.0% (0)               
rueda               148       4.7% (2)                100.0% (0)              100.0% (0)              
rueda_fuerte        176       0.9% (3)                96.6% (22)              99.2% (3)               
ruido_alto          238       0.0% (0)                98.8% (10)              99.6% (3)               
ruido_bajo          145       11.0% (16)              99.0% (6)               99.8% (0)               
ruido_medio         217       0.2% (0)                98.8% (6)               99.6% (1)               
sin_giro            92        6.3% (3)                99.2% (2)               99.2% (2)               
sin_pausa           314       2.1% (5)                99.0% (15)              99.8% (4)               
smooth              323       4.1% (12)               99.2% (6)               99.8% (1)               
walkout             428       2.3% (13)               98.6% (16)              99.5% (3)               

SESIONES CON FALLOS en "NUEVO + giroscopio": 10 de 600
  r1154   2/4 reps, 0 fantasmas | grind,lento,pausa_larga,walkout,paquetes_perdidos,ruido_medio,con_giro | ecc 4.4s pausa 4.48s con 6.06s rom 0.67 ruido 0.06
  r1585   3/5 reps, 0 fantasmas | grind,lento,pausa_larga,walkout,rueda_fuerte,ruido_alto,con_giro | ecc 2.48s pausa 4.47s con 4.04s rom 0.37 ruido 0.10
  r1331   4/5 reps, 0 fantasmas | bounce,lento,sin_pausa,walkout,rueda_fuerte,paquetes_perdidos,ruido_medio,sin_giro | ecc 4.65s pausa 0s con 1.32s rom 0.52 ruido 0.07
  r1444   4/4 reps, 1 fantasmas | bounce,sin_pausa,walkout,paquetes_perdidos,ruido_alto,con_giro | ecc 2.97s pausa 0s con 2.38s rom 0.40 ruido 0.11
  r1480   4/5 reps, 0 fantasmas | grind,lento,pausa_larga,walkout,rueda_fuerte,ruido_alto,con_giro | ecc 0.87s pausa 4.15s con 5.87s rom 0.55 ruido 0.12
  r1504   1/2 reps, 0 fantasmas | smooth,lento,sin_pausa,walkout,rueda_fuerte,paquetes_perdidos,ruido_bajo,sin_giro | ecc 4.56s pausa 0.12s con 0.42s rom 0.32 ruido 0.04
  r1522   1/1 reps, 1 fantasmas | bounce,sin_pausa,walkout,rueda_fuerte,ruido_alto,con_giro | ecc 1.38s pausa 0s con 0.99s rom 0.58 ruido 0.11
  r1535   2/3 reps, 0 fantasmas | smooth,sin_pausa,walkout,rueda_fuerte,ruido_alto,sin_giro | ecc 2.67s pausa 0.04s con 0.59s rom 0.47 ruido 0.14
  r1576   4/4 reps, 1 fantasmas | bounce,sin_pausa,walkout,rueda_fuerte,paquetes_perdidos,ruido_medio,sin_giro | ecc 1.29s pausa 0s con 0.54s rom 0.52 ruido 0.06
  r1577   2/2 reps, 1 fantasmas | smooth,lento,sin_pausa,rueda_fuerte,paquetes_perdidos,ruido_alto,sin_giro | ecc 4.35s pausa 0.11s con 0.83s rom 0.65 ruido 0.11
```

## Evaluación final, sobre datos que el detector nunca vio

`npm run bench:final`. A) dataset aleatorio nuevo (semillas 90000+, distintas de las de ajuste 5000+ y de evaluación 1000+). B) el generador de sentadilla de `src/vbt.test.ts` (otra física: perfil de velocidad sen², sin giroscopio), barrido con parámetros al azar.

```
A) DATASET ALEATORIO NUEVO — 1000 sesiones, semillas 90000+ (nunca usadas)
  ORIGINAL (vbt.ts)      halladas 88/3989 (2.2%)  fantasmas 6  perfectas 15/1000 (2%) | |error| pico 3% / 9%  media 8% / 29%  ROM 3% / 9%
  NUEVO, acelerómetro    halladas 3951/3989 (99.0%)  fantasmas 39  perfectas 939/1000 (94%) | |error| pico 3% / 12%  media 9% / 29%  ROM 4% / 25%
  NUEVO + giroscopio     halladas 3969/3989 (99.5%)  fantasmas 8  perfectas 979/1000 (98%) | |error| pico 3% / 10%  media 9% / 24%  ROM 3% / 19%

B) GENERADOR DE TU AMIGO (vbt.test.ts, perfil de velocidad sen², sin giroscopio) — 400 sesiones al azar
  ORIGINAL (vbt.ts)      halladas 174/1584 (11.0%)  fantasmas 3  perfectas 40/400 (10%) | |error| pico 2% / 5%  media 4% / 11%  ROM 2% / 5%
  NUEVO, acelerómetro    halladas 1583/1584 (99.9%)  fantasmas 0  perfectas 399/400 (100%) | |error| pico 3% / 10%  media 18% / 36%  ROM 4% / 17%
```

### Cómo leer esto (y qué no prueba)

- **Ajuste y evaluación están separados.** Los umbrales y criterios se ajustaron con sesiones de entrenamiento (semillas 5000+). El número de las 600 sesiones (semillas 1000+) y el de las 1000 nuevas (90000+) son casi iguales (≈99,5–99,7% de reps halladas con giroscopio), que es la señal de que no hay sobreajuste a un conjunto concreto.
- **Lo que un dataset más grande NO arregla:** el simulador (`src/sim.ts`) y el detector (`src/reps.ts`) los escribió la misma persona. Por eso la prueba B usa un generador ajeno, y la prueba real usa las grabaciones de `clients/desktop/sessions`. Nada de esto reemplaza grabar series reales con el sensor en la barra y contarlas a mano.
- **Velocidad media: sesgo conocido y de método.** El detector mide el inicio y el fin de la subida cuando la velocidad supera el 3% de su pico (con un piso que crece con el ruido). Los tramos lentos del arranque y del final de la subida quedan fuera, así que la velocidad media sale *alta*: ≈ +9% con `sim.ts` y ≈ +18% con el generador sen² (que arranca más suave). La velocidad **pico** (mediana 3% de error) no depende de esa convención. Para entrenar con velocidad conviene mirar el pico y la caída relativa entre reps de la misma serie, no el valor absoluto de la media, hasta decidir una convención de inicio/fin.
- **Dónde sigue fallando:** series lentas (subida de 5–6 s) combinadas con ruido alto, la barra rodando fuerte, y walkout; y sin giroscopio (paquetes v1) hay más fantasmas con la barra rodando.
