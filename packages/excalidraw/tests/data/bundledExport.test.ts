import { BUNDLED_EXPORT_MAX_FRAMES, MIME_TYPES } from "@excalidraw/common";

import { syncInvalidIndices } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  FileId,
  NonDeleted,
} from "@excalidraw/element/types";

import { getDefaultAppState } from "../../appState";

import { exportCanvas, prepareElementsForExport } from "../../data";
import { blobToArrayBuffer } from "../../data/blob";
import {
  bundledExport,
  exportBundle,
  getBundleFilenames,
  parseBundle,
  trackProgress,
} from "../../data/bundledExport";
import { fileSave } from "../../data/filesystem";
import { decodePngMetadata } from "../../data/image";
import { createZip, crc32 } from "../../data/zip";
import { API } from "../helpers/api";
import { readZip } from "../helpers/zip";

import type { exportToPngBlob } from "../../data";

import type {
  BundleSettings,
  Mission,
  MissionFailure,
  MissionReport,
  MissionResult,
} from "../../data/bundledExport";
import type { AppState, BinaryFileData, BinaryFiles } from "../../types";

// the file is never actually saved in tests, we only capture what would be
vi.mock("../../data/filesystem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/filesystem")>()),
  fileSave: vi.fn(),
}));

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

type SavedFile = {
  bytes: Uint8Array;
  type: string;
  name: string;
  extension: string;
  mimeTypes?: string[];
};

const toBytes = async (blob: Blob) =>
  new Uint8Array(await blobToArrayBuffer(blob));

const toBlob = (text: string) => new Blob([text], { type: MIME_TYPES.png });

const toText = (bytes: Uint8Array) => String.fromCharCode(...bytes);

const createAppState = (overrides: Partial<AppState> = {}): AppState => ({
  ...getDefaultAppState(),
  width: 1000,
  height: 1000,
  offsetTop: 0,
  offsetLeft: 0,
  ...overrides,
});

const createFrame = (
  id: string,
  opts: { x?: number; y?: number; width?: number; height?: number } = {},
  name: string | null = null,
): NonDeleted<ExcalidrawFrameElement> => ({
  ...API.createElement({ type: "frame", id, y: 0, ...opts }),
  name,
});

/**
 * - frame A, with a child sticking out of it (gets clipped), and an element
 *   which isn't in the frame but overlaps it (gets exported with it)
 * - frame B, on its own
 * - frame C, overlapping frame A, with a child that lies within frame A
 */
const createScene = () => {
  const frameA = createFrame("frame-a", {
    x: 0,
    y: 0,
    width: 200,
    height: 100,
  });
  const frameB = createFrame(
    "frame-b",
    { x: 400, y: 0, width: 120, height: 80 },
    "Second frame",
  );
  const frameC = createFrame("frame-c", {
    x: 100,
    y: 50,
    width: 150,
    height: 150,
  });

  const elements: ExcalidrawElement[] = [
    API.createElement({
      type: "rectangle",
      x: 150,
      y: 20,
      width: 100,
      height: 60,
      backgroundColor: "#ffc9c9",
      frameId: frameA.id,
    }),
    API.createElement({
      type: "ellipse",
      x: -30,
      y: -30,
      width: 80,
      height: 80,
    }),
    frameA,
    API.createElement({
      type: "diamond",
      x: 410,
      y: 10,
      width: 60,
      height: 60,
      frameId: frameB.id,
    }),
    frameB,
    API.createElement({
      type: "rectangle",
      x: 110,
      y: 60,
      width: 50,
      height: 30,
      frameId: frameC.id,
    }),
    frameC,
    // not in any frame, not overlapping any frame
    API.createElement({ type: "rectangle", x: 2000, y: 2000 }),
  ];

  // elements in the editor always have (fractional) indices
  syncInvalidIndices(elements);

  return { elements, frames: [frameA, frameB, frameC] };
};

const createSettings = (
  elements: readonly ExcalidrawElement[],
  appState: AppState = createAppState(),
  files: BinaryFiles = {},
): BundleSettings => ({
  elements,
  appState,
  files,
  exportBackground: appState.exportBackground,
  viewBackgroundColor: appState.viewBackgroundColor,
});

const createFile = (id: string, dataURL: string): BinaryFileData => ({
  id: id as FileId,
  dataURL: dataURL as BinaryFileData["dataURL"],
  mimeType: MIME_TYPES.png,
  created: 1,
});

/** images load, unless their data URL says otherwise */
const BROKEN_IMAGE = "data:image/png;base64,BROKEN";
const mockImageLoading = () => {
  vi.stubGlobal(
    "Image",
    class extends Image {
      constructor() {
        super();
        queueMicrotask(() => {
          if (this.src === BROKEN_IMAGE) {
            this.onerror?.("Image failed to load");
          } else {
            this.onload?.({} as Event);
          }
        });
      }
    },
  );
};

// `toBlob()` of the canvas mock, which creates a blob of width * height * 4
// zero bytes
const canvasMockToBlob = HTMLCanvasElement.prototype.toBlob;

/** canvases that were turned into images, in order */
let exportedCanvases: HTMLCanvasElement[];
/** return a blob (or null) to override what the canvas is turned into */
let toBlobOverride: ((canvas: HTMLCanvasElement) => Blob | null | void) | null;

/** everything that's been drawn on the canvases turned into images */
const describeExportedCanvases = () =>
  exportedCanvases.map((canvas) => ({
    width: canvas.width,
    height: canvas.height,
    drawEvents: (canvas.getContext("2d") as any).__getEvents() as unknown[],
  }));

const createMission = (
  id: string,
  run: () => Promise<MissionReport<string>> = async () => ({
    output: `output of ${id}`,
    problems: [],
  }),
): Mission<string> => ({ id, label: `Mission ${id}`, run });

let savedFiles: SavedFile[];

beforeEach(() => {
  exportedCanvases = [];
  toBlobOverride = null;
  HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
    exportedCanvases.push(this);
    const blob = toBlobOverride?.(this);
    if (blob === undefined) {
      canvasMockToBlob.call(this, callback, ...rest);
    } else {
      setTimeout(() => callback(blob));
    }
  };

  savedFiles = [];
  vi.mocked(fileSave).mockReset();
  vi.mocked(fileSave).mockImplementation(async (blob, opts) => {
    blob = await blob;
    savedFiles.push({
      bytes: await toBytes(blob),
      type: blob.type,
      name: opts.name,
      extension: opts.extension,
      mimeTypes: opts.mimeTypes,
    });
    return null;
  });
});

afterEach(() => {
  HTMLCanvasElement.prototype.toBlob = canvasMockToBlob;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** exports the frame the way it's done today when it's selected on its own */
const exportFrameAlone = async (
  frame: NonDeleted<ExcalidrawFrameElement>,
  { elements, appState, files, ...exportSettings }: BundleSettings,
) => {
  const selection = { selectedElementIds: { [frame.id]: true } as const };

  // ImageExportDialog
  const { exportedElements, exportingFrame } = prepareElementsForExport(
    elements,
    selection,
    true,
  );
  // App.onExportImage
  await exportCanvas(
    "png",
    exportedElements,
    { ...appState, ...selection },
    files,
    { ...exportSettings, exportingFrame },
  );

  const file = savedFiles.pop()!;
  expect(file.extension).toMatch(/png$/);
  return file.bytes;
};

/** the only file that's been saved, which is expected to be an archive */
const getSavedArchive = () => {
  expect(savedFiles.length).toBe(1);
  const archive = savedFiles.pop()!;
  expect(archive.extension).toBe("zip");
  return readZip(archive.bytes);
};

// -----------------------------------------------------------------------------
// tests
// -----------------------------------------------------------------------------

describe("parseBundle", () => {
  it("forms a mission for each frame", () => {
    const { elements, frames } = createScene();

    const missions = parseBundle(frames, createSettings(elements));

    expect(missions.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "frame-a", label: "Frame" },
      { id: "frame-b", label: "Second frame" },
      { id: "frame-c", label: "Frame" },
    ]);
  });

  it("doesn't export a frame twice", () => {
    const { elements, frames } = createScene();

    const missions = parseBundle(
      [frames[0], frames[1], frames[0]],
      createSettings(elements),
    );

    expect(missions.map((mission) => mission.id)).toEqual([
      "frame-a",
      "frame-b",
    ]);
  });

  it("hands each frame to the export pipeline as if it was the only one selected", async () => {
    const { elements, frames } = createScene();
    const appState = createAppState({
      exportBackground: false,
      viewBackgroundColor: "#abcdef",
      selectedElementIds: Object.fromEntries(
        frames.map((frame) => [frame.id, true as const]),
      ),
    });
    const settings = createSettings(elements, appState);
    const exportFrame = vi.fn(async () => toBlob("image"));

    const missions = parseBundle(frames, settings, exportFrame);

    // parsing alone must not export anything
    expect(exportFrame).not.toHaveBeenCalled();

    for (const [index, frame] of frames.entries()) {
      const report = await missions[index].run();
      expect(report.problems).toEqual([]);
      expect(toText(await toBytes(report.output))).toBe("image");

      const expected = prepareElementsForExport(
        elements,
        { selectedElementIds: { [frame.id]: true } },
        true,
      );
      // sanity check: it's the single-frame branch of the pipeline
      expect(expected.exportingFrame).toBe(frame);

      expect(exportFrame).toHaveBeenCalledTimes(index + 1);
      const [exportedElements, exportAppState, files, opts] = exportFrame.mock
        .lastCall! as unknown as Parameters<typeof exportToPngBlob>;
      expect(exportedElements).toEqual(expected.exportedElements);
      expect(exportAppState).toEqual({
        ...appState,
        selectedElementIds: { [frame.id]: true },
      });
      expect(files).toBe(settings.files);
      expect(opts).toEqual({
        exportBackground: false,
        viewBackgroundColor: "#abcdef",
        exportingFrame: frame,
        onImageErrors: expect.any(Function),
      });
    }
  });

  it("only includes what belongs to the frame when frames overlap", async () => {
    const { elements, frames } = createScene();
    const [frameA, , frameC] = frames;
    const exportFrame = vi.fn(async () => toBlob("image"));
    const missions = parseBundle(frames, createSettings(elements), exportFrame);

    await missions[0].run();
    await missions[2].run();

    const describeExported = (call: number) =>
      (exportFrame.mock.calls[call] as unknown as [ExcalidrawElement[]])[0].map(
        ({ type, frameId }) => ({ type, frameId }),
      );

    // Frame A: its child and the loose element overlapping it. Frame C
    // overlaps it too, so it's there as well (though frames aren't drawn when
    // exporting a frame), but frame C's child isn't, even if it lies within
    // frame A.
    expect(describeExported(0)).toEqual([
      { type: "rectangle", frameId: frameA.id },
      { type: "ellipse", frameId: null },
      { type: "frame", frameId: null },
      { type: "frame", frameId: null },
    ]);
    // Frame C: its child, and frame A which overlaps it. Not frame A's child.
    expect(describeExported(1)).toEqual([
      { type: "frame", frameId: null },
      { type: "rectangle", frameId: frameC.id },
      { type: "frame", frameId: null },
    ]);
  });

  it("reports images that couldn't be rendered as a problem", async () => {
    const { elements, frames } = createScene();
    const exportFrame: typeof exportToPngBlob = async (
      _elements,
      _appState,
      _files,
      { onImageErrors },
    ) => {
      onImageErrors?.(["file-1" as FileId, "file-2" as FileId]);
      return toBlob("incomplete image");
    };

    const [mission] = parseBundle(
      frames,
      createSettings(elements),
      exportFrame,
    );
    const report = await mission.run();

    expect(toText(await toBytes(report.output))).toBe("incomplete image");
    expect(report.problems).toEqual(["Images that couldn't be rendered: 2"]);
  });

  it("fails the mission of a frame that's not in the scene", async () => {
    const { elements } = createScene();
    const exportFrame = vi.fn(async () => toBlob("image"));

    const [mission] = parseBundle(
      [createFrame("stray-frame")],
      createSettings(elements),
      exportFrame,
    );

    await expect(mission.run()).rejects.toThrow("Cannot export empty canvas.");
    expect(exportFrame).not.toHaveBeenCalled();
  });

  it("limits the number of frames in a bundle", () => {
    const createFrames = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        createFrame(`frame-${index}`, { x: index * 200 }),
      );

    const atLimit = createFrames(BUNDLED_EXPORT_MAX_FRAMES);
    expect(parseBundle(atLimit, createSettings(atLimit)).length).toBe(10);

    const overLimit = createFrames(BUNDLED_EXPORT_MAX_FRAMES + 1);
    expect(() => parseBundle(overLimit, createSettings(overLimit))).toThrow(
      "Cannot export more than 10 frames at once.",
    );

    expect(() => parseBundle([], createSettings([]))).toThrow(
      "There are no frames to export.",
    );
  });
});

describe("trackProgress", () => {
  it("completes the missions in the order of their ids", async () => {
    const started: string[] = [];
    const ids = ["frame-c", "Frame-b", "frame-a", "frame-10", "frame-9"];
    const createMissions = (ids: string[]) =>
      ids.map((id) =>
        createMission(id, async () => {
          started.push(id);
          return { output: id, problems: [] };
        }),
      );

    const results = await trackProgress(createMissions(ids));

    const expectedOrder = [
      "Frame-b",
      "frame-10",
      "frame-9",
      "frame-a",
      "frame-c",
    ];
    expect(started).toEqual(expectedOrder);
    expect(results.map((result) => result.id)).toEqual(expectedOrder);

    // same order no matter how the missions come in
    started.length = 0;
    await trackProgress(createMissions([...ids].reverse()));
    expect(started).toEqual(expectedOrder);
  });

  it("doesn't reorder the supplied missions", async () => {
    const missions = ["b", "a"].map((id) => createMission(id));
    await trackProgress(missions);
    expect(missions.map((mission) => mission.id)).toEqual(["b", "a"]);
  });

  it("runs one mission at a time, and reports progress after each", async () => {
    const timeline: string[] = [];
    const missions = ["c", "a", "b"].map((id) =>
      createMission(id, async () => {
        timeline.push(`start ${id}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        timeline.push(`end ${id}`);
        return { output: id, problems: [] };
      }),
    );

    const results = await trackProgress(missions, {
      onProgress: ({ completed, total }) =>
        timeline.push(`${completed}/${total}`),
    });

    expect(timeline).toEqual([
      "0/3",
      "start a",
      "end a",
      "1/3",
      "start b",
      "end b",
      "2/3",
      "start c",
      "end c",
      "3/3",
    ]);
    expect(results).toEqual([
      { id: "a", label: "Mission a", status: "successful", output: "a" },
      { id: "b", label: "Mission b", status: "successful", output: "b" },
      { id: "c", label: "Mission c", status: "successful", output: "c" },
    ]);
  });

  it("catches explicit and implicit failures, and carries on", async () => {
    const missions = [
      createMission("a"),
      createMission("b", async () => {
        throw new Error("render failed");
      }),
      createMission("c", async () => ({
        output: "incorrect output",
        problems: ["first problem", "second problem"],
      })),
      createMission("d", async () => {
        // eslint-disable-next-line no-throw-literal
        throw "not even an error";
      }),
      createMission("e"),
    ];

    const results = await trackProgress(missions);

    expect(results).toEqual([
      {
        id: "a",
        label: "Mission a",
        status: "successful",
        output: "output of a",
      },
      {
        id: "b",
        label: "Mission b",
        status: "failure",
        output: null,
        message: "render failed",
      },
      {
        id: "c",
        label: "Mission c",
        status: "failure",
        output: "incorrect output",
        message: "first problem\nsecond problem",
      },
      {
        id: "d",
        label: "Mission d",
        status: "failure",
        output: null,
        message: "not even an error",
      },
      {
        id: "e",
        label: "Mission e",
        status: "successful",
        output: "output of e",
      },
    ]);
  });

  it("reports each failure as soon as it's detected", async () => {
    const timeline: string[] = [];
    const createTimedMission = (
      id: string,
      outcome: () => MissionReport<string>,
    ) =>
      createMission(id, async () => {
        timeline.push(`start ${id}`);
        return outcome();
      });

    const failures: MissionFailure<string>[] = [];

    await trackProgress(
      [
        createTimedMission("d", () => ({ output: "d", problems: [] })),
        createTimedMission("c", () => ({ output: "c", problems: ["bad"] })),
        createTimedMission("b", () => {
          throw new Error("worse");
        }),
        createTimedMission("a", () => ({ output: "a", problems: [] })),
      ],
      {
        onFailure: (failure) => {
          failures.push(failure);
          timeline.push(`failure ${failure.id}: ${failure.message}`);
        },
      },
    );

    // failures come in while the remaining missions are yet to start, and
    // in the order they happened
    expect(timeline).toEqual([
      "start a",
      "start b",
      "failure b: worse",
      "start c",
      "failure c: bad",
      "start d",
    ]);
    expect(failures.map((failure) => failure.output)).toEqual([null, "c"]);
  });

  it("stops when cancelled in the middle of a mission", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const onProgress = vi.fn();
    const onFailure = vi.fn();

    const missions = [
      createMission("a", async () => {
        started.push("a");
        return { output: "a", problems: [] };
      }),
      createMission("b", async () => {
        started.push("b");
        controller.abort();
        // what the mission does after being cancelled doesn't matter
        throw new Error("render failed");
      }),
      createMission("c", async () => {
        started.push("c");
        return { output: "c", problems: [] };
      }),
    ];

    await expect(
      trackProgress(missions, {
        signal: controller.signal,
        onProgress,
        onFailure,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(started).toEqual(["a", "b"]);
    expect(onFailure).not.toHaveBeenCalled();
    expect(onProgress.mock.calls).toEqual([
      [{ completed: 0, total: 3 }],
      [{ completed: 1, total: 3 }],
    ]);
  });

  it("doesn't start when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn();

    await expect(
      trackProgress([{ id: "a", label: "a", run }], {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(run).not.toHaveBeenCalled();
  });
});

describe("createZip", () => {
  it("calculates CRC-32", () => {
    // the standard check value
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("packs files into an archive that can be read back", () => {
    const files = [
      { name: "first.png", data: new Uint8Array([1, 2, 3, 4, 5]) },
      { name: "empty.png", data: new Uint8Array() },
      { name: "frame_žluťoučký_框.png", data: new Uint8Array(1000).fill(7) },
    ];

    expect(readZip(createZip(files))).toEqual(files);
  });

  it("creates an empty archive", () => {
    const archive = createZip([]);
    expect(archive.length).toBe(22);
    expect(readZip(archive)).toEqual([]);
  });

  it("is deterministic for a given time", () => {
    const files = [{ name: "a.png", data: new Uint8Array([1, 2, 3]) }];
    const date = new Date(2026, 9, 4, 12, 30, 10);

    expect(createZip(files, date)).toEqual(createZip(files, date));

    // DOS time & date of the entry
    const view = new DataView(createZip(files, date).buffer);
    expect(view.getUint16(10, true)).toBe((12 << 11) | (30 << 5) | 5);
    expect(view.getUint16(12, true)).toBe((46 << 9) | (10 << 5) | 4);
  });

  it("refuses files with the same name", () => {
    expect(() =>
      createZip([
        { name: "a.png", data: new Uint8Array() },
        { name: "a.png", data: new Uint8Array() },
      ]),
    ).toThrow('Duplicate filename in a ZIP archive: "a.png"');
  });
});

describe("getBundleFilenames", () => {
  it("tells successful and failed frames apart", () => {
    expect(
      getBundleFilenames([
        { id: "id1", status: "successful" },
        { id: "id2", status: "failure" },
      ]),
    ).toEqual(["frame_id1_successful.png", "frame_id2_failure.png"]);
  });

  it("keeps the ids generated by the editor as they are", () => {
    expect(
      getBundleFilenames([
        { id: "Vb0E2WG_5-lJzcqZ9IqNM", status: "successful" },
      ]),
    ).toEqual(["frame_Vb0E2WG_5-lJzcqZ9IqNM_successful.png"]);
  });

  it("makes unsafe ids safe to use as filenames", () => {
    expect(
      getBundleFilenames([
        { id: "../../etc/passwd", status: "successful" },
        { id: 'a b:c*d?"e<f>g|h\\i', status: "successful" },
        { id: "框架", status: "successful" },
        { id: "", status: "failure" },
        { id: "x".repeat(300), status: "successful" },
      ]),
    ).toEqual([
      "frame_______etc_passwd_successful.png",
      "frame_a_b_c_d__e_f_g_h_i_successful.png",
      "frame____successful.png",
      "frame___failure.png",
      `frame_${"x".repeat(64)}_successful.png`,
    ]);
  });

  it("never produces the same filename twice", () => {
    const filenames = getBundleFilenames([
      { id: "a/b", status: "successful" },
      { id: "a?b", status: "successful" },
      // same on filesystems which aren't case-sensitive
      { id: "A_B", status: "failure" },
      { id: "a_b-2", status: "successful" },
    ]);

    expect(filenames).toEqual([
      "frame_a_b_successful.png",
      "frame_a_b-2_successful.png",
      "frame_A_B-3_failure.png",
      "frame_a_b-2-2_successful.png",
    ]);
    expect(new Set(filenames.map((name) => name.toLowerCase())).size).toBe(4);
  });

  it("is stable", () => {
    const results = [
      { id: "frame-a", status: "successful" },
      { id: "frame/a", status: "failure" },
    ] as const;

    expect(getBundleFilenames(results)).toEqual(getBundleFilenames(results));
  });
});

describe("exportBundle", () => {
  const results: MissionResult<Blob>[] = [
    {
      id: "a",
      label: "Frame a",
      status: "successful",
      output: toBlob("image of a"),
    },
    {
      id: "b",
      label: "Frame b",
      status: "failure",
      output: null,
      message: "render failed",
    },
    {
      id: "c",
      label: "Frame c",
      status: "failure",
      output: toBlob("incorrect image of c"),
      message: "Images that couldn't be rendered: 1",
    },
  ];

  it("packs all the results, failed ones included, and saves the archive", async () => {
    const getPlaceholder = vi.fn(async (failure: MissionFailure<Blob>) =>
      toBlob(`placeholder for ${failure.id}`),
    );

    await exportBundle(results, { name: "my drawing", getPlaceholder });

    expect(savedFiles.length).toBe(1);
    expect(savedFiles[0]).toMatchObject({
      name: "my drawing",
      extension: "zip",
      mimeTypes: ["application/zip"],
      type: "application/zip",
    });

    const files = getSavedArchive();
    expect(
      files.map((file) => ({ name: file.name, content: toText(file.data) })),
    ).toEqual([
      { name: "frame_a_successful.png", content: "image of a" },
      // nothing was rendered, so there's a placeholder instead
      { name: "frame_b_failure.png", content: "placeholder for b" },
      // rendered incorrectly, but rendered
      { name: "frame_c_failure.png", content: "incorrect image of c" },
    ]);

    expect(getPlaceholder).toHaveBeenCalledTimes(1);
    expect(getPlaceholder).toHaveBeenCalledWith(results[1]);
  });

  it("requests the file before the results are in", async () => {
    let resolveResults!: (results: MissionResult<Blob>[]) => void;
    const pendingResults = new Promise<MissionResult<Blob>[]>((resolve) => {
      resolveResults = resolve;
    });
    const save = vi.fn(async (blob: Blob | Promise<Blob>) => {
      await blob;
      return null;
    });

    const saving = exportBundle(pendingResults, {
      name: "bundle",
      getPlaceholder: () => toBlob("placeholder"),
      save,
    });

    expect(save).toHaveBeenCalledTimes(1);

    resolveResults(results);
    await saving;
    const archive = await save.mock.calls[0][0];
    expect(readZip(await toBytes(archive)).length).toBe(3);
  });

  it("doesn't save anything if the results never come", async () => {
    await expect(
      exportBundle(Promise.reject(new Error("cancelled")), {
        name: "bundle",
        getPlaceholder: () => toBlob("placeholder"),
      }),
    ).rejects.toThrow("cancelled");

    expect(savedFiles).toEqual([]);
  });
});

describe("bundledExport", () => {
  describe("matches exporting each frame on its own", () => {
    const exportBothWays = async (appStateOverrides: Partial<AppState>) => {
      const { elements, frames } = createScene();
      const settings = createSettings(
        elements,
        createAppState({
          ...appStateOverrides,
          selectedElementIds: Object.fromEntries(
            frames.map((frame) => [frame.id, true as const]),
          ),
        }),
      );

      const alone = [];
      for (const frame of frames) {
        alone.push(await exportFrameAlone(frame, settings));
      }
      const canvasesAlone = describeExportedCanvases();

      const results = await bundledExport(frames, {
        ...settings,
        name: "bundle",
      });
      const canvasesBundled = describeExportedCanvases().slice(
        canvasesAlone.length,
      );

      expect(results.map((result) => result.status)).toEqual(
        frames.map(() => "successful"),
      );

      return {
        frames,
        alone,
        canvasesAlone,
        bundled: getSavedArchive(),
        canvasesBundled,
      };
    };

    it.each([
      ["default settings", {}],
      ["no background", { exportBackground: false }],
      ["dark mode", { exportWithDarkMode: true }],
      ["scale", { exportScale: 2 }],
      [
        "custom background, frame outlines disabled",
        {
          viewBackgroundColor: "#ffec99",
          frameRendering: {
            enabled: true,
            clip: false,
            name: false,
            outline: false,
          },
        },
      ],
    ] as [string, Partial<AppState>][])("%s", async (_, appState) => {
      const { frames, alone, canvasesAlone, bundled, canvasesBundled } =
        await exportBothWays(appState);

      expect(bundled.map((file) => file.name)).toEqual([
        "frame_frame-a_successful.png",
        "frame_frame-b_successful.png",
        "frame_frame-c_successful.png",
      ]);

      const scale = appState.exportScale ?? 1;

      frames.forEach((frame, index) => {
        // the image is the same, byte for byte
        expect(bundled[index].data).toEqual(alone[index]);

        // ...and so is everything that was drawn to produce it (the canvas is
        // mocked in tests, so the bytes only tell us the image size)
        expect(canvasesBundled[index]).toEqual(canvasesAlone[index]);
        expect(canvasesBundled[index].drawEvents.length).toBeGreaterThan(0);

        // clipped to the frame
        expect(canvasesBundled[index].width).toBe(frame.width * scale);
        expect(canvasesBundled[index].height).toBe(frame.height * scale);
      });
    });

    it("respects whether the background is exported", async () => {
      const withBackground = await exportBothWays({ exportBackground: true });
      const withoutBackground = await exportBothWays({
        exportBackground: false,
      });

      expect(withBackground.canvasesBundled[0].drawEvents).not.toEqual(
        withoutBackground.canvasesBundled[0].drawEvents,
      );
    });

    it("embedded scene", async () => {
      // jsdom can't encode a canvas into PNG, and we need a real one to be
      // able to embed the scene into it
      const png = await API.loadFile("./fixtures/smiley.png");
      toBlobOverride = () => png;

      const { elements, frames } = createScene();
      const settings = createSettings(
        elements,
        createAppState({ exportEmbedScene: true }),
      );

      const alone = [];
      for (const frame of frames) {
        alone.push(await exportFrameAlone(frame, settings));
      }

      await bundledExport(frames, { ...settings, name: "bundle" });
      const bundled = getSavedArchive();

      for (const [index, frame] of frames.entries()) {
        expect(bundled[index].data).toEqual(alone[index]);
        expect(bundled[index].data.length).toBeGreaterThan(png.size);

        // the scene embedded in each image is the one of its frame
        const { elements: embeddedElements } = JSON.parse(
          await decodePngMetadata(new Blob([bundled[index].data])),
        );
        expect(
          embeddedElements.map((element: ExcalidrawElement) => element.id),
        ).toEqual(
          prepareElementsForExport(
            elements,
            { selectedElementIds: { [frame.id]: true } },
            true,
          ).exportedElements.map((element) => element.id),
        );
      }

      // sanity check: the frames don't all embed the same scene
      expect(bundled[1].data).not.toEqual(bundled[0].data);
    });
  });

  describe("failures", () => {
    /** frame A has a broken image in it, frame B is too big to be rendered */
    const createFailingScene = () => {
      const frameA = createFrame("frame-a", { width: 200, height: 100 });
      const frameB = createFrame("frame-b", { x: 400, width: 333, height: 80 });
      const frameC = createFrame("frame-c", { x: 800, width: 50, height: 40 });

      const elements: ExcalidrawElement[] = [
        API.createElement({
          type: "image",
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          fileId: "broken-file",
          frameId: frameA.id,
        }),
        API.createElement({
          type: "image",
          x: 100,
          y: 10,
          width: 50,
          height: 50,
          fileId: "healthy-file",
          frameId: frameA.id,
        }),
        frameA,
        frameB,
        API.createElement({
          type: "image",
          x: 810,
          y: 10,
          width: 20,
          height: 20,
          fileId: "healthy-file",
          frameId: frameC.id,
        }),
        frameC,
      ];

      const files: BinaryFiles = {
        "broken-file": createFile("broken-file", BROKEN_IMAGE),
        "healthy-file": createFile(
          "healthy-file",
          "data:image/png;base64,HEALTHY",
        ),
      };

      return { elements, frames: [frameA, frameB, frameC], files };
    };

    const SCALE = 2;

    beforeEach(() => {
      mockImageLoading();

      // what browsers do when the canvas is too big
      toBlobOverride = (canvas) =>
        canvas.width === 333 * SCALE ? null : undefined;
    });

    it("identifies the failed frames, and doesn't leave them out of the archive", async () => {
      const { elements, frames, files } = createFailingScene();
      const failures: MissionFailure<Blob>[] = [];
      const onProgress = vi.fn();

      const results = await bundledExport(frames, {
        ...createSettings(
          elements,
          createAppState({ exportScale: SCALE }),
          files,
        ),
        name: "bundle",
        onProgress,
        onFailure: (failure) => failures.push(failure),
      });

      expect(
        results.map(({ id, status, ...rest }) => ({
          id,
          status,
          message: "message" in rest ? rest.message : null,
        })),
      ).toEqual([
        {
          id: "frame-a",
          status: "failure",
          message: "Images that couldn't be rendered: 1",
        },
        {
          id: "frame-b",
          status: "failure",
          message: "Error: Canvas too big",
        },
        { id: "frame-c", status: "successful", message: null },
      ]);

      // reported in the order they happened
      expect(failures).toEqual([results[0], results[1]]);
      expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
        { completed: 0, total: 3 },
        { completed: 1, total: 3 },
        { completed: 2, total: 3 },
        { completed: 3, total: 3 },
      ]);

      const archive = getSavedArchive();
      expect(
        archive.map((file) => ({ name: file.name, size: file.data.length })),
      ).toEqual([
        // rendered, but without one of the images, so it's kept as is
        {
          name: "frame_frame-a_failure.png",
          size: 200 * SCALE * (100 * SCALE) * 4,
        },
        // couldn't be rendered, so it's a blank placeholder (which isn't
        // scaled, hence the different size)
        { name: "frame_frame-b_failure.png", size: 333 * 80 * 4 },
        {
          name: "frame_frame-c_successful.png",
          size: 50 * SCALE * (40 * SCALE) * 4,
        },
      ]);
    });

    it("reports an image that's missing altogether", async () => {
      const { elements, frames } = createFailingScene();

      const results = await bundledExport([frames[0], frames[2]], {
        ...createSettings(elements),
        name: "bundle",
      });

      expect(results).toMatchObject([
        {
          id: "frame-a",
          status: "failure",
          message: "Images that couldn't be rendered: 2",
        },
        {
          id: "frame-c",
          status: "failure",
          message: "Images that couldn't be rendered: 1",
        },
      ]);
    });

    it("exporting a single frame the old way isn't affected by a broken image", async () => {
      const { elements, frames, files } = createFailingScene();

      const bytes = await exportFrameAlone(
        frames[0],
        createSettings(elements, createAppState(), files),
      );

      expect(bytes.length).toBe(200 * 100 * 4);
    });

    it("scales down the placeholder of a big frame", async () => {
      const frame = createFrame("big", { width: 1000, height: 2000 });
      toBlobOverride = (canvas) => (canvas.height === 2000 ? null : undefined);

      const results = await bundledExport([frame], {
        ...createSettings([frame]),
        name: "bundle",
      });

      expect(results[0].status).toBe("failure");
      const [placeholder] = getSavedArchive();
      // 512 at most, keeping the aspect ratio
      expect(placeholder.data.length).toBe(256 * 512 * 4);
    });
  });

  describe("cancelling", () => {
    it("stops exporting, and doesn't save a partial archive", async () => {
      const { elements, frames } = createScene();
      const controller = new AbortController();
      const onProgress = vi.fn(({ completed }) => {
        if (completed === 1) {
          controller.abort();
        }
      });

      await expect(
        bundledExport(frames, {
          ...createSettings(elements),
          name: "bundle",
          signal: controller.signal,
          onProgress,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      // the file was requested, but nothing was written into it
      expect(fileSave).toHaveBeenCalledTimes(1);
      expect(savedFiles).toEqual([]);
      // the remaining frames weren't rendered
      expect(exportedCanvases.length).toBe(1);
      expect(onProgress).toHaveBeenCalledTimes(2);
    });

    it("stops exporting when the file dialog is dismissed", async () => {
      const { elements, frames } = createScene();
      const onProgress = vi.fn();

      vi.mocked(fileSave).mockImplementation(async () => {
        throw new DOMException("The user aborted a request.", "AbortError");
      });

      await expect(
        bundledExport(frames, {
          ...createSettings(elements),
          name: "bundle",
          onProgress,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      // let the mission that was in progress finish
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(exportedCanvases.length).toBeLessThan(frames.length);
      expect(onProgress).not.toHaveBeenCalledWith({ completed: 3, total: 3 });
    });

    it("doesn't export anything when cancelled beforehand", async () => {
      const { elements, frames } = createScene();
      const controller = new AbortController();
      controller.abort();

      await expect(
        bundledExport(frames, {
          ...createSettings(elements),
          name: "bundle",
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(exportedCanvases).toEqual([]);
      expect(savedFiles).toEqual([]);
    });
  });

  it("doesn't request a file when there's nothing to export", async () => {
    await expect(
      bundledExport([], { ...createSettings([]), name: "bundle" }),
    ).rejects.toThrow("There are no frames to export.");

    expect(fileSave).not.toHaveBeenCalled();
  });

  it("reports that saving failed", async () => {
    const { elements, frames } = createScene();
    vi.mocked(fileSave).mockImplementation(async (blob) => {
      await blob;
      throw new Error("Disk full");
    });

    await expect(
      bundledExport(frames, { ...createSettings(elements), name: "bundle" }),
    ).rejects.toThrow("Disk full");
  });
});
