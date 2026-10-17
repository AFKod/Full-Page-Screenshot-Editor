// All editor geometry is in original bitmap pixels. CSS pixels are used only during capture.
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function planAxis(total, viewport, overlap = 64) {
  if (![total, viewport, overlap].every(Number.isFinite) || total <= 0 || viewport <= 0 || overlap < 0) {
    throw new Error("Некорректные размеры страницы.");
  }
  const end = Math.max(0, total - viewport);
  const step = Math.max(1, viewport - Math.min(overlap, viewport / 3));
  const positions = [0];
  while (positions.at(-1) < end) {
    if (positions.length > 10000) throw new Error("Слишком много кадров.");
    positions.push(Math.min(end, positions.at(-1) + step));
  }
  return positions;
}

export function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export function normalizeRect(a, b, width, height) {
  const x1 = clamp(Math.round(Math.min(a.x, b.x)), 0, width);
  const y1 = clamp(Math.round(Math.min(a.y, b.y)), 0, height);
  const x2 = clamp(Math.round(Math.max(a.x, b.x)), 0, width);
  const y2 = clamp(Math.round(Math.max(a.y, b.y)), 0, height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function moveRect(rect, dx, dy, bounds) {
  return { ...rect, x: clamp(Math.round(rect.x + dx), 0, bounds.width - rect.width),
    y: clamp(Math.round(rect.y + dy), 0, bounds.height - rect.height) };
}

export function resizeRect(rect, handle, dx, dy, bounds) {
  const a = { x: rect.x, y: rect.y }, b = { x: rect.x + rect.width, y: rect.y + rect.height };
  if (handle.includes("w")) a.x += dx;
  if (handle.includes("e")) b.x += dx;
  if (handle.includes("n")) a.y += dy;
  if (handle.includes("s")) b.y += dy;
  return normalizeRect(a, b, bounds.width, bounds.height);
}

// Shared rounded boundaries avoid one-pixel seams at fractional DPR/Chrome zoom.
export function ownedRegion(x, y, nextX, nextY, scaleX, scaleY) {
  const left = Math.round(x * scaleX), top = Math.round(y * scaleY);
  return { x: left, y: top, width: Math.round(nextX * scaleX) - left,
    height: Math.round(nextY * scaleY) - top };
}

export function drawMapping(frame, rect) {
  const area = intersect(frame.region, rect);
  if (!area) return null;
  return { sx: area.x - frame.originX, sy: area.y - frame.originY,
    dx: area.x - rect.x, dy: area.y - rect.y, width: area.width, height: area.height };
}

// Conservative allocation budget, far below Chrome's platform-dependent maximum canvas size.
export function splitRect(rect, maxEdge = 8192, maxPixels = 16 * 1024 * 1024) {
  if (!Number.isSafeInteger(rect.width) || !Number.isSafeInteger(rect.height) || rect.width < 1 || rect.height < 1 || maxEdge < 1 || maxPixels < 1) {
    throw new Error("Пустое или некорректное изображение.");
  }
  const tileWidth = Math.min(rect.width, maxEdge, maxPixels);
  const tileHeight = Math.max(1, Math.min(maxEdge, Math.floor(maxPixels / tileWidth)));
  const parts = [];
  for (let y = 0; y < rect.height; y += tileHeight) {
    for (let x = 0; x < rect.width; x += tileWidth) {
      parts.push({ x: rect.x + x, y: rect.y + y, width: Math.min(tileWidth, rect.width - x),
        height: Math.min(tileHeight, rect.height - y), row: Math.floor(y / tileHeight), col: Math.floor(x / tileWidth) });
    }
  }
  return parts;
}

export function clientToImage(clientX, clientY, domRect, scale, view) {
  return { x: clamp((clientX - domRect.left) / scale + view.x, view.x, view.x + view.width),
    y: clamp((clientY - domRect.top) / scale + view.y, view.y, view.y + view.height) };
}

export function captureDelay(lastStart, now, interval = 650) {
  return Math.max(0, interval - (now - lastStart));
}

export function inferPixelScale(bitmapWidth, bitmapHeight, innerWidth, innerHeight, viewport = {}) {
  if (![bitmapWidth, bitmapHeight, innerWidth, innerHeight].every(n => Number.isFinite(n) && n > 0)) throw new Error("Некорректный размер кадра.");
  const widths = [...new Set([innerWidth, viewport.viewportWidth].filter(n => Number.isFinite(n) && n > 0))];
  const heights = [...new Set([innerHeight, viewport.viewportHeight].filter(n => Number.isFinite(n) && n > 0))];
  const tolerance = scale => Math.ceil(scale) + 1;
  // innerWidth/Height are rounded CSS integers. At Windows 150%, a PNG width of
  // 3840 and innerWidth of 2561 must not turn the true 1.5 scale into 1.499414.
  // Prefer the stable device scale when BOTH bitmap axes corroborate it. Include
  // client extents because capture backends can omit classic scrollbar gutters.
  if (Number.isFinite(viewport.dpr) && viewport.dpr > 0 &&
      widths.some(width => Math.abs(bitmapWidth - width * viewport.dpr) <= tolerance(viewport.dpr)) &&
      heights.some(height => Math.abs(bitmapHeight - height * viewport.dpr) <= tolerance(viewport.dpr))) return viewport.dpr;
  let best;
  for (const width of widths) for (const height of heights) {
    const scale = bitmapWidth / width, error = Math.abs(bitmapHeight - height * scale);
    if (!best || error < best.error) best = { scale, error };
  }
  if (best.error > tolerance(best.scale)) throw new Error("Геометрия кадра не совпала с viewport. Отключите эмуляцию устройств в DevTools и повторите захват.");
  return best.scale;
}
