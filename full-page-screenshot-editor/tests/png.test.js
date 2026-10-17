import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { encodePNG, pngChunk, pngHeader } from "../lib/png.js";
import { canExportJPEG, stripeLayout } from "../lib/export.js";

async function unpack(blob) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    let crc = 0xffffffff;
    // Independent bit-at-a-time implementation checks the table-based writer.
    for (const byte of bytes.subarray(offset + 4, offset + 8 + length)) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
    }
    assert.equal(bytes.readUInt32BE(offset + 8 + length), (crc ^ 0xffffffff) >>> 0, `CRC of ${type}`);
    chunks.push({ type, data }); offset += length + 12;
  }
  return { chunks, raw: inflateSync(Buffer.concat(chunks.filter(c => c.type === "IDAT").map(c => c.data))) };
}

test("PNG stream round-trips exact RGB rows across input block boundaries", async () => {
  const width = 3, height = 7, rowBytes = width * 3 + 1, expected = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) expected.set([x * 41, y * 31, (x + y) * 17], y * rowBytes + 1 + x * 3);
  async function* blocks() { yield expected.subarray(0, rowBytes * 2); yield expected.subarray(rowBytes * 2); }
  const blob = await encodePNG(width, height, blocks());
  assert.equal(blob.type, "image/png");
  const { raw, chunks } = await unpack(blob);
  assert.deepEqual(raw, Buffer.from(expected));
  assert.equal(chunks[0].type, "IHDR"); assert.equal(chunks.at(-1).type, "IEND");
  assert.equal(chunks[0].data.readUInt32BE(0), width); assert.equal(chunks[0].data.readUInt32BE(4), height);
  assert.deepEqual([...chunks[0].data.subarray(8)], [8,2,0,0,0]);
  assert.equal(new DataView(pngChunk("IEND").buffer).getUint32(8), 0xae426082);
});

test("a PNG taller than canvas/JPEG limits keeps its full height in one file", async () => {
  async function* rows() {
    for (let y = 0; y < 70000; y += 1000) {
      const block = new Uint8Array(4000);
      for (let row = 0; row < 1000; row++) block.set([0, (y + row) & 255, 170, 85], row * 4);
      yield block;
    }
  }
  const { raw, chunks } = await unpack(await encodePNG(1, 70000, rows()));
  assert.equal(chunks[0].data.readUInt32BE(4), 70000);
  assert.equal(raw.length, 280000); assert.deepEqual([...raw.subarray(-4)], [0, 69999 & 255, 170, 85]);
});

test("one wide PNG supports multiple IDAT chunks with one valid deflate stream", async () => {
  const input = new Uint8Array((40000 * 3 + 1) * 2);
  let state = 1234567;
  for (let i = 0; i < input.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; input[i] = state >>> 24; }
  input[0] = input[120001] = 0;
  const { raw, chunks } = await unpack(await encodePNG(40000, 2, [input]));
  assert(chunks.filter(c => c.type === "IDAT").length > 1); assert.deepEqual(raw, Buffer.from(input));
});

test("PNG rejects incomplete input, producer errors and cancellation without a partial file", { timeout: 3000 }, async () => {
  await assert.rejects(encodePNG(1, 2, [new Uint8Array(4)]), /не все строки/);
  await assert.rejects(encodePNG(1, 1, [new Uint8Array(8)]), /лишние строки/);
  await assert.rejects(encodePNG(1, 1, [new Uint8Array(3)]), /неполные строки/);
  async function* failure() { yield new Uint8Array(4); throw new Error("frame unavailable"); }
  await assert.rejects(encodePNG(1, 2, failure()), /frame unavailable/);
  const controller = new AbortController();
  async function* cancelled() { yield new Uint8Array(4); controller.abort(); yield new Uint8Array(4); }
  await assert.rejects(encodePNG(1, 2, cancelled(), controller.signal), { name: "AbortError" });
  assert.throws(() => pngHeader(0, 10));
});

test("user's 3817×5413 crop and 3817×10190 original fit single JPEG; PNG stripe memory is bounded", () => {
  assert(canExportJPEG({ width:3817, height:5413 })); assert(canExportJPEG({ width:3817, height:10190 }));
  assert(!canExportJPEG({ width:3817, height:70000 }));
  for (const width of [64, 3817, 40000, 100000]) {
    const layout = stripeLayout(width);
    assert(layout.rows * layout.rowBytes <= 4 * 1024 * 1024);
    assert(layout.tileWidth <= 8192); assert(layout.rows >= 1);
  }
});
