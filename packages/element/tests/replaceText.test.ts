import { VERTICAL_ALIGN, arrayToMap, getFontString } from "@excalidraw/common";

import {
  computeBoundTextPosition,
  computeContainerDimensionForBoundText,
  getBoundTextMaxHeight,
  getBoundTextMaxWidth,
  measureText,
} from "../src";
import { newElementWith } from "../src/mutateElement";
import {
  newElement,
  newFrameElement,
  newStickyNoteElement,
  newTextElement,
} from "../src/newElement";
import { replaceTextMatches } from "../src/replaceText";
import { getStickyNoteLayout } from "../src/stickyNote";
import { wrapText } from "../src/textWrapping";

import type { ExcalidrawTextElementWithContainer } from "../src/types";

const replaceAll = (
  elements: Parameters<typeof replaceTextMatches>[0],
  query: string,
  replacement: string,
) => {
  const matches = elements.flatMap((element) => {
    if (element.type !== "text") {
      return [];
    }
    const found: { elementId: string; index: number }[] = [];
    const regex = new RegExp(
      query.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"),
      "gi",
    );
    let match: RegExpExecArray | null;
    while ((match = regex.exec(element.originalText)) !== null) {
      found.push({ elementId: element.id, index: match.index });
    }
    return found;
  });

  return replaceTextMatches(elements, query, replacement, matches);
};

describe("replaceTextMatches", () => {
  it("replaces every tracked occurrence and leaves other elements untouched", () => {
    const first = newTextElement({ x: 0, y: 0, text: "alpha beta alpha" });
    const second = newTextElement({ x: 0, y: 40, text: "alpha" });
    const untouched = newTextElement({ x: 0, y: 80, text: "gamma" });

    const result = replaceAll([first, second, untouched], "alpha", "omega");

    expect(result.replacedCount).toBe(3);
    expect(result.affectedIds).toEqual([first.id, second.id]);
    expect(result.elements[0]).toMatchObject({
      id: first.id,
      originalText: "omega beta omega",
      text: "omega beta omega",
    });
    expect(result.elements[1]).toMatchObject({
      id: second.id,
      originalText: "omega",
    });
    expect(result.elements[2]).toBe(untouched);
    expect(first.originalText).toBe("alpha beta alpha");
  });

  it("replaces only the requested occurrence", () => {
    const text = newTextElement({ x: 0, y: 0, text: "alpha alpha" });
    const secondIndex = text.originalText.lastIndexOf("alpha");

    const result = replaceTextMatches([text], "alpha", "beta", [
      { elementId: text.id, index: secondIndex },
    ]);

    expect(result.replacedCount).toBe(1);
    expect(result.elements[0]).toMatchObject({
      originalText: "alpha beta",
      text: "alpha beta",
    });
  });

  it("matches case-insensitively and keeps a same-text replacement as a no-op", () => {
    const text = newTextElement({ x: 0, y: 0, text: "Hello" });

    const changed = replaceTextMatches([text], "hello", "Hi", [
      { elementId: text.id, index: 0 },
    ]);
    expect(changed.elements[0]).toMatchObject({ originalText: "Hi" });

    const unchanged = replaceTextMatches([text], "hello", "Hello", [
      { elementId: text.id, index: 0 },
    ]);
    expect(unchanged.replacedCount).toBe(0);
    expect(unchanged.elements[0]).toBe(text);
  });

  it("skips locked text and text inside a locked container", () => {
    const locked = newTextElement({ x: 0, y: 0, text: "alpha", locked: true });
    const container = newElement({
      type: "rectangle",
      x: 0,
      y: 40,
      width: 160,
      height: 80,
      locked: true,
    });
    const bound = newTextElement({
      x: 10,
      y: 50,
      text: "alpha",
      containerId: container.id,
    });
    const free = newTextElement({ x: 0, y: 140, text: "alpha" });
    const lockedContainer = newElementWith(container, {
      boundElements: [{ type: "text", id: bound.id }],
    });

    const result = replaceAll(
      [locked, lockedContainer, bound, free],
      "alpha",
      "beta",
    );

    expect(result.replacedCount).toBe(1);
    expect(result.elements[0]).toBe(locked);
    expect(result.elements[1]).toBe(lockedContainer);
    expect(result.elements[2]).toBe(bound);
    expect(result.elements[3]).toMatchObject({ originalText: "beta" });
  });

  it("wraps unbound text that has a fixed width", () => {
    const text = newElementWith(
      newTextElement({
        x: 0,
        y: 0,
        text: "hi",
        autoResize: false,
      }),
      { autoResize: false, width: 40 },
    );

    const result = replaceTextMatches([text], "hi", "hello world", [
      { elementId: text.id, index: 0 },
    ]);
    const next = result.elements[0] as typeof text;

    expect(next.originalText).toBe("hello world");
    expect(next.width).toBe(40);
    expect(next.text).toBe(
      wrapText(next.originalText, getFontString(next), next.width),
    );
    expect(next.text).toContain("\n");
  });

  it("rewraps bound text and grows a diamond when the label no longer fits", () => {
    const container = newElement({
      type: "diamond",
      x: 20,
      y: 30,
      width: 80,
      height: 80,
    });
    const text = newTextElement({
      x: 40,
      y: 50,
      text: "hi",
      containerId: container.id,
      autoResize: true,
      textAlign: "center",
      verticalAlign: VERTICAL_ALIGN.MIDDLE,
    });
    const boundContainer = newElementWith(container, {
      boundElements: [{ type: "text", id: text.id }],
    });

    const result = replaceTextMatches(
      [boundContainer, text],
      "hi",
      "hello world",
      [{ elementId: text.id, index: 0 }],
    );

    const nextContainer = result.elements[0] as typeof boundContainer;
    const nextText = result.elements[1] as ExcalidrawTextElementWithContainer;
    const maxWidth = getBoundTextMaxWidth(boundContainer, text);
    const wrapped = wrapText("hello world", getFontString(nextText), maxWidth);
    const metrics = measureText(
      wrapped,
      getFontString(nextText),
      nextText.lineHeight,
    );
    const maxHeight = getBoundTextMaxHeight(boundContainer, {
      ...text,
      containerId: container.id,
      height: metrics.height,
    });

    expect(nextText.originalText).toBe("hello world");
    expect(nextText.text).toBe(wrapped);
    expect(nextText.text).toContain("\n");
    expect(text.originalText).toBe("hi");
    if (metrics.height > maxHeight) {
      expect(nextContainer.height).toBe(
        computeContainerDimensionForBoundText(metrics.height, "diamond"),
      );
      expect(result.resizedContainerIds).toContain(boundContainer.id);
    }

    const { x, y } = computeBoundTextPosition(
      nextContainer,
      nextText,
      arrayToMap(result.elements),
    );
    expect(nextText.x).toBe(x);
    expect(nextText.y).toBe(y);
    expect(nextText.angle).toBe(nextContainer.angle);
  });

  it("lays out sticky-note labels with the sticky layout helper", () => {
    const note = newStickyNoteElement({
      type: "stickynote",
      x: 10,
      y: 10,
      width: 200,
      height: 200,
      baseHeight: 200,
    });
    const text = newTextElement({
      x: 110,
      y: 110,
      text: "hi",
      containerId: note.id,
      textAlign: "center",
      verticalAlign: VERTICAL_ALIGN.MIDDLE,
      autoResize: true,
    });
    const sticky = newElementWith(note, {
      boundElements: [{ type: "text", id: text.id }],
    });
    const replacement = "hello there friend";

    const result = replaceTextMatches([sticky, text], "hi", replacement, [
      { elementId: text.id, index: 0 },
    ]);
    const expected = getStickyNoteLayout(sticky, text, {
      originalText: replacement,
    });

    expect(result.elements[1]).toMatchObject({
      originalText: replacement,
      ...expected.text,
    });
    expect(result.elements[0]).toMatchObject(expected.container);
  });

  it("replaces a frame title without touching locked frames", () => {
    const frame = newFrameElement({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      name: "Plan alpha",
    });
    const locked = newFrameElement({
      x: 0,
      y: 120,
      width: 200,
      height: 100,
      name: "Plan alpha",
      locked: true,
    });

    const result = replaceTextMatches([frame, locked], "alpha", "beta", [
      { elementId: frame.id, index: frame.name!.indexOf("alpha") },
      { elementId: locked.id, index: locked.name!.indexOf("alpha") },
    ]);

    expect(result.replacedCount).toBe(1);
    expect(result.elements[0]).toMatchObject({ name: "Plan beta" });
    expect(result.elements[1]).toBe(locked);
  });
});
