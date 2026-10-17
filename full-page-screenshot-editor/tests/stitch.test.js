import test from "node:test";
import assert from "node:assert/strict";
import { inferPixelScale, ownedRegion, planAxis, drawMapping, intersect } from "../lib/geometry.js";
import { buildStitchPlan, contentPixelExtent } from "../lib/stitch.js";

function framesFor(width, height, viewportWidth, viewportHeight, scale, clipX = 0, clipY = 0) {
  const xs = planAxis(width, viewportWidth), ys = planAxis(height, viewportHeight);
  const frames = ys.flatMap((y, row) => xs.map((x, col) => ({ index: row * xs.length + col,
    originX: Math.round(x * scale), originY: Math.round(y * scale),
    pixelWidth: Math.round(viewportWidth * scale) - clipX, pixelHeight: Math.round(viewportHeight * scale) - clipY })));
  return { frames, columns: xs.length, rows: ys.length, xs, ys };
}

function assertCovered(plan) {
  let area = 0;
  for (const frame of plan.frames) {
    const mapping = drawMapping(frame, frame.region);
    assert(mapping.sx >= 0 && mapping.sy >= 0);
    assert(mapping.sx + mapping.width <= frame.pixelWidth);
    assert(mapping.sy + mapping.height <= frame.pixelHeight);
    area += frame.region.width * frame.region.height;
  }
  assert.equal(area, plan.width * plan.height);
}

test("Windows 150% regression: one rounded physical row cannot invalidate the entire long page", () => {
  const scale = 1.5, width = 1280, height = 18001, viewportHeight = 901;
  const grid = framesFor(width, height, width, viewportHeight, scale, 0, 1);
  const last = grid.frames.at(-1);
  const oldRegion = ownedRegion(0, grid.ys.at(-1), width, height, scale, scale);
  assert(oldRegion.y + oldRegion.height - last.originY > last.pixelHeight, "Fixture must reproduce the v1.0.0 bounds error");
  const plan = buildStitchPlan(grid.frames, grid.columns, grid.rows, width, height, scale);
  assert.equal(plan.width, 1920); assert.equal(plan.height, 27001);
  assert.deepEqual(plan.edgeAdjustment, { right: 0, bottom: 1 });
  assertCovered(plan);
  // Geometry recorded from a real pipl.io capture at DPR 1.5, Chrome zoom 100%.
  const pipl = framesFor(2560, 11211, 2560, 1353, 1.5);
  pipl.frames.at(-1).originY = Math.round(9857.3330078125 * 1.5);
  pipl.frames.at(-1).pixelHeight = 2030;
  assert.equal(Math.round(11211 * 1.5) - pipl.frames.at(-1).originY, 2031);
  const piplPlan = buildStitchPlan(pipl.frames, pipl.columns, pipl.rows, 2560, 11211, 1.5);
  assert.equal(piplPlan.height, 16816); assertCovered(piplPlan);
});

test("rounded 4K viewport keeps the actual DPR rather than accumulating width-ratio drift", () => {
  assert.equal(inferPixelScale(3840, 2010, 2561, 1340, { dpr: 1.5, viewportWidth: 2544, viewportHeight: 1340 }), 1.5);
  assert.equal(inferPixelScale(3840, 2010, 2561, 1340), 3840 / 2561);
});

test("scale detection handles included and excluded classic scrollbar gutters", () => {
  const metrics = { dpr: 1.5, viewportWidth: 1263, viewportHeight: 883 };
  assert.equal(inferPixelScale(1920, 1350, 1280, 900, metrics), 1.5);
  assert.equal(inferPixelScale(1895, 1325, 1280, 900, metrics), 1.5);
  assert.throws(() => inferPixelScale(1920, 1100, 1280, 900, metrics), /Геометрия/);
});

test("fractional visual viewport recovers the row hidden by CSS integer rounding", () => {
  assert.equal(contentPixelExtent(1351, 900, 900.6, 1.5), 1351);
  assert.equal(contentPixelExtent(1350, 900, 900.6, 1.5), 1350);
  assert.equal(contentPixelExtent(1920, 1263, 1280, 1.5), 1895);
});

test("fractional scale and rounding matrix covers each output pixel exactly once", () => {
  for (const scale of [0.8, 1, 1.1, 1.25, 1.5, 1.65, 1.75, 1.875, 2, 2.25, 2.625, 3]) {
    for (const height of [3501, 18001, 100003]) for (const clip of [0, 1, 2]) {
      const width = 2603, grid = framesFor(width, height, 1277, 903, scale, clip, clip);
      const plan = buildStitchPlan(grid.frames, grid.columns, grid.rows, width, height, scale);
      assertCovered(plan);
      const firstRow = plan.frames.slice(0, grid.columns);
      for (let i = 1; i < firstRow.length; i++) assert.equal(intersect(firstRow[i - 1].region, firstRow[i].region), null);
    }
  }
});

test("interior gaps and materially missing bottom content remain errors", () => {
  const grid = framesFor(1280, 18001, 1280, 901, 1.5);
  grid.frames[0].pixelHeight = 100;
  assert.throws(() => buildStitchPlan(grid.frames, grid.columns, grid.rows, 1280, 18001, 1.5), /пропуск/);
  grid.frames[0].pixelHeight = 1352;
  grid.frames.at(-1).pixelHeight -= 100;
  assert.throws(() => buildStitchPlan(grid.frames, grid.columns, grid.rows, 1280, 18001, 1.5), error => /край страницы/.test(error.message) && error.details.edgeAdjustment.bottom > 4);
});

test("adjacent columns with one-pixel scroll quantization still form a shared valid boundary", () => {
  const grid = framesFor(2603, 3501, 1277, 903, 1.5);
  grid.frames[grid.columns + 1].originX += 1;
  grid.frames[grid.columns + 1].originY += 1;
  const plan = buildStitchPlan(grid.frames, grid.columns, grid.rows, 2603, 3501, 1.5);
  assertCovered(plan);
  assert.equal(plan.frames[1].region.x, plan.frames[grid.columns + 1].region.x);
});
