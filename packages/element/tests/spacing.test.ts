import { fixedGap, spaceBetween } from "@excalidraw/element";

import type { BoundingBox } from "@excalidraw/element";

/**
 * A bounding box of a box laid out on the x axis, built the same way
 * `getCommonBoundingBox` builds it.
 */
const boxAt = (minX: number, width: number): BoundingBox => {
  const maxX = minX + width;

  return {
    minX,
    maxX,
    midX: (minX + maxX) / 2,
    width,
    minY: 0,
    maxY: 0,
    midY: 0,
    height: 0,
  };
};

/** The leading edge of every box after the offsets are applied. */
const positions = (boxes: BoundingBox[], offsets: number[]) =>
  boxes.map((box, index) => box.minX + offsets[index]);

describe("spaceBetween", () => {
  it("spreads boxes evenly across the extent they already occupy", () => {
    const boxes = [boxAt(0, 100), boxAt(10, 100), boxAt(300, 100)];

    expect(positions(boxes, spaceBetween(boxes, "x"))).toEqual([0, 150, 300]);
  });

  it("spreads boxes of unequal size so the gaps are equal", () => {
    const boxes = [boxAt(0, 100), boxAt(120, 50), boxAt(198, 80)];

    expect(positions(boxes, spaceBetween(boxes, "x"))).toEqual([0, 124, 198]);
  });

  it("leaves the boxes alone when they already have equal gaps", () => {
    const boxes = [boxAt(0, 100), boxAt(124, 50), boxAt(198, 80)];

    expect(spaceBetween(boxes, "x")).toEqual([0, 0, 0]);
  });

  it("spaces centers instead when the boxes do not fit in the extent", () => {
    const boxes = [boxAt(0, 100), boxAt(10, 200), boxAt(200, 100)];

    expect(positions(boxes, spaceBetween(boxes, "x"))).toEqual([0, 50, 200]);
  });

  it("keeps the boxes that own the extent in place in the center fallback", () => {
    // in center order: b, a, c — but a owns the left edge, so the first box in
    // order is the one that moves
    const boxes = [boxAt(30, 100), boxAt(0, 200), boxAt(100, 200)];

    expect(positions(boxes, spaceBetween(boxes, "x"))).toEqual([100, 0, 100]);
  });
});

describe("fixedGap", () => {
  it("puts the asked-for gap between boxes of unequal size", () => {
    const boxes = [boxAt(0, 100), boxAt(120, 50), boxAt(198, 80)];

    expect(positions(boxes, fixedGap(boxes, "x", 24))).toEqual([0, 124, 198]);
  });

  it("makes the boxes touch on a gap of zero", () => {
    const boxes = [boxAt(0, 100), boxAt(120, 50), boxAt(198, 80)];

    expect(positions(boxes, fixedGap(boxes, "x", 0))).toEqual([0, 100, 150]);
  });

  it("pulls apart boxes that start out overlapping", () => {
    const boxes = [boxAt(0, 200), boxAt(30, 100), boxAt(100, 200)];

    expect(positions(boxes, fixedGap(boxes, "x", 10))).toEqual([0, 210, 320]);
  });

  it("never moves the first box, even when it is not the leftmost", () => {
    // the first box in order starts to the right of the second one
    const boxes = [boxAt(30, 100), boxAt(0, 200), boxAt(100, 200)];
    const offsets = fixedGap(boxes, "x", 10);

    expect(offsets[0]).toEqual(0);
    expect(positions(boxes, offsets)).toEqual([30, 140, 350]);
  });

  it("agrees with spaceBetween when the gap is the one it would pick", () => {
    const boxes = [boxAt(0, 100), boxAt(120, 50), boxAt(198, 80)];

    expect(fixedGap(boxes, "x", 24)).toEqual(spaceBetween(boxes, "x"));
  });
});
