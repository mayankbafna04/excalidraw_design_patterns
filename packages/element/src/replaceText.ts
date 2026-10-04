import { arrayToMap, getFontString } from "@excalidraw/common";

import type { Radians } from "@excalidraw/math";

import { getFrameLikeTitle } from "./frame";
import { newElementWith } from "./mutateElement";
import { refreshTextDimensions } from "./newElement";
import { getStickyNoteLayout } from "./stickyNote";
import {
  computeBoundTextPosition,
  computeContainerDimensionForBoundText,
  getBoundTextMaxHeight,
  getBoundTextMaxWidth,
  isValidTextContainer,
} from "./textElement";
import { measureText } from "./textMeasurements";
import {
  isArrowElement,
  isFrameLikeElement,
  isStickyNoteElement,
  isTextElement,
} from "./typeChecks";

import type {
  ElementsMap,
  ExcalidrawElement,
  ExcalidrawTextElement,
  ExcalidrawTextElementWithContainer,
} from "./types";

/**
 * A match recorded by search: `index` is a code-unit offset into a text
 * element's `originalText`, or into a frame's displayed title.
 */
export type TextMatchLocation = {
  elementId: ExcalidrawElement["id"];
  index: number;
};

export type TextReplaceResult = {
  elements: readonly ExcalidrawElement[];
  /** Match occurrences whose source text actually changed. */
  replacedCount: number;
  /** Text or frame elements whose source text changed. */
  affectedIds: readonly ExcalidrawElement["id"][];
  /** Containers whose geometry was recalculated for the new text. */
  resizedContainerIds: readonly ExcalidrawElement["id"][];
};

const emptyResult = (
  elements: readonly ExcalidrawElement[],
): TextReplaceResult => ({
  elements,
  replacedCount: 0,
  affectedIds: [],
  resizedContainerIds: [],
});

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

type ElementLookup = {
  get(id: ExcalidrawElement["id"]): ExcalidrawElement | undefined;
};

/**
 * Locked text, and text bound to a locked container, cannot be replaced.
 * Frame titles follow the same lock rule.
 */
export const canReplaceElementText = (
  elementId: ExcalidrawElement["id"],
  elementsMap: ElementLookup,
): boolean => {
  const element = elementsMap.get(elementId);
  if (!element || element.isDeleted || element.locked) {
    return false;
  }

  if (isTextElement(element)) {
    if (!element.containerId) {
      return true;
    }
    const container = elementsMap.get(element.containerId);
    return !!container && !container.isDeleted && !container.locked;
  }

  return isFrameLikeElement(element);
};

const replaceAt = (
  source: string,
  index: number,
  query: string,
  replacement: string,
): string | null => {
  if (index < 0 || index > source.length) {
    return null;
  }

  const current = source.slice(index, index + query.length);
  if (
    current.length !== query.length ||
    !new RegExp(`^${escapeRegExp(query)}$`, "i").test(current)
  ) {
    return null;
  }

  if (current === replacement) {
    return source;
  }

  return (
    source.slice(0, index) + replacement + source.slice(index + query.length)
  );
};

/**
 * Applies matches from the end of the string so earlier offsets stay valid
 * when the replacement length differs from the query.
 */
const applyMatchReplacements = (
  source: string,
  indices: readonly number[],
  query: string,
  replacement: string,
): { next: string; count: number } => {
  const uniqueIndices = [...new Set(indices)].sort((a, b) => b - a);
  let next = source;
  let count = 0;

  for (const index of uniqueIndices) {
    const updated = replaceAt(next, index, query, replacement);
    if (updated == null || updated === next) {
      continue;
    }
    next = updated;
    count += 1;
  }

  return { next, count };
};

/**
 * Rewraps and repositions replaced text with the same helpers the editor uses
 * when committing text (`refreshTextDimensions`, `wrapText` via that helper,
 * bound-text measurement, and sticky-note layout).
 */
const layoutReplacedText = (
  element: ExcalidrawTextElement,
  nextOriginalText: string,
  elementsMap: ElementsMap,
  replacements: Map<ExcalidrawElement["id"], ExcalidrawElement>,
  resizedContainerIds: Set<ExcalidrawElement["id"]>,
): ExcalidrawTextElement => {
  const container = element.containerId
    ? elementsMap.get(element.containerId) ?? null
    : null;
  const latestContainer = container
    ? replacements.get(container.id) ?? container
    : null;

  if (latestContainer && isStickyNoteElement(latestContainer)) {
    const layout = getStickyNoteLayout(latestContainer, element, {
      originalText: nextOriginalText,
    });
    const nextContainer = newElementWith(latestContainer, layout.container);
    if (nextContainer !== latestContainer) {
      replacements.set(latestContainer.id, nextContainer);
      resizedContainerIds.add(latestContainer.id);
    }
    return newElementWith(element, {
      originalText: nextOriginalText,
      ...(layout.text ?? {}),
    });
  }

  const textContainer =
    latestContainer && isValidTextContainer(latestContainer)
      ? latestContainer
      : null;
  const refreshed = refreshTextDimensions(
    element,
    textContainer,
    elementsMap,
    nextOriginalText,
  );

  if (!refreshed) {
    return element;
  }

  const updates = {
    originalText: nextOriginalText,
    text: refreshed.text,
    x: refreshed.x,
    y: refreshed.y,
    width: refreshed.width,
    height: refreshed.height,
    angle: element.angle,
  };

  if (textContainer && element.containerId) {
    const draft: ExcalidrawTextElementWithContainer = {
      ...element,
      ...updates,
      containerId: element.containerId,
    };
    const metrics = measureText(
      draft.text,
      getFontString(draft),
      draft.lineHeight,
    );
    const maxHeight = getBoundTextMaxHeight(textContainer, draft);
    const maxWidth = getBoundTextMaxWidth(textContainer, draft);

    let nextWidth = textContainer.width;
    let nextHeight = textContainer.height;
    if (!isArrowElement(textContainer) && metrics.height > maxHeight) {
      nextHeight = computeContainerDimensionForBoundText(
        metrics.height,
        textContainer.type,
      );
    }
    if (metrics.width > maxWidth) {
      nextWidth = computeContainerDimensionForBoundText(
        metrics.width,
        textContainer.type,
      );
    }

    const positionedContainer = newElementWith(textContainer, {
      width: nextWidth,
      height: nextHeight,
    });
    if (positionedContainer !== textContainer) {
      replacements.set(textContainer.id, positionedContainer);
      resizedContainerIds.add(textContainer.id);
    }

    const positionElementsMap =
      positionedContainer === textContainer
        ? elementsMap
        : new Map(elementsMap).set(positionedContainer.id, positionedContainer);

    const textWidth = draft.autoResize ? metrics.width : refreshed.width;
    const { x, y } = computeBoundTextPosition(
      positionedContainer,
      {
        ...draft,
        width: textWidth,
        height: metrics.height,
      },
      positionElementsMap,
    );

    updates.x = x;
    updates.y = y;
    updates.width = textWidth;
    updates.height = metrics.height;
    updates.angle = (
      isArrowElement(positionedContainer) ? 0 : positionedContainer.angle
    ) as Radians;
  }

  return newElementWith(element, updates);
};

/**
 * Replaces tracked search matches in element data and returns the next
 * elements. Does not touch the scene, history, or the input objects.
 *
 * Pass every match for replace-all, or one match for a single replacement.
 * The caller records the returned elements as one `CaptureUpdateAction`.
 */
export const replaceTextMatches = (
  elements: readonly ExcalidrawElement[],
  query: string,
  replacement: string,
  matches: readonly TextMatchLocation[],
): TextReplaceResult => {
  if (!query || matches.length === 0) {
    return emptyResult(elements);
  }

  const elementsMap = arrayToMap(elements) as ElementsMap;
  const indicesByElement = new Map<ExcalidrawElement["id"], number[]>();

  for (const match of matches) {
    const indices = indicesByElement.get(match.elementId);
    if (indices) {
      indices.push(match.index);
    } else {
      indicesByElement.set(match.elementId, [match.index]);
    }
  }

  const replacements = new Map<ExcalidrawElement["id"], ExcalidrawElement>();
  const affectedIds: ExcalidrawElement["id"][] = [];
  const resizedContainerIds = new Set<ExcalidrawElement["id"]>();
  let replacedCount = 0;

  for (const [elementId, indices] of indicesByElement) {
    const element = elementsMap.get(elementId);
    if (!element || !canReplaceElementText(elementId, elementsMap)) {
      continue;
    }

    if (isTextElement(element)) {
      const { next, count } = applyMatchReplacements(
        element.originalText,
        indices,
        query,
        replacement,
      );
      if (count === 0) {
        continue;
      }

      const laidOut = layoutReplacedText(
        element,
        next,
        elementsMap,
        replacements,
        resizedContainerIds,
      );
      replacements.set(element.id, laidOut);
      affectedIds.push(element.id);
      replacedCount += count;
      continue;
    }

    if (isFrameLikeElement(element)) {
      const { next, count } = applyMatchReplacements(
        getFrameLikeTitle(element),
        indices,
        query,
        replacement,
      );
      if (count === 0) {
        continue;
      }

      replacements.set(element.id, newElementWith(element, { name: next }));
      affectedIds.push(element.id);
      replacedCount += count;
    }
  }

  if (replacedCount === 0) {
    return emptyResult(elements);
  }

  return {
    elements: elements.map(
      (element) => replacements.get(element.id) ?? element,
    ),
    replacedCount,
    affectedIds,
    resizedContainerIds: [...resizedContainerIds],
  };
};
