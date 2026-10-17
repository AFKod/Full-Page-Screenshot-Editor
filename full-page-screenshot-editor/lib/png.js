// PNG RGB8 writer. One continuous zlib stream spans all IDAT chunks.
// It consumes complete scanlines incrementally; no full-image RGBA buffer is needed.
const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

export function pngChunk(type, data = new Uint8Array()) {
  if (!/^[a-zA-Z]{4}$/.test(type)) throw new Error("Некорректный тип PNG-блока.");
  const bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < bytes.length - 4; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}

export function pngHeader(width, height) {
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 0x7fffffff)) throw new Error("Некорректные размеры PNG.");
  const data = new Uint8Array(13), view = new DataView(data.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  data[8] = 8; data[9] = 2; // 8-bit RGB, standard deflate, no interlace.
  return pngChunk("IHDR", data);
}

export async function encodePNG(width, height, rowBlocks, signal) {
  signal?.throwIfAborted();
  const chunks = [signature, pngHeader(width, height), pngChunk("sRGB", new Uint8Array([0]))];
  const rowBytes = width * 3 + 1, expectedBytes = rowBytes * height;
  if (!Number.isSafeInteger(expectedBytes)) throw new Error("Размер PNG превышает поддерживаемый диапазон.");
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter(), reader = stream.readable.getReader();
  const abort = () => {
    void writer.abort(signal.reason).catch(() => {});
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  // Drain concurrently with writes, otherwise compression backpressure can deadlock.
  const collecting = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      signal?.throwIfAborted();
      if (value.length) chunks.push(pngChunk("IDAT", value));
    }
  })();
  collecting.catch(error => { void writer.abort(error).catch(() => {}); });
  let consumed = 0;
  try {
    for await (const block of rowBlocks) {
      signal?.throwIfAborted();
      if (!(block instanceof Uint8Array) || !block.length || block.length % rowBytes) throw new Error("PNG получил неполные строки изображения.");
      consumed += block.length;
      if (consumed > expectedBytes) throw new Error("PNG получил лишние строки изображения.");
      await writer.write(block);
    }
    if (consumed !== expectedBytes) throw new Error("PNG получил не все строки изображения.");
    await writer.close(); await collecting;
    signal?.throwIfAborted();
    chunks.push(pngChunk("IEND"));
    return new Blob(chunks, { type: "image/png" });
  } catch (error) {
    await Promise.allSettled([writer.abort(error), reader.cancel(error), collecting]);
    chunks.length = 0;
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    writer.releaseLock(); reader.releaseLock();
  }
}
