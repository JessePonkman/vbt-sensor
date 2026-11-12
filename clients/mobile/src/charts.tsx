// Two charts for reviewing a set, both with real axes and both selectable:
//
//   RepBars        one bar per rep (mean concentric velocity), a tick for the
//                  peak, colour by how far the rep fell below the set's best.
//   VelocityCurve  the whole set's velocity against time, each rep's span
//                  shaded behind it.
//
// Tapping a bar, or a rep's span in the curve, selects that rep; the screen
// highlights it in the other chart and in the table. All text is RN <Text>
// laid out around the <Svg> (never SVG text), which sidesteps font-metric
// differences between Android, iOS and the browser. Width comes from onLayout,
// so the same chart fills a 320 dp phone or a 760 px column.

import React, { useCallback, useMemo, useState } from 'react';
import { LayoutChangeEvent, Pressable, Text, View } from 'react-native';
import Svg, { Line, Path, Rect } from 'react-native-svg';
import type { RepRow } from './session';
import { useLayout } from './responsive';
import { useTheme } from './theme';

// ---- helpers ------------------------------------------------------------------

/** A readable step (1, 2, 5 x 10^n) and the ticks it puts inside [lo, hi]. */
export function niceTicks(lo: number, hi: number, target = 4): number[] {
  const range = hi - lo;
  if (!(range > 0)) return [lo];
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/** SVG path that keeps peaks at any density: one column per pixel, each column
 *  emits its max then its min, so a 10,000-sample set draws like a 300-sample
 *  one and never skips the peak velocity this app exists to show. */
export function envelopePath(x: readonly number[], y: readonly number[], w: number, h: number, x0: number, x1: number, lo: number, hi: number): string {
  const n = y.length;
  if (n === 0 || w <= 0) return '';
  const sx = w / (x1 - x0 || 1);
  const sy = h / (hi - lo || 1);
  const py = (v: number) => h - (v - lo) * sy;
  const pts: string[] = [];
  let col = -1;
  let cx = 0;
  let mn = 0;
  let mx = 0;
  for (let i = 0; i < n; i++) {
    const px = (x[i] - x0) * sx;
    const c = Math.floor(px);
    if (c !== col) {
      if (col >= 0) pts.push(`${cx.toFixed(1)} ${py(mx).toFixed(1)}`, `${cx.toFixed(1)} ${py(mn).toFixed(1)}`);
      col = c;
      cx = px;
      mn = mx = y[i];
    } else {
      if (y[i] < mn) mn = y[i];
      if (y[i] > mx) mx = y[i];
    }
  }
  pts.push(`${cx.toFixed(1)} ${py(mx).toFixed(1)}`, `${cx.toFixed(1)} ${py(mn).toFixed(1)}`);
  return 'M' + pts.join('L');
}

function useWidth() {
  const [w, setW] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width), []);
  return [w, onLayout] as const;
}

const AXIS_W = 40; // room for the y labels
const XAXIS_H = 20;

const fmt = (v: number) => (Math.abs(v) < 1e-9 ? '0' : String(parseFloat(v.toFixed(2))));

// ---- per-rep bars -----------------------------------------------------------------

export function RepBars({
  rows,
  selected,
  onSelect,
  height = 190,
}: {
  rows: RepRow[];
  selected: number | null;
  onSelect: (index: number | null) => void;
  height?: number;
}) {
  const { colors } = useTheme();
  const { s } = useLayout();
  const [w, onLayout] = useWidth();
  const plotH = height - XAXIS_H;

  const top = Math.max(0.3, ...rows.map((r) => r.peakV)) * 1.12;
  const ticks = niceTicks(0, top, 4);
  const yTop = ticks[ticks.length - 1] > top ? ticks[ticks.length - 1] : top;
  const y = (v: number) => plotH - (v / yTop) * plotH;
  const n = rows.length;
  const slot = n > 0 && w > 0 ? w / n : 0;
  const barW = Math.max(6, Math.min(56, slot * 0.62));
  const showValues = slot >= 34;

  const colorOf = (r: RepRow) => (r.partial ? colors.textDim : r.dropFromBest < 0.1 ? colors.good : r.dropFromBest < 0.2 ? colors.warn : colors.bad);

  if (n === 0) return <Empty height={height} text="Sin reps detectadas" />;

  return (
    <View style={{ flexDirection: 'row', height }} accessibilityLabel="Velocidad media por repetición">
      <View style={{ width: AXIS_W, height: plotH }}>
        {ticks.map((t) => (
          <Text key={t} style={{ position: 'absolute', right: 6, top: y(t) - 8, color: colors.textDim, fontSize: s(11), fontVariant: ['tabular-nums'] }}>
            {fmt(t)}
          </Text>
        ))}
      </View>
      <View style={{ flex: 1, minWidth: 0, overflow: 'hidden' }} onLayout={onLayout}>
        {w > 0 && (
          <>
            <Svg width={w} height={plotH}>
              {ticks.map((t) => (
                <Line key={t} x1={0} x2={w} y1={y(t)} y2={y(t)} stroke={colors.border} strokeWidth={t === 0 ? 1.5 : 0.5} opacity={t === 0 ? 1 : 0.6} />
              ))}
              {rows.map((r, i) => {
                const cx = slot * i + slot / 2;
                const isSel = selected === r.index;
                return (
                  <React.Fragment key={r.index}>
                    {isSel && <Rect x={slot * i} y={0} width={slot} height={plotH} fill={colors.bandSelected} />}
                    <Rect x={cx - barW / 2} y={y(r.meanV)} width={barW} height={Math.max(1, plotH - y(r.meanV))} rx={3} fill={colorOf(r)} opacity={r.partial ? 0.45 : 1} />
                    <Line x1={cx - barW / 2 - 3} x2={cx + barW / 2 + 3} y1={y(r.peakV)} y2={y(r.peakV)} stroke={colors.text} strokeWidth={2} />
                  </React.Fragment>
                );
              })}
            </Svg>
            {showValues &&
              rows.map((r, i) => (
                <Text
                  key={r.index}
                  style={{ position: 'absolute', left: slot * i, width: slot, top: Math.max(0, y(r.peakV) - 17), textAlign: 'center', color: colors.text, fontSize: s(11), fontWeight: '700', fontVariant: ['tabular-nums'] }}
                >
                  {r.meanV.toFixed(2)}
                </Text>
              ))}
            <View style={{ flexDirection: 'row', height: XAXIS_H }}>
              {rows.map((r) => (
                <Text key={r.index} style={{ width: slot, textAlign: 'center', color: selected === r.index ? colors.text : colors.textDim, fontWeight: selected === r.index ? '800' : '500', fontSize: s(12) }}>
                  {r.partial ? `${r.index}*` : r.index}
                </Text>
              ))}
            </View>
            <View style={{ position: 'absolute', left: 0, top: 0, width: w, height: plotH, flexDirection: 'row' }}>
              {rows.map((r) => (
                <Pressable
                  key={r.index}
                  accessibilityRole="button"
                  accessibilityLabel={`Repetición ${r.index}, velocidad media ${r.meanV.toFixed(2)} metros por segundo`}
                  onPress={() => onSelect(selected === r.index ? null : r.index)}
                  style={{ flex: 1 }}
                />
              ))}
            </View>
          </>
        )}
      </View>
    </View>
  );
}

// ---- the whole set against time -----------------------------------------------------

export type Span = { index: number; start: number; end: number; partial: boolean };

export function VelocityCurve({
  t,
  v,
  spans,
  selected,
  onSelect,
  height = 220,
}: {
  t: number[];
  v: number[];
  spans: Span[];
  selected: number | null;
  onSelect: (index: number | null) => void;
  height?: number;
}) {
  const { colors } = useTheme();
  const { s } = useLayout();
  const [w, onLayout] = useWidth();
  const plotH = height - XAXIS_H;

  const { x0, x1, lo, hi } = useMemo(() => {
    let mn = 0;
    let mx = 0.2;
    for (const val of v) {
      if (val < mn) mn = val;
      if (val > mx) mx = val;
    }
    const pad = (mx - mn) * 0.08;
    return { x0: t.length ? t[0] : 0, x1: t.length ? t[t.length - 1] : 1, lo: mn - pad, hi: mx + pad };
  }, [t, v]);

  const path = useMemo(() => envelopePath(t, v, w, plotH, x0, x1, lo, hi), [t, v, w, plotH, x0, x1, lo, hi]);
  const yTicks = niceTicks(lo, hi, 4);
  const xTicks = niceTicks(x0, x1, w < 360 ? 4 : 7);
  const px = (sec: number) => ((sec - x0) / (x1 - x0 || 1)) * w;
  const py = (val: number) => plotH - ((val - lo) / (hi - lo || 1)) * plotH;

  if (t.length === 0) return <Empty height={height} text="Sin datos" />;

  const onTap = (locationX: number) => {
    const sec = x0 + (locationX / (w || 1)) * (x1 - x0);
    const hit = spans.find((sp) => sec >= sp.start && sec <= sp.end);
    onSelect(hit && hit.index !== selected ? hit.index : null);
  };

  return (
    <View style={{ flexDirection: 'row', height }} accessibilityLabel="Velocidad de la barra a lo largo de la serie">
      <View style={{ width: AXIS_W, height: plotH }}>
        {yTicks.map((tk) => (
          <Text key={tk} style={{ position: 'absolute', right: 6, top: py(tk) - 8, color: colors.textDim, fontSize: s(11), fontVariant: ['tabular-nums'] }}>
            {fmt(tk)}
          </Text>
        ))}
      </View>
      <View style={{ flex: 1, minWidth: 0, overflow: 'hidden' }} onLayout={onLayout}>
        {w > 0 && (
          <>
            <Pressable onPress={(e) => onTap(e.nativeEvent.locationX)} accessibilityRole="button" accessibilityLabel="Tocar una repetición para seleccionarla">
              <Svg width={w} height={plotH}>
                {spans.map((sp) => (
                  <Rect key={sp.index} x={px(sp.start)} y={0} width={Math.max(2, px(sp.end) - px(sp.start))} height={plotH} fill={selected === sp.index ? colors.bandSelected : colors.band} opacity={sp.partial ? 0.5 : 1} />
                ))}
                {yTicks.map((tk) => (
                  <Line key={tk} x1={0} x2={w} y1={py(tk)} y2={py(tk)} stroke={colors.border} strokeWidth={Math.abs(tk) < 1e-9 ? 1.5 : 0.5} opacity={Math.abs(tk) < 1e-9 ? 1 : 0.6} />
                ))}
                {path ? <Path d={path} stroke={colors.text} strokeWidth={1.75} fill="none" /> : null}
              </Svg>
            </Pressable>
            <View style={{ height: XAXIS_H }}>
              {xTicks.map((tk) => (
                <Text key={tk} style={{ position: 'absolute', top: 2, left: Math.min(Math.max(0, px(tk) - 14), Math.max(0, w - 28)), width: 28, textAlign: 'center', color: colors.textDim, fontSize: s(11), fontVariant: ['tabular-nums'] }}>
                  {fmt(tk)}
                </Text>
              ))}
            </View>
            {spans.map((sp) => (
              <Text key={sp.index} pointerEvents="none" style={{ position: 'absolute', top: 2, left: px(sp.start), width: Math.max(14, px(sp.end) - px(sp.start)), textAlign: 'center', color: selected === sp.index ? colors.text : colors.textDim, fontSize: s(11), fontWeight: '800' }}>
                {sp.index}
              </Text>
            ))}
          </>
        )}
      </View>
    </View>
  );
}

function Empty({ height, text }: { height: number; text: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ height, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: colors.border }}>
      <Text style={{ color: colors.textDim }}>{text}</Text>
    </View>
  );
}
