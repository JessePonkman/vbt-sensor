// Two SVG chart primitives — a multi-line chart and a candle chart — plus
// their coordinate-mapping helpers. Nothing else in the app draws an SVG
// element outside this file. See PLAN-V2.md §5.
//
// No animation, no gestures, no tooltips: not asked for, not built. All
// text (axis labels, min/max) is RN <Text> laid out around the <Svg>, never
// SVG text — it sidesteps every font-metric/baseline problem for free.

import React, { useCallback, useMemo, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Path, Rect } from 'react-native-svg';
import { colors } from './ui';

export type Series = { values: number[]; color: string };
export type Candle = { lo: number; hi: number; mid: number; color: string };

/** Shared domain across all series, 5% padded; flat/empty data falls back
 *  to a sane default so a chart with one constant reading isn't a zero-height
 *  line glued to an edge. */
export function extent(series: number[][]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    for (const v of s) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!isFinite(lo)) return [0, 1];
  if (lo === hi) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.05;
  return [lo - pad, hi + pad];
}

/** SVG path preserving peaks at any density: points are bucketed into one
 *  column per pixel and each column emits its max then its min. With <= 1
 *  point per column this degenerates into a plain polyline, so a 300-sample
 *  live window and a 10,000-sample full-set replay share one code path, and
 *  the output is bounded at ~2*w points regardless of input size — a naive
 *  stride sample would instead silently skip over the exact peak velocity
 *  spike this app exists to show. */
export function envelopePath(v: readonly number[], w: number, h: number, lo: number, hi: number): string {
  const n = v.length;
  if (n === 0 || w <= 0) return '';
  const span = hi - lo || 1;
  const y = (val: number) => h - ((val - lo) / span) * h;
  if (n === 1) return `M0 ${y(v[0]).toFixed(1)}H${w.toFixed(1)}`;

  const pts: string[] = [];
  let col = -1;
  let cx = 0;
  let mn = 0;
  let mx = 0;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const c = x | 0;
    if (c !== col) {
      if (col >= 0) pts.push(`${cx.toFixed(1)} ${y(mx).toFixed(1)}`, `${cx.toFixed(1)} ${y(mn).toFixed(1)}`);
      col = c;
      cx = x;
      mn = mx = v[i];
    } else {
      if (v[i] < mn) mn = v[i];
      if (v[i] > mx) mx = v[i];
    }
  }
  pts.push(`${cx.toFixed(1)} ${y(mx).toFixed(1)}`, `${cx.toFixed(1)} ${y(mn).toFixed(1)}`);
  return 'M' + pts.join('L');
}

/** Width comes from onLayout, not a fixed viewBox: decimation needs the real
 *  pixel width to pick a bucket count, so measuring is a requirement, not
 *  overhead, and it avoids react-native-svg's unreliable-on-Android
 *  non-uniform-scale + vectorEffect combination. */
function useMeasuredWidth() {
  const [w, setW] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width), []);
  return [w, onLayout] as const;
}

export function LineChart({
  series,
  height = 120,
  zeroLine = true,
  domain,
}: {
  series: Series[];
  height?: number;
  zeroLine?: boolean;
  domain?: [number, number];
}) {
  const [w, onLayout] = useMeasuredWidth();
  const [lo, hi] = domain ?? extent(series.map((s) => s.values));
  const empty = series.every((s) => s.values.length === 0);

  const paths = useMemo(() => series.map((s) => envelopePath(s.values, w, height, lo, hi)), [series, w, height, lo, hi]);

  return (
    <View style={[styles.frame, { height }]} onLayout={onLayout}>
      {w > 0 && !empty && (
        <Svg width={w} height={height}>
          {zeroLine && lo < 0 && hi > 0 && (
            <Line
              x1={0}
              x2={w}
              y1={height - ((0 - lo) / (hi - lo || 1)) * height}
              y2={height - ((0 - lo) / (hi - lo || 1)) * height}
              stroke={colors.surface}
              strokeWidth={1}
            />
          )}
          {paths.map((d, i) => (d ? <Path key={i} d={d} stroke={series[i].color} strokeWidth={2} fill="none" /> : null))}
        </Svg>
      )}
      {empty && (
        <Text style={styles.emptyText}>Sin datos</Text>
      )}
    </View>
  );
}

export function CandleChart({
  candles,
  height = 140,
  domain,
}: {
  candles: Candle[];
  height?: number;
  domain?: [number, number];
}) {
  const [w, onLayout] = useMeasuredWidth();
  const [lo, hi] = domain ?? extent(candles.map((c) => [c.lo, c.hi]));
  const span = hi - lo || 1;
  const yy = (val: number) => height - ((val - lo) / span) * height;
  const n = candles.length;
  const step = n > 0 ? w / n : 0;
  const gap = Math.min(6, step * 0.25);

  return (
    <View>
      <View style={[styles.frame, { height }]} onLayout={onLayout}>
        {w > 0 && n > 0 && (
          <Svg width={w} height={height}>
            {lo < 0 && hi > 0 && <Line x1={0} x2={w} y1={yy(0)} y2={yy(0)} stroke={colors.surface} strokeWidth={1} />}
            {candles.map((c, i) => (
              <React.Fragment key={i}>
                <Rect
                  x={i * step + gap / 2}
                  width={Math.max(1, step - gap)}
                  y={yy(c.hi)}
                  height={Math.max(2, yy(c.lo) - yy(c.hi))}
                  fill={c.color}
                  rx={2}
                />
                <Line
                  x1={i * step + gap / 2}
                  x2={i * step + step - gap / 2}
                  y1={yy(c.mid)}
                  y2={yy(c.mid)}
                  stroke={colors.background}
                  strokeWidth={2}
                />
              </React.Fragment>
            ))}
          </Svg>
        )}
        {n === 0 && <Text style={styles.emptyText}>Sin datos</Text>}
      </View>
      {n > 0 && (
        <View style={styles.labelRow}>
          {candles.map((_, i) => (
            <Text key={i} style={styles.labelText}>
              {i + 1}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.surface,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: { color: colors.textSecondary, fontSize: 13 },
  labelRow: { flexDirection: 'row', marginTop: 4 },
  labelText: { flex: 1, textAlign: 'center', color: colors.textSecondary, fontSize: 11, fontVariant: ['tabular-nums'] },
});
