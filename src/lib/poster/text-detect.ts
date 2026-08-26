import sharp from 'sharp';

/**
 * Finds the blocks of type on a reference poster, by measuring them.
 *
 * **The thing the vision model was asked for and never did.** `extractPlateRegions`
 * asks gpt-4o where each block of type sits, to three decimal places. Measured
 * across the live library on 2026-08-26: 59 of 60 stored boxes have all four
 * coordinates on a 0.05 grid, and the 240 numbers in the whole vertical take 22
 * distinct values. It was not measuring — it was emitting a plausible grid, and
 * its own stored reading says as much ("five horizontal bands... split about 50%
 * each"). Those boxes place the type *and* build the erase mask, so one bad
 * estimate both misplaces the words and clears the wrong artwork.
 *
 * Position is a property of the pixels, exactly like `findPlateHoles`' holes and
 * `sampleRegionInk`'s colours, and this module treats it that way. What is left
 * for a model is naming each measured block, which is classification rather than
 * measurement.
 *
 * **Text against photography is the whole difficulty.** Edge density alone finds
 * type and also finds every face, fold and leaf in a photograph. Three signals
 * separate them, and all three are cheap:
 *
 *   1. *Bimodality.* Type is ink on a surface — two populations with a gap
 *      between them. Continuous-tone photography fills the gap.
 *   2. *Edge density in a band.* Glyphs are mostly edge; flat artwork is none;
 *      photographic detail sits between and above.
 *   3. *Row coherence.* Letters share a baseline and a height, so text survives
 *      an aggressive horizontal close into clean lines. Photographic noise
 *      smears into blobs instead.
 */

/** Guards the decode against a decompression bomb, matching `plate-regions.ts`. */
const MAX_PIXELS = 32_000_000;

/**
 * Long edge the reference is reduced to before analysis.
 *
 * Every threshold below is in units of this frame, so the detector behaves the
 * same on a 900px reference and a 4000px one. Large enough that body copy is
 * still several pixels tall — below about 900 the smallest type stops being
 * separable from noise.
 */
const WORK_EDGE = 1600;

/**
 * Side of one analysis cell, in working pixels.
 *
 * The grid is what makes the morphology affordable: a 1200×2133 frame is 2.5M
 * pixels but only 40k cells. Six is a compromise measured against real posters —
 * small enough that a 14px caption occupies more than one row of cells, large
 * enough that a single cell holds enough pixels for its statistics to mean
 * something.
 */
const CELL = 8;

/** Luminance step that counts as an edge between neighbouring pixels. */
const EDGE_DELTA = 28;

/**
 * Share of a cell's pixels that must sit on an edge for it to be type.
 *
 * A band rather than a floor. Glyph strokes at poster sizes put a cell somewhere
 * around a fifth to two-thirds edge; a cell that is *almost entirely* edge is
 * noise, dithering or fine photographic texture, not a letterform.
 */
const MIN_EDGE_SHARE = 0.12;
const MAX_EDGE_SHARE = 0.86;

/**
 * How strongly a cell's luminance must clump at its two extremes.
 *
 * The discriminator that does most of the work. In a cell of type, nearly every
 * pixel is either ink or surface, so the share within a tolerance of the cell's
 * min or max runs high. A photographic cell spreads across the middle. Measured
 * on real references, type sits above 0.8 and photography below 0.6; 0.7 is the
 * gap between them.
 */
const MIN_BIMODALITY = 0.62;

/**
 * Tolerance for "at" one of a cell's two extremes, as a share of its own range.
 *
 * **Relative, and that is the whole difference between this working and not.**
 * A fixed tolerance is trivially satisfied whenever the range is small: at 42
 * luminance, a smooth photographic cell spanning 60 has every pixel within
 * tolerance of *both* ends, scores a perfect bimodality, and is reported as
 * type. Measured on the first run against real references: the doctor, the
 * white coat and the card beneath her merged into one component covering 68% of
 * the poster, taking the features and the contact bar into it.
 *
 * Scaled to the range, the same cell allows only 17, its mid-tones fall in the
 * gap, and it scores low — while a line of type, whose range is the full
 * distance from ink to paper, still clusters hard at both ends.
 */
const MODE_TOLERANCE_SHARE = 0.28;

/**
 * A cell whose luminance barely varies cannot hold type, whatever else it scores.
 *
 * Flat artwork trivially passes the bimodality test — every pixel is within
 * tolerance of both extremes when the extremes are two apart — so it is excluded
 * here rather than by tuning the ratio.
 */
const MIN_CELL_RANGE = 70;

/**
 * Horizontal reach of the morphological close, in cells.
 *
 * Bridges the gaps inside and between words so a line of type becomes one
 * component. Generous horizontally and mean vertically, because that asymmetry
 * *is* the shape of text: joining across a word gap is right, joining across a
 * line gap merges a headline into the paragraph beneath it.
 */
const CLOSE_X = 4;
const CLOSE_Y = 1;

/**
 * How far along its row a cell looks for company, and how much it needs.
 *
 * Three cells either side is about one character at the grid's scale, so a cell
 * inside any real word finds support easily while an isolated speck of
 * photographic detail does not. See `requireRowSupport`.
 */
const ROW_SUPPORT_WINDOW = 3;
const MIN_ROW_SUPPORT = 2;

/** Smallest share of the poster a block must cover to be reported. */
const MIN_BLOCK_AREA = 0.0006;

/** Below this a component is a stray mark rather than a line of type. */
const MIN_BLOCK_CELLS = 8;

/**
 * Tallest a block of type may be, as a share of the poster.
 *
 * A backstop rather than a discriminator. The classifier above is what keeps
 * photography out; this catches the residue — a component that has bridged
 * several unrelated regions is always far taller than any real block, and a
 * four-line headline, the tallest thing a poster legitimately sets as one block,
 * runs about a fifth of the height.
 */
const MAX_BLOCK_HEIGHT = 0.34;

/**
 * Most blocks one labelling call is asked to name.
 *
 * A poster carries six or seven blocks of type; the rest of what the detector
 * finds is photographic residue for the labeller to reject. Thirty leaves ample
 * room for both without turning one image into a page of numbered clutter the
 * model has to count its way through.
 */
const MAX_BLOCKS = 30;

export interface TextBlock {
  /** Normalised 0-1 against the reference's own width and height. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Cells in the component, for ranking and for the console to report. */
  cells: number;
  /** Mean luminance of the block's ink — dark type on light, or the reverse. */
  inkIsDark: boolean;
}

export interface TextDetection {
  width: number;
  height: number;
  blocks: TextBlock[];
  /** Cell grid dimensions, so a caller can render the mask for inspection. */
  gridWidth: number;
  gridHeight: number;
  /** The texty-cell mask after closing, row-major. Debug rendering only. */
  mask: Uint8Array;
}

/**
 * Measures every block of type on a reference.
 *
 * Returns blocks largest-first. Null when the image cannot be decoded, matching
 * `findPlateHoles`, because the caller's fallback is to leave the template as a
 * draft rather than to guess.
 */
export async function detectTextBlocks(bytes: Buffer): Promise<TextDetection | null> {
  let luma: Buffer;
  let width: number;
  let height: number;

  try {
    const decoded = await sharp(bytes, { limitInputPixels: MAX_PIXELS })
      .resize({ width: WORK_EDGE, height: WORK_EDGE, fit: 'inside', withoutEnlargement: true })
      /*
       * Flattened onto white before greyscale.
       *
       * A reference is normally opaque, but a plate is not, and this module is
       * run over both — see `findSurvivingText`. Without this, sharp reports the
       * raw colour under a transparent pixel, which is usually black, and the
       * erased hole reads as a solid dark block of "type".
       */
      .flatten({ background: '#ffffff' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    luma = decoded.data;
    width = decoded.info.width;
    height = decoded.info.height;
  } catch {
    return null;
  }

  if (width < CELL * 4 || height < CELL * 4) return null;

  const gridWidth = Math.floor(width / CELL);
  const gridHeight = Math.floor(height / CELL);
  const texty = new Uint8Array(gridWidth * gridHeight);

  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      if (cellHoldsType(luma, width, gx * CELL, gy * CELL)) {
        texty[gy * gridWidth + gx] = 1;
      }
    }
  }

  const coherent = requireRowSupport(texty, gridWidth, gridHeight);
  const closed = closeHorizontally(coherent, gridWidth, gridHeight);
  const boxes = components(closed, gridWidth, gridHeight);

  const blocks: TextBlock[] = [];
  for (const box of boxes) {
    if (box.cells < MIN_BLOCK_CELLS) continue;

    const w = ((box.x1 - box.x0 + 1) * CELL) / width;
    const h = ((box.y1 - box.y0 + 1) * CELL) / height;
    if (w * h < MIN_BLOCK_AREA) continue;
    if (h > MAX_BLOCK_HEIGHT) continue;

    blocks.push({
      x: (box.x0 * CELL) / width,
      y: (box.y0 * CELL) / height,
      w,
      h,
      cells: box.cells,
      inkIsDark: inkIsDarkIn(luma, width, height, box.x0, box.y0, box.x1, box.y1),
    });
  }

  blocks.sort((a, b) => b.cells - a.cells);

  return { width, height, blocks: prune(blocks), gridWidth, gridHeight, mask: closed };
}

/**
 * Drops the blocks not worth putting in front of a labeller.
 *
 * Deliberately light. The temptation is to filter hard here on size, and it does
 * not work: measured on a real reference, a patch of the model's face came back
 * larger than two genuine lines of contact detail. Size does not separate type
 * from photography — only looking at it does, which is the labeller's job.
 *
 * So this removes only what is uncontroversial: a box wholly inside another, and
 * the tail beyond what one labelling call can attend to. Everything else goes
 * forward and comes back `ignore`.
 */
function prune(blocks: TextBlock[]): TextBlock[] {
  const kept: TextBlock[] = [];

  for (const block of blocks) {
    // Blocks arrive largest-first, so anything a later block sits inside has
    // already been kept — one pass is enough.
    const swallowed = kept.some(
      (other) =>
        block.x >= other.x - 1e-9 &&
        block.y >= other.y - 1e-9 &&
        block.x + block.w <= other.x + other.w + 1e-9 &&
        block.y + block.h <= other.y + other.h + 1e-9,
    );
    if (!swallowed) kept.push(block);
    if (kept.length >= MAX_BLOCKS) break;
  }

  return kept;
}

/**
 * Whether one cell looks like type rather than artwork or photography.
 *
 * All three signals are computed in a single pass over the cell's pixels: the
 * cell is small and this runs tens of thousands of times.
 */
function cellHoldsType(luma: Buffer, width: number, x0: number, y0: number): boolean {
  let min = 255;
  let max = 0;
  let edges = 0;
  let count = 0;

  for (let y = y0; y < y0 + CELL; y += 1) {
    for (let x = x0; x < x0 + CELL; x += 1) {
      const value = luma[y * width + x] ?? 0;
      count += 1;
      if (value < min) min = value;
      if (value > max) max = value;

      // Four-neighbour gradient, right and down only — each edge is then counted
      // once rather than twice, and the two directions together still catch a
      // vertical stem and a horizontal bar.
      const right = luma[y * width + x + 1];
      const down = luma[(y + 1) * width + x];
      if (
        (right !== undefined && Math.abs(value - right) >= EDGE_DELTA) ||
        (down !== undefined && Math.abs(value - down) >= EDGE_DELTA)
      ) {
        edges += 1;
      }
    }
  }

  if (count === 0) return false;

  const range = max - min;
  if (range < MIN_CELL_RANGE) return false;

  const edgeShare = edges / count;
  if (edgeShare < MIN_EDGE_SHARE || edgeShare > MAX_EDGE_SHARE) return false;

  // Bimodality: how much of the cell sits at one extreme or the other.
  const tolerance = range * MODE_TOLERANCE_SHARE;
  let atExtremes = 0;
  for (let y = y0; y < y0 + CELL; y += 1) {
    for (let x = x0; x < x0 + CELL; x += 1) {
      const value = luma[y * width + x] ?? 0;
      if (value - min <= tolerance || max - value <= tolerance) atExtremes += 1;
    }
  }

  return atExtremes / count >= MIN_BIMODALITY;
}

/**
 * Drops texty cells that have no neighbours along their own row.
 *
 * **The signal that separates type from photographic detail, and the one the
 * statistics say is needed.** Probing a real reference, the three per-cell gates
 * reject flat artwork completely and photography well — but 13% of the doctor
 * still passes, on hair, coat folds and the stethoscope. Those survivors are
 * scattered; the close then bridges them into a web that reaches the feature
 * text beside them, and the whole thing becomes one component too tall to be
 * type, so the real text is discarded along with the photograph.
 *
 * Letters do not occur alone. A cell holding type sits in a run of cells holding
 * type, because that is what a word is. Requiring that support before the close
 * removes the scattered survivors while leaving every line of text untouched —
 * and it has to run *before* the close, since the close is what would otherwise
 * manufacture the support it is testing for.
 */
function requireRowSupport(
  cells: Uint8Array,
  gridWidth: number,
  gridHeight: number,
): Uint8Array {
  const kept = new Uint8Array(cells.length);

  for (let y = 0; y < gridHeight; y += 1) {
    for (let x = 0; x < gridWidth; x += 1) {
      if (!cells[y * gridWidth + x]) continue;

      let support = 0;
      for (let dx = -ROW_SUPPORT_WINDOW; dx <= ROW_SUPPORT_WINDOW; dx += 1) {
        if (dx === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= gridWidth) continue;
        if (cells[y * gridWidth + nx]) support += 1;
      }

      if (support >= MIN_ROW_SUPPORT) kept[y * gridWidth + x] = 1;
    }
  }

  return kept;
}

/**
 * Morphological close on the cell grid: dilate, then erode, by the same reach.
 *
 * Dilating alone would inflate every block by the reach on all sides — the same
 * mistake the eraser's padded rectangles make. The erode puts the boundary back
 * where it was, having first bridged the gaps inside it.
 */
function closeHorizontally(
  cells: Uint8Array,
  gridWidth: number,
  gridHeight: number,
): Uint8Array {
  const dilated = new Uint8Array(cells.length);

  for (let y = 0; y < gridHeight; y += 1) {
    for (let x = 0; x < gridWidth; x += 1) {
      if (!cells[y * gridWidth + x]) continue;
      for (let dy = -CLOSE_Y; dy <= CLOSE_Y; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= gridHeight) continue;
        for (let dx = -CLOSE_X; dx <= CLOSE_X; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= gridWidth) continue;
          dilated[ny * gridWidth + nx] = 1;
        }
      }
    }
  }

  const eroded = new Uint8Array(cells.length);
  for (let y = 0; y < gridHeight; y += 1) {
    for (let x = 0; x < gridWidth; x += 1) {
      if (!dilated[y * gridWidth + x]) continue;

      let solid = true;
      for (let dy = -CLOSE_Y; dy <= CLOSE_Y && solid; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= gridHeight) continue;
        for (let dx = -CLOSE_X; dx <= CLOSE_X; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= gridWidth) continue;
          if (!dilated[ny * gridWidth + nx]) {
            solid = false;
            break;
          }
        }
      }
      if (solid) eroded[y * gridWidth + x] = 1;
    }
  }

  return eroded;
}

interface CellBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cells: number;
}

/**
 * Connected components over the cell grid.
 *
 * Iterative with an explicit stack, for the reason `findPlateHoles` gives: a
 * headline spanning half a poster is thousands of cells deep and recursion would
 * blow the call stack. Eight-connected here, where the hole finder is four —
 * a diagonal cell of a serif or an italic belongs to the same line of type,
 * whereas two holes touching at a corner are genuinely two holes.
 */
function components(cells: Uint8Array, gridWidth: number, gridHeight: number): CellBox[] {
  const visited = new Uint8Array(cells.length);
  const boxes: CellBox[] = [];
  const stack: number[] = [];

  for (let seed = 0; seed < cells.length; seed += 1) {
    if (visited[seed] || !cells[seed]) continue;

    let x0 = gridWidth;
    let y0 = gridHeight;
    let x1 = -1;
    let y1 = -1;
    let count = 0;

    stack.push(seed);
    visited[seed] = 1;

    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % gridWidth;
      const y = (index - x) / gridWidth;

      count += 1;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;
          const next = ny * gridWidth + nx;
          if (visited[next] || !cells[next]) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }
    }

    boxes.push({ x0, y0, x1, y1, cells: count });
  }

  return boxes;
}

/**
 * Whether a block's ink is darker than its surface.
 *
 * The minority population is the ink: letterforms never outweigh the space they
 * are set on. Reported so a caller can tell white-on-dark from dark-on-white
 * without a second pass over the pixels.
 */
function inkIsDarkIn(
  luma: Buffer,
  width: number,
  height: number,
  gx0: number,
  gy0: number,
  gx1: number,
  gy1: number,
): boolean {
  const x0 = gx0 * CELL;
  const y0 = gy0 * CELL;
  const x1 = Math.min((gx1 + 1) * CELL, width);
  const y1 = Math.min((gy1 + 1) * CELL, height);

  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      sum += luma[y * width + x] ?? 0;
      count += 1;
    }
  }
  if (count === 0) return true;

  const mean = sum / count;
  let darker = 0;
  let lighter = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if ((luma[y * width + x] ?? 0) < mean) darker += 1;
      else lighter += 1;
    }
  }

  return darker < lighter;
}
