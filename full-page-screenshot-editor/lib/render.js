import { drawMapping, intersect } from "./geometry.js";
import { getFrame } from "./db.js";

export function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) { releaseCanvas(canvas); throw new Error("Недостаточно памяти для Canvas. Выберите меньшую область."); }
  return { canvas, context };
}

export function releaseCanvas(canvas) { canvas.width = 1; canvas.height = 1; }

// Decodes only one viewport at a time; never allocates a full-page canvas.
export async function renderRegion(capture, rect, context, scale = 1, signal, onProgress) {
  const frames = capture.frames.filter(frame => intersect(frame.region, rect));
  context.save();
  try {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, context.canvas.width, context.canvas.height);
    context.imageSmoothingEnabled = scale !== 1;
    for (let i = 0; i < frames.length; i++) {
      signal?.throwIfAborted();
      const frame = frames[i], mapping = drawMapping(frame, rect);
      const stored = await getFrame(capture.id, frame.index);
      signal?.throwIfAborted();
      if (!stored?.blob) throw new Error("Кадр удалён из локального хранилища. Сделайте снимок заново.");
      const bitmap = await createImageBitmap(stored.blob);
      try {
        signal?.throwIfAborted();
        const { sx, sy, dx, dy, width, height } = mapping;
        // Round destination boundaries separately when rendering a reduced preview.
        const x = Math.round(dx * scale), y = Math.round(dy * scale);
        context.drawImage(bitmap, sx, sy, width, height, x, y,
          Math.round((dx + width) * scale) - x, Math.round((dy + height) * scale) - y);
      } finally { bitmap.close(); }
      onProgress?.((i + 1) / frames.length);
    }
    // Force allocation/readback now; surface lost/unsupported canvases as a real error.
    if (context.isContextLost?.()) throw new Error("Canvas потерял контекст. Закройте лишние вкладки или выберите меньшую область.");
  } finally { context.restore(); }
}

export function encodeCanvas(canvas, type) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Chrome не смог закодировать Canvas. Попробуйте меньшую область.")), type, 0.94);
  });
}
