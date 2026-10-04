import {
  distributeHorizontally,
  distributeHorizontallyWithGap,
  distributeVertically,
  distributeVerticallyWithGap,
} from "@excalidraw/excalidraw/actions";
import { defaultLang, setLanguage } from "@excalidraw/excalidraw/i18n";
import { Excalidraw } from "@excalidraw/excalidraw";

import { KEYS } from "@excalidraw/common";

import {
  CaptureUpdateAction,
  getCommonBoundingBox,
  orderSelectionUnits,
} from "@excalidraw/element";

import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { Keyboard, Pointer, UI } from "@excalidraw/excalidraw/tests/helpers/ui";
import {
  act,
  unmountComponent,
  render,
  waitFor,
} from "@excalidraw/excalidraw/tests/test-utils";

import type { ExcalidrawArrowElement } from "@excalidraw/element/types";

import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

const { h } = window;

/**
 * The fixture drawing from the request: A is 100 wide at x=0, B is a two-shape
 * group spanning x=120..170, C is 80 wide at x=198. The existing distribute
 * command happens to leave exactly 24 units between the three units.
 */
const createGapFixture = () => {
  const a = API.createElement({ x: 0, y: 0, width: 100, height: 100 });
  const b1 = API.createElement({
    x: 120,
    y: 0,
    width: 20,
    height: 40,
    groupIds: ["B"],
  });
  const b2 = API.createElement({
    x: 150,
    y: 0,
    width: 20,
    height: 40,
    groupIds: ["B"],
  });
  const c = API.createElement({ x: 198, y: 0, width: 80, height: 100 });

  selectAll([a, b1, b2, c]);

  return { a, b1, b2, c };
};

/**
 * The same fixture rotated onto the y axis.
 */
const createVerticalGapFixture = () => {
  const a = API.createElement({ x: 0, y: 0, width: 100, height: 100 });
  const b1 = API.createElement({
    x: 0,
    y: 120,
    width: 40,
    height: 20,
    groupIds: ["B"],
  });
  const b2 = API.createElement({
    x: 0,
    y: 150,
    width: 40,
    height: 20,
    groupIds: ["B"],
  });
  const c = API.createElement({ x: 0, y: 198, width: 100, height: 80 });

  selectAll([a, b1, b2, c]);

  return { a, b1, b2, c };
};

/**
 * A selection whose units overlap so much that the existing command falls back
 * to distributing from centers. Note that B is first in center order while A
 * owns the left edge of the selection, so the first unit in order does move.
 */
const createOverlappingFixture = () => {
  const a = API.createElement({ x: 0, y: 0, width: 200, height: 100 });
  const b = API.createElement({ x: 30, y: 0, width: 100, height: 100 });
  const c = API.createElement({ x: 100, y: 0, width: 200, height: 100 });

  selectAll([a, b, c]);

  return { a, b, c };
};

const selectAll = (elements: NonDeletedExcalidrawElement[]) => {
  API.setElements(elements);
  API.setSelectedElements(elements);
};

const xOf = (element: ExcalidrawElement) => API.getElement(element).x;
const yOf = (element: ExcalidrawElement) => API.getElement(element).y;

const orderCurrentSelection = (axis: "x" | "y") =>
  orderSelectionUnits(
    h.app.scene.getSelectedElements(h.state),
    h.app.scene.getNonDeletedElementsMap(),
    h.state,
    axis,
  );

/** element id -> the name the fixture gave it, so orderings stay readable */
const rolesOf = (fixture: Record<string, ExcalidrawElement>) =>
  Object.fromEntries(
    Object.entries(fixture).map(([role, element]) => [element.id, role]),
  );

const orderCurrentSelectionByRole = (roles: Record<string, string>) =>
  orderCurrentSelection("x").map(([group]) =>
    group.map((element) => roles[element.id]),
  );

/** the rotation-aware box the spacing is measured on, read back from the scene */
const boxOf = (...elements: ExcalidrawElement[]) =>
  getCommonBoundingBox(elements.map((element) => API.getElement(element)));

/** the scene coordinates of an arrow's last point */
const lastPointOf = (arrow: ExcalidrawArrowElement) => {
  const current = API.getElement(arrow);
  const [x, y] = current.points[current.points.length - 1];

  return { x: current.x + x, y: current.y + y };
};

const mouse = new Pointer("mouse");

describe("distributing with a gap", () => {
  beforeEach(async () => {
    unmountComponent();
    mouse.reset();

    await act(() => {
      return setLanguage(defaultLang);
    });
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  describe("characterization of the existing command", () => {
    it("spaces the fixture drawing 24 units apart horizontally", () => {
      const { a, b1, b2, c } = createGapFixture();

      API.executeAction(distributeHorizontally);

      expect(xOf(a)).toEqual(0);
      expect(xOf(b1)).toEqual(124);
      expect(xOf(b2)).toEqual(154);
      expect(xOf(c)).toEqual(198);
    });

    it("spaces the fixture drawing 24 units apart vertically", () => {
      const { a, b1, b2, c } = createVerticalGapFixture();

      API.executeAction(distributeVertically);

      expect(yOf(a)).toEqual(0);
      expect(yOf(b1)).toEqual(124);
      expect(yOf(b2)).toEqual(154);
      expect(yOf(c)).toEqual(198);
    });

    it("falls back to distributing from centers when there is no room", () => {
      const { a, b, c } = createOverlappingFixture();

      API.executeAction(distributeHorizontally);

      // a and c own the selection bounds, so they stay put; b is the first
      // unit in center order and is the only one that moves
      expect(xOf(a)).toEqual(0);
      expect(xOf(b)).toEqual(100);
      expect(xOf(c)).toEqual(100);
    });
  });

  describe("shared ordering", () => {
    it("treats a whole group as one unit", () => {
      const { a, b1, b2, c } = createGapFixture();

      expect(
        orderCurrentSelection("x").map(([group]) => group.map((e) => e.id)),
      ).toEqual([[a.id], [b1.id, b2.id], [c.id]]);
    });

    it("orders overlapping units by the center of their bounding box", () => {
      const { a, b, c } = createOverlappingFixture();

      expect(orderCurrentSelection("x").map(([group]) => group[0].id)).toEqual([
        b.id,
        a.id,
        c.id,
      ]);
    });
  });

  describe("the new command", () => {
    it("puts the asked-for gap between units of unequal size", () => {
      const { a, b1, b2, c } = createGapFixture();
      API.setAppState({ currentItemDistributeGap: 40 });

      API.executeAction(distributeHorizontallyWithGap);

      expect(xOf(a)).toEqual(0);
      expect(xOf(b1)).toEqual(140);
      expect(xOf(b2)).toEqual(170);
      expect(xOf(c)).toEqual(230);
    });

    it("works on the y axis", () => {
      const { a, b1, b2, c } = createVerticalGapFixture();
      API.setAppState({ currentItemDistributeGap: 40 });

      API.executeAction(distributeVerticallyWithGap);

      expect(yOf(a)).toEqual(0);
      expect(yOf(b1)).toEqual(140);
      expect(yOf(b2)).toEqual(170);
      expect(yOf(c)).toEqual(230);
    });

    it("makes the units touch on a gap of zero", () => {
      const { a, b1, b2, c } = createGapFixture();
      API.setAppState({ currentItemDistributeGap: 0 });

      API.executeAction(distributeHorizontallyWithGap);

      expect(xOf(a)).toEqual(0);
      expect(xOf(b1)).toEqual(100);
      expect(xOf(b2)).toEqual(130);
      expect(xOf(c)).toEqual(150);
    });

    it("pulls apart units that start out overlapping", () => {
      const { a, b, c } = createOverlappingFixture();
      API.setAppState({ currentItemDistributeGap: 10 });

      API.executeAction(distributeHorizontallyWithGap);

      // b is first in center order, so it anchors the run
      expect(xOf(b)).toEqual(30);
      expect(xOf(a)).toEqual(140);
      expect(xOf(c)).toEqual(350);
    });

    it("leaves the first unit in order alone even when it is not the leftmost", () => {
      const { b } = createOverlappingFixture();
      API.setAppState({ currentItemDistributeGap: 10 });

      API.executeAction(distributeHorizontallyWithGap);

      expect(xOf(b)).toEqual(30);
    });

    it("does nothing on a negative gap", () => {
      const { a, b1, b2, c } = createGapFixture();
      API.setAppState({ currentItemDistributeGap: -10 });

      API.executeAction(distributeHorizontallyWithGap);

      expect(xOf(a)).toEqual(0);
      expect(xOf(b1)).toEqual(120);
      expect(xOf(b2)).toEqual(150);
      expect(xOf(c)).toEqual(198);
    });

    it("does nothing on a gap that is not a number", () => {
      const { a, b1, b2, c } = createGapFixture();
      API.setAppState({ currentItemDistributeGap: Number.NaN });

      API.executeAction(distributeHorizontallyWithGap);

      expect(xOf(a)).toEqual(0);
      expect(xOf(b1)).toEqual(120);
      expect(xOf(b2)).toEqual(150);
      expect(xOf(c)).toEqual(198);
    });

    it("does nothing when fewer than three units are selected", () => {
      const a = API.createElement({ x: 0, y: 0, width: 100, height: 100 });
      const c = API.createElement({ x: 198, y: 0, width: 80, height: 100 });
      selectAll([a, c]);
      API.setAppState({ currentItemDistributeGap: 24 });

      API.executeAction(distributeHorizontallyWithGap);

      expect(xOf(a)).toEqual(0);
      expect(xOf(c)).toEqual(198);
    });

    it("does nothing when the selection holds a frame", () => {
      const a = API.createElement({ x: 0, y: 0, width: 100, height: 100 });
      const b = API.createElement({ x: 120, y: 0, width: 50, height: 100 });
      const frame = API.createElement({
        type: "frame",
        x: 198,
        y: 0,
        width: 80,
        height: 100,
      });
      selectAll([a, b, frame]);
      API.setAppState({ currentItemDistributeGap: 24 });

      API.executeAction(distributeHorizontallyWithGap);

      expect(xOf(a)).toEqual(0);
      expect(xOf(b)).toEqual(120);
      expect(xOf(frame)).toEqual(198);
    });
  });

  describe("units that are not plain rectangles", () => {
    it("measures the gap on the rotated bounds of a rotated unit", () => {
      const a = API.createElement({ x: 0, y: 0, width: 100, height: 100 });
      const rotated = API.createElement({
        x: 200,
        y: 0,
        width: 100,
        height: 100,
        angle: Math.PI / 4,
      });
      const c = API.createElement({ x: 400, y: 0, width: 100, height: 100 });
      selectAll([a, rotated, c]);
      API.setAppState({ currentItemDistributeGap: 24 });

      API.executeAction(distributeHorizontallyWithGap);

      // a 100x100 square turned 45° is ~141.42 wide on screen
      expect(boxOf(rotated).width).toBeCloseTo(Math.SQRT2 * 100);
      expect(boxOf(a).minX).toEqual(0);
      expect(boxOf(rotated).minX - boxOf(a).maxX).toBeCloseTo(24);
      expect(boxOf(c).minX - boxOf(rotated).maxX).toBeCloseTo(24);
    });

    it("moves a bound label with its container", () => {
      const a = API.createElement({ x: 0, y: 0, width: 100, height: 100 });
      const container = API.createElement({
        x: 120,
        y: 0,
        width: 50,
        height: 100,
      });
      const label = API.createElement({
        type: "text",
        text: "label",
        x: 125,
        y: 40,
        width: 40,
        height: 20,
        containerId: container.id,
      });
      const c = API.createElement({ x: 198, y: 0, width: 80, height: 100 });

      API.setElements([a, container, label, c]);
      API.updateElement(container, {
        boundElements: [{ type: "text", id: label.id }],
      });
      API.setSelectedElements([a, container, c]);
      API.setAppState({ currentItemDistributeGap: 40 });

      API.executeAction(distributeHorizontallyWithGap);

      expect(xOf(a)).toEqual(0);
      expect(xOf(container)).toEqual(140);
      // the label is not selected, but it travels with its container
      expect(xOf(label)).toEqual(145);
      expect(xOf(c)).toEqual(230);
    });

    it("keeps a bound arrow attached to the unit it points at", async () => {
      const a = API.createElement({ x: 0, y: 0, width: 100, height: 100 });
      const b = API.createElement({ x: 200, y: 0, width: 100, height: 100 });
      const c = API.createElement({ x: 400, y: 0, width: 100, height: 100 });
      API.setElements([a, b, c]);

      UI.clickTool("arrow");
      mouse.down(50, 50);
      mouse.up(200, 0);

      const arrow = await waitFor(() => {
        const drawn = h.elements.find(
          (element): element is ExcalidrawArrowElement =>
            element.type === "arrow",
        );
        expect(drawn?.endBinding?.elementId).toEqual(b.id);
        return drawn!;
      });

      const endBefore = lastPointOf(arrow).x - boxOf(b).minX;

      API.setSelectedElements([a, b, c]);
      API.setAppState({ currentItemDistributeGap: 24 });
      API.executeAction(distributeHorizontallyWithGap);

      expect(xOf(b)).toEqual(124);
      expect(lastPointOf(arrow).x - boxOf(b).minX).toBeCloseTo(endBefore);
    });
  });

  describe("undo", () => {
    it("puts the selection back where it was", () => {
      const a = API.createElement({ x: 0, y: 0, width: 100, height: 100 });
      const b1 = API.createElement({
        x: 120,
        y: 0,
        width: 20,
        height: 40,
        groupIds: ["B"],
      });
      const b2 = API.createElement({
        x: 150,
        y: 0,
        width: 20,
        height: 40,
        groupIds: ["B"],
      });
      const c = API.createElement({ x: 198, y: 0, width: 80, height: 100 });

      // seed through the scene so the move lands in the history stack
      API.updateScene({
        elements: [a, b1, b2, c],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      API.setSelectedElements([a, b1, b2, c]);
      API.setAppState({ currentItemDistributeGap: 40 });

      API.executeAction(distributeHorizontallyWithGap);
      expect(xOf(a)).toEqual(0);
      expect(xOf(b1)).toEqual(140);

      Keyboard.withModifierKeys({ ctrl: true }, () => {
        Keyboard.keyPress(KEYS.Z);
      });

      expect(xOf(a)).toEqual(0);
      expect(xOf(b1)).toEqual(120);
      expect(xOf(b2)).toEqual(150);
      expect(xOf(c)).toEqual(198);
    });
  });

  describe("the two commands agree on the fixture drawing", () => {
    it("gives identical positions for the gap the old command already produces", () => {
      const before = createGapFixture();
      API.executeAction(distributeHorizontally);
      const spaceBetweenPositions = [
        xOf(before.a),
        xOf(before.b1),
        xOf(before.b2),
        xOf(before.c),
      ];

      const after = createGapFixture();
      API.setAppState({ currentItemDistributeGap: 24 });
      API.executeAction(distributeHorizontallyWithGap);
      const fixedGapPositions = [
        xOf(after.a),
        xOf(after.b1),
        xOf(after.b2),
        xOf(after.c),
      ];

      expect(fixedGapPositions).toEqual(spaceBetweenPositions);
      expect(fixedGapPositions).toEqual([0, 124, 154, 198]);
    });

    it("orders and groups the selection the same way", () => {
      const expected = [["a"], ["b1", "b2"], ["c"]];

      const spaceBetweenRoles = rolesOf(createGapFixture());
      expect(orderCurrentSelectionByRole(spaceBetweenRoles)).toEqual(expected);
      API.executeAction(distributeHorizontally);
      expect(orderCurrentSelectionByRole(spaceBetweenRoles)).toEqual(expected);

      const fixedGapRoles = rolesOf(createGapFixture());
      API.setAppState({ currentItemDistributeGap: 24 });
      expect(orderCurrentSelectionByRole(fixedGapRoles)).toEqual(expected);
      API.executeAction(distributeHorizontallyWithGap);
      expect(orderCurrentSelectionByRole(fixedGapRoles)).toEqual(expected);
    });
  });
});
