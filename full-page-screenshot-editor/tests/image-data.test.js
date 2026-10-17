import test from "node:test";
import assert from "node:assert/strict";
import { pngDataURLToBlob } from "../lib/image-data.js";

test("Chrome PNG data URL is decoded byte-for-byte without fetch under strict CSP", async () => {
  const bytes = Uint8Array.from([137, 80, 78, 71, 0, 255, 13, 10]);
  const blob = pngDataURLToBlob(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
  assert.equal(blob.type, "image/png");
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  assert.throws(() => pngDataURLToBlob("https://example.com/image.png"));
  assert.throws(() => pngDataURLToBlob("data:image/png;base64,***"));
});
