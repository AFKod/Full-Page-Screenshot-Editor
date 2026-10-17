import { createCanvas, releaseCanvas, renderRegion } from "./render.js";
import { encodePNG } from "./png.js";

export function stripeLayout(width, maxBytes = 4 * 1024 * 1024) {
  if (!Number.isSafeInteger(width) || width < 1) throw new Error("Некорректная ширина изображения.");
  const rowBytes = width * 3 + 1;
  return { rowBytes, rows: Math.max(1, Math.min(256, Math.floor(maxBytes / rowBytes))), tileWidth: Math.min(width, 8192) };
}

export function canExportJPEG(rect) {
  // JPEG still needs a native canvas encoder. PNG has no full-canvas dependency.
  return rect.width > 0 && rect.height > 0 && rect.width <= 32767 && rect.height <= 32767 && rect.width * rect.height <= 64 * 1024 * 1024;
}

export async function exportPNG(capture, rect, signal, onProgress) {
  const { rowBytes, rows, tileWidth } = stripeLayout(rect.width);
  async function* scanlines() {
    for (let y = 0; y < rect.height; y += rows) {
      signal?.throwIfAborted();
      const height = Math.min(rows, rect.height - y), raw = new Uint8Array(rowBytes * height);
      for (let x = 0; x < rect.width; x += tileWidth) {
        const width = Math.min(tileWidth, rect.width - x);
        const { canvas, context } = createCanvas(width, height);
        try {
          await renderRegion(capture, { x: rect.x + x, y: rect.y + y, width, height }, context, 1, signal);
          signal?.throwIfAborted();
          const rgba = context.getImageData(0, 0, width, height).data;
          for (let row = 0; row < height; row++) {
            let source = row * width * 4, target = row * rowBytes + 1 + x * 3;
            for (let col = 0; col < width; col++) {
              raw[target++] = rgba[source++]; raw[target++] = rgba[source++]; raw[target++] = rgba[source++]; source++;
            }
          }
        } finally { releaseCanvas(canvas); }
      }
      // Prefix byte of each scanline remains 0 (PNG filter None).
      yield raw;
      onProgress?.((y + height) / rect.height);
    }
  }
  return encodePNG(rect.width, rect.height, scanlines(), signal);
}
