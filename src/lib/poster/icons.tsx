import type { PosterIcon } from '@/lib/types/poster';

/**
 * The monoline icon set for the feature block.
 *
 * Authored as geometry data rather than imported from an icon library for two
 * reasons: satori rasterises inline SVG but cannot resolve `currentColor` or a
 * CSS-driven `stroke`, so every glyph needs its stroke passed explicitly; and the
 * style spec (§2) requires a *consistent* 1.5–2px monoline weight across the set,
 * which a mixed-provenance library cannot guarantee.
 *
 * All shapes are drawn on a 24×24 grid with a nominal 1.6 stroke, then scaled.
 * Because stroke width scales with the glyph, `strokeWidth` is expressed in grid
 * units and stays visually constant at any size.
 */

type Shape =
  | { t: 'path'; d: string }
  | { t: 'circle'; cx: number; cy: number; r: number }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { t: 'rect'; x: number; y: number; w: number; h: number; rx?: number };

const GLYPHS: Record<PosterIcon, Shape[]> = {
  // Dome, brim, and the crown ridge.
  hardHat: [
    { t: 'path', d: 'M4.5 16.5a7.5 7.5 0 0 1 15 0' },
    { t: 'line', x1: 2, y1: 16.5, x2: 22, y2: 16.5 },
    { t: 'path', d: 'M9.5 9.6V5.6a1.2 1.2 0 0 1 1.2-1.2h2.6a1.2 1.2 0 0 1 1.2 1.2v4' },
  ],

  // Single tower with window rows.
  building: [
    { t: 'path', d: 'M6.5 20.5V4.6a1.1 1.1 0 0 1 1.1-1.1h8.8a1.1 1.1 0 0 1 1.1 1.1v15.9' },
    { t: 'line', x1: 3.5, y1: 20.5, x2: 20.5, y2: 20.5 },
    { t: 'line', x1: 9.8, y1: 7.5, x2: 11.4, y2: 7.5 },
    { t: 'line', x1: 12.6, y1: 7.5, x2: 14.2, y2: 7.5 },
    { t: 'line', x1: 9.8, y1: 11, x2: 11.4, y2: 11 },
    { t: 'line', x1: 12.6, y1: 11, x2: 14.2, y2: 11 },
    { t: 'path', d: 'M10.8 20.5v-4h2.4v4' },
  ],

  // Three masses of differing height — the "development" glyph.
  skyline: [
    { t: 'path', d: 'M3 20.5V12h4.5v8.5' },
    { t: 'path', d: 'M7.5 20.5V6.5h5v14' },
    { t: 'path', d: 'M12.5 20.5V9.5H21v11' },
    { t: 'line', x1: 2, y1: 20.5, x2: 22, y2: 20.5 },
    { t: 'line', x1: 15, y1: 12.5, x2: 18.5, y2: 12.5 },
    { t: 'line', x1: 15, y1: 16, x2: 18.5, y2: 16 },
  ],

  shieldCheck: [
    { t: 'path', d: 'M12 3.2l7.3 2.8v5.6c0 4.6-3.1 8-7.3 9.6-4.2-1.6-7.3-5-7.3-9.6V6z' },
    { t: 'path', d: 'M8.9 12.1l2.4 2.4 4.1-4.4' },
  ],

  stopwatch: [
    { t: 'circle', cx: 12, cy: 13.4, r: 7.3 },
    { t: 'path', d: 'M12 9.4v4.2l2.7 1.8' },
    { t: 'line', x1: 9.8, y1: 2.6, x2: 14.2, y2: 2.6 },
    { t: 'line', x1: 12, y1: 2.6, x2: 12, y2: 6.1 },
  ],

  // Drawing sheet with a grid and a dimension line.
  blueprint: [
    { t: 'rect', x: 3.2, y: 4.4, w: 17.6, h: 15.2, rx: 1.4 },
    { t: 'line', x1: 3.2, y1: 9, x2: 20.8, y2: 9 },
    { t: 'line', x1: 8.4, y1: 9, x2: 8.4, y2: 19.6 },
    { t: 'path', d: 'M11.4 12.2h6.2v4.4h-6.2z' },
    { t: 'line', x1: 5.2, y1: 12.2, x2: 6.6, y2: 12.2 },
    { t: 'line', x1: 5.2, y1: 15.2, x2: 6.6, y2: 15.2 },
  ],

  people: [
    { t: 'circle', cx: 9.2, cy: 8.1, r: 3.1 },
    { t: 'path', d: 'M3.4 19.8c0-3.2 2.6-5.5 5.8-5.5s5.8 2.3 5.8 5.5' },
    { t: 'path', d: 'M16 5.6a3 3 0 0 1 0 5.9' },
    { t: 'path', d: 'M17.2 14.6c2.1.5 3.6 2.4 3.6 5.2' },
  ],

  award: [
    { t: 'circle', cx: 12, cy: 8.9, r: 5.4 },
    { t: 'path', d: 'M8.4 13.4L6.9 21.2 12 18.6l5.1 2.6-1.5-7.8' },
    { t: 'path', d: 'M10.4 8.8l1.2 1.3 2.1-2.3' },
  ],

  // Two forearms meeting in a clasp.
  handshake: [
    { t: 'path', d: 'M1.8 13.4h3.6l3 3a2.1 2.1 0 0 0 3 0' },
    { t: 'path', d: 'M22.2 13.4h-3.6l-3-3a2.1 2.1 0 0 0-3 0l-2.2 2.2' },
    { t: 'line', x1: 5.4, y1: 10.4, x2: 5.4, y2: 16.4 },
    { t: 'line', x1: 18.6, y1: 10.4, x2: 18.6, y2: 16.4 },
  ],

  truck: [
    { t: 'path', d: 'M2.6 6.8h10.6v9.6H2.6z' },
    { t: 'path', d: 'M13.2 10.2h3.9l3.3 3.3v2.9h-7.2z' },
    { t: 'circle', cx: 7, cy: 18.4, r: 1.9 },
    { t: 'circle', cx: 17, cy: 18.4, r: 1.9 },
    { t: 'line', x1: 8.9, y1: 18.4, x2: 15.1, y2: 18.4 },
  ],

  // House cradled above an open palm.
  houseInHand: [
    { t: 'path', d: 'M6.6 11.4L12 6.8l5.4 4.6' },
    { t: 'path', d: 'M8.2 10.2v5.4h7.6v-5.4' },
    { t: 'path', d: 'M3.6 17.6c2.6 2.6 5.6 3.6 8.4 3.6s5.8-1 8.4-3.6' },
  ],

  locationPin: [
    { t: 'path', d: 'M12 21.2s7-6.4 7-11.2a7 7 0 1 0-14 0c0 4.8 7 11.2 7 11.2z' },
    { t: 'circle', cx: 12, cy: 9.8, r: 2.6 },
  ],

  star: [
    {
      t: 'path',
      d: 'M12 3.1l2.8 5.7 6.3.9-4.6 4.4 1.1 6.2L12 17.4l-5.6 2.9 1.1-6.2L2.9 9.7l6.3-.9z',
    },
  ],

  chart: [
    { t: 'line', x1: 4.2, y1: 20, x2: 4.2, y2: 4 },
    { t: 'line', x1: 4.2, y1: 20, x2: 20.4, y2: 20 },
    { t: 'path', d: 'M7.2 16.2l3.6-4.2 3.1 2.6 5.1-7' },
    { t: 'path', d: 'M15.6 7.6H19v3.4' },
  ],

  leaf: [
    { t: 'path', d: 'M5 19.4c0-8 6.2-14.2 14.4-14.2 0 8.2-6.2 14.4-14.4 14.4z' },
    { t: 'line', x1: 5, y1: 19.4, x2: 14.6, y2: 9.8 },
  ],

  key: [
    { t: 'circle', cx: 8.4, cy: 8.4, r: 4.4 },
    { t: 'line', x1: 11.6, y1: 11.6, x2: 20.4, y2: 20.4 },
    { t: 'line', x1: 14.4, y1: 14.4, x2: 16.6, y2: 12.2 },
    { t: 'line', x1: 17.2, y1: 17.2, x2: 19.4, y2: 15 },
  ],
};

export interface PosterIconGlyphProps {
  name: PosterIcon;
  /** Rendered box, in output pixels. */
  size: number;
  color: string;
  /** In 24-unit grid terms, so apparent weight is size-independent. */
  strokeWidth?: number;
}

/**
 * One glyph as an inline SVG element satori can rasterise.
 *
 * Unknown names cannot occur through the typed path, but `posterCopy` arrives
 * from a `Json` column — a row written by an older schema could carry a name that
 * has since been removed from the set, so an unrecognised name degrades to
 * `shieldCheck` rather than rendering an empty box.
 */
export function PosterIconGlyph({
  name,
  size,
  color,
  strokeWidth = 1.6,
}: PosterIconGlyphProps) {
  const shapes = GLYPHS[name] ?? GLYPHS.shieldCheck;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {shapes.map((shape, index) => renderShape(shape, index))}
    </svg>
  );
}

function renderShape(shape: Shape, index: number) {
  switch (shape.t) {
    case 'path':
      return <path key={index} d={shape.d} />;
    case 'circle':
      return <circle key={index} cx={shape.cx} cy={shape.cy} r={shape.r} />;
    case 'line':
      return (
        <line key={index} x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} />
      );
    case 'rect':
      return (
        <rect
          key={index}
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          rx={shape.rx ?? 0}
        />
      );
  }
}

/** Icon names the copy stage may choose from, for the LLM prompt. */
export function listIconNames(): PosterIcon[] {
  return Object.keys(GLYPHS) as PosterIcon[];
}
