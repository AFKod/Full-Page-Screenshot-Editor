import { drawMapping } from "./geometry.js";

function geometryError(message, details) {
  const error = new Error(message);
  error.details = details;
  return error;
}

export function contentPixelExtent(bitmapExtent, clientExtent, visualExtent, scale) {
  // visualViewport retains the fractional CSS extent discarded by clientWidth/Height.
  // A larger difference can be a reserved scrollbar gutter; keep the client extent then.
  const extent = Number.isFinite(visualExtent) && visualExtent > 0 && Math.abs(visualExtent - clientExtent) <= 1
    ? visualExtent : clientExtent;
  return Math.min(bitmapExtent, Math.round(extent * scale));
}

// Partition the union of captured pixel rectangles; never stretch a source bitmap.
// Interior boundaries must be covered by the adjacent frames. Only the outer right/
// bottom estimate may be shortened by the bounded CSS/physical-pixel rounding error.
export function buildStitchPlan(frames, columns, rows, cssWidth, cssHeight, scale) {
  if (!Number.isInteger(columns) || columns < 1 || !Number.isInteger(rows) || rows < 1 || frames.length !== columns * rows) {
    throw geometryError("Неполная сетка кадров. Повторите захват.", { columns, rows, frames: frames.length });
  }
  const xs = Array.from({ length: columns }, (_, col) => Math.max(...Array.from({ length: rows }, (_, row) => frames[row * columns + col].originX)));
  const ys = Array.from({ length: rows }, (_, row) => Math.max(...frames.slice(row * columns, (row + 1) * columns).map(frame => frame.originY)));
  const expectedWidth = Math.round(cssWidth * scale), expectedHeight = Math.round(cssHeight * scale);
  const availableRight = Math.min(...frames.filter((_, index) => index % columns === columns - 1).map(f => f.originX + f.pixelWidth));
  const availableBottom = Math.min(...frames.slice((rows - 1) * columns).map(f => f.originY + f.pixelHeight));
  const width = Math.min(expectedWidth, availableRight), height = Math.min(expectedHeight, availableBottom);
  const edgeAdjustment = { right: expectedWidth - width, bottom: expectedHeight - height };
  const tolerance = Math.ceil(scale) + 2;
  if (xs[0] !== 0 || ys[0] !== 0 || edgeAdjustment.right > tolerance || edgeAdjustment.bottom > tolerance) {
    throw geometryError("Кадры не покрывают край страницы. Размер viewport изменился или страница ограничила прокрутку. Повторите захват.",
      { expectedWidth, expectedHeight, availableRight, availableBottom, edgeAdjustment, tolerance, firstX: xs[0], firstY: ys[0] });
  }
  const planned = frames.map((frame, index) => {
    const col = index % columns, row = Math.floor(index / columns);
    const region = { x: xs[col], y: ys[row], width: (xs[col + 1] ?? width) - xs[col], height: (ys[row + 1] ?? height) - ys[row] };
    const plannedFrame = { ...frame, region }, mapping = drawMapping(plannedFrame, region);
    if (!mapping || mapping.sx < 0 || mapping.sy < 0 || mapping.sx + mapping.width > frame.pixelWidth || mapping.sy + mapping.height > frame.pixelHeight) {
      throw geometryError("Между кадрами обнаружен пропуск. Страница изменила положение или размер во время захвата. Повторите захват.",
        { index: frame.index, region, mapping, source: { x: frame.originX, y: frame.originY, width: frame.pixelWidth, height: frame.pixelHeight }, columns, rows });
    }
    return plannedFrame;
  });
  return { frames: planned, width, height, edgeAdjustment };
}
