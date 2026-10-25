import test from "node:test";
import assert from "node:assert/strict";
import { average, discountedPrice, clamp } from "./math.js";

test("average returns the arithmetic mean", () => {
  assert.equal(average([2, 4, 6]), 4);
  assert.equal(average([5]), 5);
});
test("empty averages are rejected", () => assert.throws(() => average([]), /empty/));
test("discounts use a percentage", () => {
  assert.equal(discountedPrice(100, 20), 80);
  assert.equal(discountedPrice(50, 0), 50);
});
test("clamp respects both bounds and interior values", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(20, 0, 10), 10);
});
test("invalid clamp ranges are rejected", () => assert.throws(() => clamp(1, 10, 0), /range/));
