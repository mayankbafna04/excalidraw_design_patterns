import React from "react";

import { syncInvalidIndices } from "@excalidraw/element";

import type {
  ExcalidrawFrameElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import { prepareElementsForExport } from "../data";
import { blobToArrayBuffer } from "../data/blob";
import { fileSave } from "../data/filesystem";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { readZip } from "./helpers/zip";
import { act, fireEvent, render, screen, waitFor } from "./test-utils";

// the file is never actually saved in tests, we only capture what would be
vi.mock("../data/filesystem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/filesystem")>()),
  fileSave: vi.fn(),
}));

const { h } = window;

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

type SavedFile = { bytes: Uint8Array; name: string; extension: string };

let savedFiles: SavedFile[];

// `toBlob()` of the canvas mock, which creates a blob of width * height * 4
// zero bytes
const canvasMockToBlob = HTMLCanvasElement.prototype.toBlob;

/** canvases that were turned into images, in order */
let exportedCanvases: HTMLCanvasElement[];
/**
 * Overrides what the canvas is turned into: `null` is what browsers come up
 * with when the canvas is too big, a promise delays the default behavior.
 */
let toBlobOverride:
  | ((canvas: HTMLCanvasElement) => null | Promise<void> | undefined)
  | null;

const describeCanvas = (canvas: HTMLCanvasElement) => ({
  width: canvas.width,
  height: canvas.height,
  drawEvents: (canvas.getContext("2d") as any).__getEvents() as unknown[],
});

const createFrame = (
  id: string,
  opts: { x?: number; y?: number; width?: number; height?: number } = {},
  name: string | null = null,
): NonDeleted<ExcalidrawFrameElement> => ({
  ...API.createElement({ type: "frame", id, y: 0, ...opts }),
  name,
});

/** three frames next to each other, each with something in it */
const createScene = () => {
  const frames = [
    createFrame("frame-a", { x: 0, width: 200, height: 100 }),
    createFrame("frame-b", { x: 400, width: 333, height: 80 }, "Wide frame"),
    createFrame("frame-c", { x: 900, width: 50, height: 40 }),
  ];

  const elements: NonDeletedExcalidrawElement[] = [
    API.createElement({
      type: "rectangle",
      x: 150,
      y: 20,
      width: 100,
      height: 60,
      frameId: "frame-a",
    }),
    frames[0],
    API.createElement({
      type: "ellipse",
      x: 420,
      y: 10,
      width: 60,
      height: 60,
      frameId: "frame-b",
    }),
    frames[1],
    // image without its file
    API.createElement({
      type: "image",
      x: 910,
      y: 10,
      width: 20,
      height: 20,
      fileId: "missing-file",
      frameId: "frame-c",
    }),
    frames[2],
  ];

  syncInvalidIndices(elements);

  return { elements, frames };
};

const openExportDialog = async (
  elements: readonly NonDeletedExcalidrawElement[],
  selectedElements: NonDeletedExcalidrawElement[],
) => {
  API.setElements(elements);
  API.setSelectedElements(selectedElements);
  API.setAppState({ openDialog: { name: "imageExport" } });

  await waitFor(() =>
    expect(document.querySelector(".ImageExportModal")).not.toBeNull(),
  );
};

const getSeparateFramesToggle = () =>
  document.querySelector<HTMLInputElement>(
    'input[name="exportSeparateFrames"]',
  );

const queryButton = (label: string) =>
  screen.queryByRole("button", { name: label });

const queryStatus = () => screen.queryByTestId("bundled-export-status");

const exportToZip = async () => {
  fireEvent.click(getSeparateFramesToggle()!);
  await act(async () => {
    fireEvent.click(queryButton("Export frames to ZIP")!);
  });
};

/**
 * Exporting at this scale makes the images bigger than their frames, which
 * tells them apart from the placeholders of failed frames (not scaled).
 */
const SCALE = 2;

/** exports the frame the way it's done today when it's selected on its own */
const exportFrameAlone = async (frame: NonDeletedExcalidrawElement) => {
  API.setSelectedElements([frame]);

  // ImageExportDialog
  const { exportedElements, exportingFrame } = prepareElementsForExport(
    h.elements,
    h.state,
    true,
  );
  expect(exportingFrame?.id).toBe(frame.id);

  await act(async () => {
    await h.app.onExportImage("png", exportedElements, { exportingFrame });
  });

  const file = savedFiles.pop()!;
  expect(file.extension).toBe("png");
  return { bytes: file.bytes, canvas: describeCanvas(exportedCanvases.pop()!) };
};

beforeEach(async () => {
  exportedCanvases = [];
  toBlobOverride = null;
  HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
    exportedCanvases.push(this);
    const override = toBlobOverride?.(this);
    if (override === null) {
      setTimeout(() => callback(null));
    } else if (override) {
      override.then(() => canvasMockToBlob.call(this, callback, ...rest));
    } else {
      canvasMockToBlob.call(this, callback, ...rest);
    }
  };

  savedFiles = [];
  vi.mocked(fileSave).mockReset();
  vi.mocked(fileSave).mockImplementation(async (blob, opts) => {
    savedFiles.push({
      bytes: new Uint8Array(await blobToArrayBuffer(await blob)),
      name: opts.name,
      extension: opts.extension,
    });
    return null;
  });

  await render(<Excalidraw />);
});

afterEach(() => {
  HTMLCanvasElement.prototype.toBlob = canvasMockToBlob;
});

// -----------------------------------------------------------------------------
// tests
// -----------------------------------------------------------------------------

describe("exporting several frames", () => {
  describe("toggle between a single image and an image per frame", () => {
    it("is offered when more than one frame is selected", async () => {
      const { elements, frames } = createScene();

      await openExportDialog(elements, frames);

      const toggle = getSeparateFramesToggle();
      expect(toggle).not.toBeNull();
      // combining frames into a single image remains the default
      expect(toggle!.checked).toBe(false);
      expect(queryButton("Export to PNG")).not.toBeNull();
      expect(queryButton("Export to SVG")).not.toBeNull();
      expect(queryButton("Export frames to ZIP")).toBeNull();
    });

    it("isn't offered when a single frame is selected", async () => {
      const { elements, frames } = createScene();

      await openExportDialog(elements, [frames[0]]);

      expect(getSeparateFramesToggle()).toBeNull();
      expect(queryButton("Export to PNG")).not.toBeNull();
    });

    it("isn't offered when a frame is selected along with elements that aren't frames", async () => {
      const { elements, frames } = createScene();

      await openExportDialog(elements, [frames[0], elements[2]]);

      expect(getSeparateFramesToggle()).toBeNull();
    });

    it("isn't offered when nothing is selected", async () => {
      const { elements } = createScene();

      await openExportDialog(elements, []);

      expect(getSeparateFramesToggle()).toBeNull();
    });

    it("isn't offered when not exporting the selection", async () => {
      const { elements, frames } = createScene();
      await openExportDialog(elements, frames);

      fireEvent.click(
        document.querySelector('input[name="exportOnlySelected"]')!,
      );

      expect(getSeparateFramesToggle()).toBeNull();
      expect(queryButton("Export to PNG")).not.toBeNull();
    });

    it("when off, frames are combined into a single image as before", async () => {
      const { elements, frames } = createScene();
      await openExportDialog(elements, frames);

      fireEvent.click(queryButton("Export to PNG")!);

      await waitFor(() => expect(savedFiles.length).toBe(1));
      expect(savedFiles[0].extension).toBe("png");
      expect(queryStatus()).toBeNull();

      // one image, spanning all of the frames
      expect(exportedCanvases.length).toBe(1);
      expect(exportedCanvases[0].width).toBeGreaterThan(900 + 50);
    });

    it("when on, each frame is exported into its own image", async () => {
      const { elements, frames } = createScene();
      await openExportDialog(elements, frames);

      fireEvent.click(getSeparateFramesToggle()!);

      // PNG only
      expect(queryButton("Export to PNG")).toBeNull();
      expect(queryButton("Export to SVG")).toBeNull();
      expect(queryButton("Copy PNG to clipboard")).toBeNull();

      fireEvent.click(queryButton("Export frames to ZIP")!);

      await waitFor(() => expect(savedFiles.length).toBe(1));
      expect(savedFiles[0]).toMatchObject({
        extension: "zip",
        name: h.app.getName(),
      });
      expect(readZip(savedFiles[0].bytes).length).toBe(3);

      // one image per frame, each of the size of its frame
      expect(
        exportedCanvases.map(({ width, height }) => ({ width, height })),
      ).toEqual(frames.map(({ width, height }) => ({ width, height })));
    });

    it("can be turned back off", async () => {
      const { elements, frames } = createScene();
      await openExportDialog(elements, frames);

      fireEvent.click(getSeparateFramesToggle()!);
      fireEvent.click(getSeparateFramesToggle()!);

      expect(queryButton("Export frames to ZIP")).toBeNull();
      expect(queryButton("Export to PNG")).not.toBeNull();
    });
  });

  it("images in the archive are the same as when exporting each frame on its own", async () => {
    const { elements, frames } = createScene();
    // frames without failures only
    const selectedFrames = [frames[1], frames[0]];
    await openExportDialog(elements, selectedFrames);

    await exportToZip();
    await waitFor(() => expect(savedFiles.length).toBe(1));

    const archive = readZip(savedFiles.pop()!.bytes);
    const bundledCanvases = exportedCanvases.splice(0).map(describeCanvas);

    expect(archive.map((file) => file.name)).toEqual([
      "frame_frame-a_successful.png",
      "frame_frame-b_successful.png",
    ]);

    for (const [index, frame] of [frames[0], frames[1]].entries()) {
      const alone = await exportFrameAlone(frame);

      expect(archive[index].data).toEqual(alone.bytes);
      expect(bundledCanvases[index]).toEqual(alone.canvas);
      expect(alone.canvas.drawEvents.length).toBeGreaterThan(0);
    }
  });

  describe("progress and failures", () => {
    it("doesn't leave anything on screen when all goes well", async () => {
      const { elements, frames } = createScene();
      await openExportDialog(elements, [frames[0], frames[1]]);

      await exportToZip();

      await waitFor(() => expect(savedFiles.length).toBe(1));
      await waitFor(() => expect(queryStatus()).toBeNull());
      expect(h.state.errorMessage).toBeNull();
    });

    it("shows the progress while exporting", async () => {
      const { elements, frames } = createScene();
      await openExportDialog(elements, frames);

      // hold the first frame until we say so
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      toBlobOverride = (canvas) => (canvas.width === 200 ? held : undefined);

      await exportToZip();

      await waitFor(() => expect(queryStatus()).not.toBeNull());
      expect(screen.queryByText("Exporting frames")).not.toBeNull();
      expect(screen.getByTestId("bundled-export-progress").textContent).toBe(
        "0 of 3 frames processed",
      );
      expect(screen.getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        "0",
      );
      expect(queryButton("Cancel")).not.toBeNull();
      expect(savedFiles).toEqual([]);

      await act(async () => release());

      await waitFor(() => expect(savedFiles.length).toBe(1));
    });

    it("lists the failed frames in the order they failed, until dismissed", async () => {
      const { elements, frames } = createScene();
      // frame B can't be rendered at all, frame C lacks an image
      API.setAppState({ exportScale: SCALE });
      toBlobOverride = (canvas) =>
        canvas.width === 333 * SCALE ? null : undefined;
      // selection order doesn't matter
      await openExportDialog(elements, [frames[2], frames[1], frames[0]]);

      await exportToZip();

      await waitFor(() => expect(savedFiles.length).toBe(1));
      await waitFor(() =>
        expect(
          screen.queryByText("Some frames failed to export"),
        ).not.toBeNull(),
      );

      expect(screen.getByTestId("bundled-export-progress").textContent).toBe(
        "3 of 3 frames processed",
      );
      expect(screen.queryByText("Failed frames: 2")).not.toBeNull();
      expect(
        Array.from(
          screen.getByTestId("bundled-export-failures").children,
          (item) => item.textContent,
        ),
      ).toEqual([
        "Wide frame (frame-b): Error: Canvas too big",
        "Frame (frame-c): Images that couldn't be rendered: 1",
      ]);
      // each failure is on its own, rather than the last one replacing the
      // others in the generic error dialog
      expect(h.state.errorMessage).toBeNull();

      // the archive isn't presented as complete
      expect(readZip(savedFiles[0].bytes).map((file) => file.name)).toEqual([
        "frame_frame-a_successful.png",
        "frame_frame-b_failure.png",
        "frame_frame-c_failure.png",
      ]);

      // stays until dismissed
      expect(queryButton("Cancel")).toBeNull();
      fireEvent.click(queryButton("Close")!);
      expect(queryStatus()).toBeNull();
    });

    it("shows a failure as soon as it happens", async () => {
      const { elements, frames } = createScene();
      await openExportDialog(elements, frames);

      // frame A can't be rendered, frame B is held until we say so
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      API.setAppState({ exportScale: SCALE });
      toBlobOverride = (canvas) =>
        canvas.width === 200 * SCALE
          ? null
          : canvas.width === 333 * SCALE
          ? held
          : undefined;

      await exportToZip();

      await waitFor(() =>
        expect(screen.queryByTestId("bundled-export-failures")).not.toBeNull(),
      );
      // still exporting
      expect(screen.queryByText("Exporting frames")).not.toBeNull();
      expect(screen.getByTestId("bundled-export-progress").textContent).toBe(
        "1 of 3 frames processed",
      );
      expect(screen.getByTestId("bundled-export-failures").textContent).toBe(
        "Frame (frame-a): Error: Canvas too big",
      );
      expect(savedFiles).toEqual([]);

      await act(async () => release());
      await waitFor(() => expect(savedFiles.length).toBe(1));
    });
  });

  it("can be cancelled while exporting", async () => {
    const { elements, frames } = createScene();
    await openExportDialog(elements, frames);

    // hold the first frame until we say so
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    toBlobOverride = (canvas) => (canvas.width === 200 ? held : undefined);

    await exportToZip();
    await waitFor(() => expect(queryButton("Cancel")).not.toBeNull());

    fireEvent.click(queryButton("Cancel")!);
    // doesn't wait for the frame that's being exported
    expect(queryStatus()).toBeNull();

    await act(async () => release());
    // let any remaining work run its course
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // the remaining frames weren't exported, nothing was saved, and
    // cancelling isn't reported as an error
    expect(exportedCanvases.length).toBe(1);
    expect(fileSave).toHaveBeenCalledTimes(1);
    expect(savedFiles).toEqual([]);
    expect(h.state.errorMessage).toBeNull();
    // the export dialog is still there to try again
    expect(queryButton("Export frames to ZIP")).not.toBeNull();
  });

  it("refuses to export too many frames at once", async () => {
    const frames = Array.from({ length: 11 }, (_, index) =>
      createFrame(`frame-${index}`, { x: index * 200 }),
    );
    await openExportDialog(frames, frames);
    // the error gets logged as well
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await exportToZip();

    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
    await waitFor(() =>
      expect(h.state.errorMessage).toBe(
        "Cannot export more than 10 frames at once.",
      ),
    );
    expect(queryStatus()).toBeNull();
    expect(fileSave).not.toHaveBeenCalled();
    expect(exportedCanvases).toEqual([]);
  });
});
