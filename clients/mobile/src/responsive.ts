// One place that decides how the UI adapts to the screen. Phones in portrait
// are the design case; a small phone (320-360 dp) gets tighter gutters and a
// touch less type, a tablet / browser window gets a centred column and, wide
// enough, two columns. Nothing here depends on the platform.

import { useWindowDimensions } from 'react-native';

export const MAX_CONTENT_WIDTH = 760;
const WIDE_AT = 900;

export type Layout = {
  width: number;
  height: number;
  gutter: number;
  contentWidth: number; // width of the column the content lives in
  isWide: boolean; // two-column layouts
  isShort: boolean; // landscape phone: avoid tall fixed-height blocks
  /** Scales a font size / control size to the screen. */
  s: (n: number) => number;
};

export function useLayout(): Layout {
  const { width, height } = useWindowDimensions();
  const gutter = width < 360 ? 12 : 16;
  const scale = width < 340 ? 0.9 : width >= 1000 ? 1.12 : width >= 600 ? 1.05 : 1;
  const isWide = width >= WIDE_AT;
  return {
    width,
    height,
    gutter,
    contentWidth: Math.min(width, isWide ? 1100 : MAX_CONTENT_WIDTH),
    isWide,
    isShort: height < 520,
    s: (n: number) => Math.round(n * scale),
  };
}
