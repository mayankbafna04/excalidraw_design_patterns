import type { AppState } from "@excalidraw/excalidraw/types";

import { updateBoundElements } from "./binding";
import { getCommonBoundingBox } from "./bounds";

import { getSelectedElementsByGroup } from "./groups";

import { getNonDeletedElements } from ".";

import type { Scene } from "./Scene";

import type { BoundingBox } from "./bounds";
import type { ElementsMap, NonDeletedExcalidrawElement } from "./types";

export type DistributionAxis = "x" | "y";

export type Distribution =
  /** equal gaps within the extent the selection already occupies */
  | { space: "between"; axis: DistributionAxis }
  /** the gap the user asked for, which may change that extent */
  | { space: "fixedGap"; axis: DistributionAxis; gap: number };

/**
 * One thing that moves as a whole: either a single element or every element of
 * a selected group, paired with the bounding box the spacing is measured on.
 */
export type SelectionUnit = readonly [
  group: readonly NonDeletedExcalidrawElement[],
  box: BoundingBox,
];

/**
 * The `BoundingBox` keys that describe the leading edge, center, trailing edge
 * and size along the given axis.
 */
const axisKeys = (axis: DistributionAxis) =>
  axis === "x"
    ? (["minX", "midX", "maxX", "width"] as const)
    : (["minY", "midY", "maxY", "height"] as const);

/**
 * Buckets the selection into the units that move together and puts them in the
 * spatial order the spacing rules walk, which is by the center of each unit's
 * bounding box along the axis.
 */
export const orderSelectionUnits = (
  selectedElements: NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  appState: Readonly<AppState>,
  axis: DistributionAxis,
): SelectionUnit[] => {
  const [, mid] = axisKeys(axis);

  return getSelectedElementsByGroup(selectedElements, elementsMap, appState)
    .map(getNonDeletedElements) // Nothing to distribute on deleted elements
    .map((group) => [group, getCommonBoundingBox(group)] as SelectionUnit)
    .sort((a, b) => a[1][mid] - b[1][mid]);
};

/**
 * The extent the boxes currently occupy along the axis. Equivalent to the
 * bounding box of the whole selection, since every selected element belongs to
 * exactly one unit.
 */
const commonExtent = (
  boxes: readonly BoundingBox[],
  axis: DistributionAxis,
): { start: number; end: number; extent: number } => {
  const [startKey, , endKey] = axisKeys(axis);

  let start = boxes[0][startKey];
  let end = boxes[0][endKey];

  for (const box of boxes) {
    start = Math.min(start, box[startKey]);
    end = Math.max(end, box[endKey]);
  }

  return { start, end, extent: end - start };
};

/**
 * Spreads the boxes across the extent they already occupy so that the gaps
 * between them are equal. When the boxes are too large to fit in that extent
 * the gaps would have to be negative, so it spaces the centers evenly instead
 * and leaves the two boxes that own the extent where they are.
 *
 * Returns one offset per box, in the order the boxes were given.
 */
export const spaceBetween = (
  boxes: readonly BoundingBox[],
  axis: DistributionAxis,
): number[] => {
  const [start, mid, end, extent] = axisKeys(axis);

  const bounds = commonExtent(boxes, axis);

  let span = 0;
  for (const box of boxes) {
    span += box[extent];
  }

  const step = (bounds.extent - span) / (boxes.length - 1);

  if (step < 0) {
    // If we have a negative step, we'll need to distribute from centers
    // rather than from gaps. Buckle up, this is a weird one.

    // Get indices of boxes that define start and end of our bounding box
    const index0 = boxes.findIndex((box) => box[start] === bounds.start);
    const index1 = boxes.findIndex((box) => box[end] === bounds.end);

    // Get our step, based on the distance between the center points of our
    // start and end boxes
    const step = (boxes[index1][mid] - boxes[index0][mid]) / (boxes.length - 1);

    let pos = boxes[index0][mid];

    return boxes.map((box, index) => {
      // Don't move our start and end boxes
      if (index === index0 || index === index1) {
        return 0;
      }

      pos += step;
      return pos - box[mid];
    });
  }

  // Distribute from gaps

  let pos = bounds.start;

  return boxes.map((box) => {
    const offset = pos - box[start];

    pos += step;
    pos += box[extent];

    return offset;
  });
};

/**
 * Lays the boxes out with exactly `gap` units between them, anchored on the
 * first box, which never moves. Unlike `spaceBetween` this can grow or shrink
 * the extent the boxes occupy. A gap of 0 makes the boxes touch.
 *
 * Returns one offset per box, in the order the boxes were given.
 */
export const fixedGap = (
  boxes: readonly BoundingBox[],
  axis: DistributionAxis,
  gap: number,
): number[] => {
  const [start, , , extent] = axisKeys(axis);

  let pos = boxes[0][start];

  return boxes.map((box) => {
    const offset = pos - box[start];

    pos += gap;
    pos += box[extent];

    return offset;
  });
};

/**
 * The spacing rules, keyed by the `space` they implement. A new rule is a new
 * member on `Distribution` and a new entry here; the mapped type means
 * TypeScript asks for the entry rather than letting it be forgotten.
 */
const spacingRules: {
  [TSpace in Distribution["space"]]: (
    boxes: readonly BoundingBox[],
    distribution: Extract<Distribution, { space: TSpace }>,
  ) => number[];
} = {
  between: (boxes, { axis }) => spaceBetween(boxes, axis),
  fixedGap: (boxes, { axis, gap }) => fixedGap(boxes, axis, gap),
};

type SpacingRule = (
  boxes: readonly BoundingBox[],
  distribution: Distribution,
) => number[];

/**
 * Moves each unit by its offset along the axis. The offsets are indexed the
 * same way as `units`.
 */
const applyTranslations = (
  units: readonly SelectionUnit[],
  offsets: readonly number[],
  axis: DistributionAxis,
  scene: Scene,
): NonDeletedExcalidrawElement[] =>
  units.flatMap(([group], index) => {
    const translation = {
      x: 0,
      y: 0,
    };

    translation[axis] = offsets[index];

    return group.map((element) => {
      const updatedElement = scene.mutateElement(element, {
        x: element.x + translation.x,
        y: element.y + translation.y,
      });
      updateBoundElements(element, scene, {
        simultaneouslyUpdated: group,
      });
      return updatedElement;
    });
  });

export const distributeElements = (
  selectedElements: NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  distribution: Distribution,
  appState: Readonly<AppState>,
  scene: Scene,
): NonDeletedExcalidrawElement[] => {
  const units = orderSelectionUnits(
    selectedElements,
    elementsMap,
    appState,
    distribution.axis,
  );

  // the lookup loses the link between the key and the rule's own variant, so
  // the rule has to be widened back to the union it was narrowed from
  const rule = spacingRules[distribution.space] as SpacingRule;

  const offsets = rule(
    units.map(([, box]) => box),
    distribution,
  );

  return applyTranslations(units, offsets, distribution.axis, scene);
};
