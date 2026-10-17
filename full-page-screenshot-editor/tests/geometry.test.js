import test from "node:test";
import assert from "node:assert/strict";
import { planAxis, ownedRegion, drawMapping, normalizeRect, resizeRect, moveRect, splitRect, intersect, clientToImage, captureDelay, inferPixelScale } from "../lib/geometry.js";

test("scroll planning includes both edges without duplicate final frames", () => {
  assert.deepEqual(planAxis(400, 800), [0]);
  assert.deepEqual(planAxis(800, 800), [0]);
  assert.deepEqual(planAxis(1700, 800, 100), [0, 700, 900]);
  assert.deepEqual(planAxis(801, 800), [0, 1]);
  assert.throws(() => planAxis(100, 0));
});

test("fractional DPR ownership is contiguous and covers every output pixel", () => {
  for (const scale of [0.8, 1, 1.1, 1.25, 1.5, 2, 2.625, 3]) {
    for (const total of [805, 2517.5, 10201]) {
      const positions = planAxis(total, 803.2);
      let bottom = 0;
      for (let i = 0; i < positions.length; i++) {
        const region = ownedRegion(0, positions[i], 1001, positions[i + 1] ?? total, scale, scale);
        assert.equal(region.y, bottom);
        assert(region.height > 0);
        assert(region.height <= Math.ceil(803.2 * scale));
        bottom += region.height;
      }
      assert.equal(bottom, Math.round(total * scale));
    }
  }
});

test("crop across frame seams maps source pixels into exact destination positions", () => {
  const frame = { originX: 0, originY: 900, region: { x: 0, y: 900, width: 1200, height: 750 } };
  assert.deepEqual(drawMapping(frame, { x: 110, y: 850, width: 300, height: 100 }), {
    sx: 110, sy: 0, dx: 0, dy: 50, width: 300, height: 50
  });
  assert.equal(drawMapping(frame, { x: 0, y: 1650, width: 100, height: 100 }), null);
});

test("reverse drawing, integer boundaries and out-of-bounds clamping", () => {
  assert.deepEqual(normalizeRect({ x: 90.8, y: 80.4 }, { x: -2, y: 40.2 }, 100, 100), { x: 0, y: 40, width: 91, height: 40 });
  assert.deepEqual(normalizeRect({ x: 3, y: 4 }, { x: 3, y: 4 }, 100, 100), { x: 3, y: 4, width: 0, height: 0 });
});

test("move and crossed resize handles preserve valid bounds", () => {
  const rect = { x: 10, y: 20, width: 30, height: 40 }, bounds = { width: 100, height: 100 };
  assert.deepEqual(moveRect(rect, -500, 500, bounds), { x: 0, y: 60, width: 30, height: 40 });
  assert.deepEqual(resizeRect(rect, "nw", 50, 60, bounds), { x: 40, y: 60, width: 20, height: 20 });
  assert.deepEqual(resizeRect(rect, "se", 500, 500, bounds), { x: 10, y: 20, width: 90, height: 80 });
});

test("screen coordinates at all zooms resolve to the same original pixels after crop", () => {
  const view = { x: 1100, y: 2200, width: 3000, height: 8000 };
  for (const scale of [0.1, 0.25, 0.5, 1, 1.5, 3]) {
    assert.deepEqual(clientToImage(50 + 300 * scale, -1000 + 1700 * scale, { left: 50, top: -1000 }, scale, view), { x: 1400, y: 3900 });
  }
});

test("large two-dimensional export parts cover exact area with no overlap or reduction", () => {
  const rect = { x: 33, y: 79, width: 19001, height: 100001 }, parts = splitRect(rect);
  assert(parts.length > 1);
  let pixels = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]; pixels += part.width * part.height;
    assert(part.width <= 8192 && part.height <= 8192);
    assert(part.width * part.height <= 16 * 1024 * 1024);
    assert.deepEqual(intersect(part, rect), { x: part.x, y: part.y, width: part.width, height: part.height });
    for (let j = i + 1; j < parts.length; j++) assert.equal(intersect(part, parts[j]), null);
  }
  assert.equal(pixels, rect.width * rect.height);
  assert.throws(() => splitRect({ ...rect, width: 0 }));
});

test("small export stays a single original-resolution file", () => {
  assert.deepEqual(splitRect({ x: 19, y: 30000, width: 300, height: 700 }), [{ x: 19, y: 30000, width: 300, height: 700, row: 0, col: 0 }]);
});

test("capture scheduling allows at most two calls per rolling second", () => {
  let last = -Infinity;
  const starts = [];
  for (const now of [0, 1, 701, 710, 750, 3000]) {
    const start = Math.max(last, now) + captureDelay(last, Math.max(last, now));
    starts.push(start); last = start;
  }
  for (let i = 2; i < starts.length; i++) assert(starts[i] - starts[i - 2] >= 1000);
});

test("fractional physical viewport height never shrinks the full-page vertical scale", () => {
  assert.equal(inferPixelScale(1600, 1143, 1280, 915), 1.25);
  assert.equal(inferPixelScale(1600, 1144, 1024, 732), 1.5625);
  assert.throws(() => inferPixelScale(1600, 813, 1280, 900), /Геометрия/);
});
