/**
 * Bundled export: exports several frames in one operation, as a ZIP archive
 * containing one PNG image per frame.
 *
 * The work is split into three steps that don't know about each other:
 *
 * 1. `parseBundle()`    turns the selected frames into missions, one per frame.
 *                       A mission renders its frame through the very same
 *                       pipeline as when exporting that frame on its own.
 * 2. `trackProgress()`  runs the missions one by one, reporting progress and
 *                       failures. It knows nothing about frames or rendering.
 * 3. `exportBundle()`   packs the results into an archive and saves it. It
 *                       knows nothing about how the results were produced.
 *
 * `bundledExport()` wires the three together.
 */

import { BUNDLED_EXPORT_MAX_FRAMES, MIME_TYPES } from "@excalidraw/common";

import { getFrameLikeTitle } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  FileId,
  NonDeleted,
} from "@excalidraw/element/types";

import { AbortError } from "../errors";
import { t } from "../i18n";

import { blobToArrayBuffer, canvasToBlob } from "./blob";
import { fileSave } from "./filesystem";
import { createZip } from "./zip";

// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { exportToPngBlob, prepareElementsForExport } from ".";

import type { AppState, BinaryFiles } from "../types";

// -----------------------------------------------------------------------------
// missions
// -----------------------------------------------------------------------------

export type MissionReport<T> = {
  output: T;
  /**
   * Problems which didn't stop the mission, but made its output incorrect
   * (implicit failures), e.g. an image that couldn't be loaded.
   */
  problems: readonly string[];
};

/**
 * A unit of work tracked by `trackProgress()`. The interface isn't specific
 * to frames, so that other kinds of batch operations can reuse the tracking.
 */
export type Mission<T> = {
  /** unique identifier (missions are completed in the order of their ids) */
  id: string;
  /** human-readable name, used when reporting on the mission */
  label: string;
  /** Rejecting is an explicit failure, returning `problems` an implicit one. */
  run: (signal?: AbortSignal) => Promise<MissionReport<T>>;
};

export type MissionResult<T> = { id: string; label: string } & (
  | { status: "successful"; output: T }
  | {
      status: "failure";
      /** incorrect output of an implicit failure, `null` for an explicit one */
      output: T | null;
      message: string;
    }
);

export type MissionFailure<T = unknown> = Extract<
  MissionResult<T>,
  { status: "failure" }
>;

export type MissionProgress = { completed: number; total: number };

// -----------------------------------------------------------------------------
// 1. parseBundle
// -----------------------------------------------------------------------------

export type BundleSettings = {
  /** all scene elements (not just the frames and their children) */
  elements: readonly ExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
  exportBackground: boolean;
  viewBackgroundColor: string;
};

/**
 * Forms a mission for each of the supplied frames. Running the mission exports
 * the frame the same way as if it was the only selected element when
 * exporting to PNG.
 *
 * @param exportFrame the single-image export pipeline to delegate to
 */
export const parseBundle = (
  frames: readonly NonDeleted<ExcalidrawFrameLikeElement>[],
  { elements, appState, files, ...exportSettings }: BundleSettings,
  exportFrame: typeof exportToPngBlob = exportToPngBlob,
): Mission<Blob>[] => {
  const uniqueFrames = Array.from(
    new Map(frames.map((frame) => [frame.id, frame])).values(),
  );

  if (uniqueFrames.length === 0) {
    throw new Error(t("bundledExport.errors.noFrames"));
  }
  if (uniqueFrames.length > BUNDLED_EXPORT_MAX_FRAMES) {
    throw new Error(
      t("bundledExport.errors.tooManyFrames", {
        max: BUNDLED_EXPORT_MAX_FRAMES,
      }),
    );
  }

  return uniqueFrames.map((frame) => ({
    id: frame.id,
    label: getFrameLikeTitle(frame),
    run: async () => {
      // exporting a frame on its own means the frame is the sole selected
      // element, so that's the state we recreate for each mission
      const frameAppState: AppState = {
        ...appState,
        selectedElementIds: { [frame.id]: true },
      };

      const { exportedElements, exportingFrame } = prepareElementsForExport(
        elements,
        frameAppState,
        true,
      );

      if (exportingFrame?.id !== frame.id) {
        throw new Error(t("alerts.cannotExportEmptyCanvas"));
      }

      const failedFileIds: FileId[] = [];

      const output = await exportFrame(exportedElements, frameAppState, files, {
        ...exportSettings,
        exportingFrame,
        onImageErrors: (fileIds) => failedFileIds.push(...fileIds),
      });

      return {
        output,
        problems: failedFileIds.length
          ? [
              t("bundledExport.errors.imagesNotRendered", {
                count: failedFileIds.length,
              }),
            ]
          : [],
      };
    },
  }));
};

// -----------------------------------------------------------------------------
// 2. trackProgress
// -----------------------------------------------------------------------------

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new AbortError();
  }
};

/**
 * Completes the missions one at a time, in the order of their ids.
 *
 * A failing mission doesn't stop the remaining ones. Each failure, whether
 * explicit (mission rejected) or implicit (mission reported problems), is
 * passed to `onFailure` as soon as it's detected, and ends up in the results.
 *
 * Aborting the signal rejects with an AbortError (no results are returned).
 */
export const trackProgress = async <T>(
  missions: readonly Mission<T>[],
  {
    signal,
    onProgress,
    onFailure,
  }: {
    signal?: AbortSignal;
    onProgress?: (progress: MissionProgress) => void;
    onFailure?: (failure: MissionFailure<T>) => void;
  } = {},
): Promise<MissionResult<T>[]> => {
  const orderedMissions = [...missions].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const total = orderedMissions.length;
  const results: MissionResult<T>[] = [];

  onProgress?.({ completed: 0, total });

  for (const { id, label, run } of orderedMissions) {
    throwIfAborted(signal);

    let result: MissionResult<T>;

    try {
      const { output, problems } = await run(signal);

      result = problems.length
        ? { id, label, status: "failure", output, message: problems.join("\n") }
        : { id, label, status: "successful", output };
    } catch (error: any) {
      result = {
        id,
        label,
        status: "failure",
        output: null,
        message: error?.message || String(error),
      };
    }

    // cancelled while the mission was running
    throwIfAborted(signal);

    if (result.status === "failure") {
      onFailure?.(result);
    }
    results.push(result);
    onProgress?.({ completed: results.length, total });
  }

  return results;
};

// -----------------------------------------------------------------------------
// 3. exportBundle
// -----------------------------------------------------------------------------

const MAX_FILENAME_ID_LENGTH = 64;

/**
 * Returns a filename for each result. The names are made of frame ids since,
 * unlike frame names, they are always there and are unique. Whether the
 * frame was exported correctly is a part of the name:
 *
 *   frame_<id>_successful.png
 *   frame_<id>_failure.png
 */
export const getBundleFilenames = (
  results: readonly Pick<MissionResult<unknown>, "id" | "status">[],
): string[] => {
  const usedStems = new Set<string>();

  return results.map(({ id, status }) => {
    // ids can be arbitrary strings when coming from a file or the API
    const safeId =
      id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_FILENAME_ID_LENGTH) ||
      "_";

    // sanitizing can make two ids equal, and so can filesystems which
    // aren't case-sensitive
    let stem = `frame_${safeId}`;
    for (let n = 2; usedStems.has(stem.toLowerCase()); n++) {
      stem = `frame_${safeId}-${n}`;
    }
    usedStems.add(stem.toLowerCase());

    return `${stem}_${status}.png`;
  });
};

/**
 * Packs the results into a ZIP archive, and saves it to a file.
 *
 * Every result gets a file, including failures: an implicit failure keeps its
 * (incorrect) output, an explicit one has no output so a placeholder is used.
 *
 * Results can be supplied as a promise, in which case the file is requested
 * right away (browsers only allow that shortly after a user action), and is
 * written once the results are in.
 */
export const exportBundle = (
  results: readonly MissionResult<Blob>[] | Promise<MissionResult<Blob>[]>,
  {
    name,
    getPlaceholder,
    save = fileSave,
  }: {
    /** archive filename, without the extension */
    name: string;
    /** creates an image for the failure which didn't produce one */
    getPlaceholder: (failure: MissionFailure<Blob>) => Blob | Promise<Blob>;
    save?: typeof fileSave;
  },
) => {
  const archive = Promise.resolve(results).then(async (results) => {
    const filenames = getBundleFilenames(results);

    const entries = await Promise.all(
      results.map(async (result, index) => {
        const blob =
          result.status === "failure"
            ? result.output ?? (await getPlaceholder(result))
            : result.output;
        return {
          name: filenames[index],
          data: new Uint8Array(await blobToArrayBuffer(blob)),
        };
      }),
    );

    return new Blob([createZip(entries)], { type: MIME_TYPES.zip });
  });

  // the rejection is handled by `save()`, unless it rejects first (e.g. user
  // dismissing the file dialog), in which case nobody's listening anymore
  archive.catch(() => {});

  return save(archive, {
    description: "Export frames to ZIP",
    name,
    extension: "zip",
    mimeTypes: [MIME_TYPES.zip],
  });
};

const MAX_PLACEHOLDER_SIZE = 512;

/** blank image standing in for a frame which couldn't be rendered at all */
export const createBlankPlaceholder = (
  frame: Pick<ExcalidrawFrameLikeElement, "width" | "height">,
  ownerDocument: Document = document,
) => {
  const scale = Math.min(
    1,
    MAX_PLACEHOLDER_SIZE / Math.max(frame.width, frame.height, 1),
  );
  const canvas = ownerDocument.createElement("canvas");
  canvas.width = Math.max(1, Math.round(frame.width * scale));
  canvas.height = Math.max(1, Math.round(frame.height * scale));

  return canvasToBlob(canvas);
};

// -----------------------------------------------------------------------------
// bundledExport
// -----------------------------------------------------------------------------

/**
 * Exports each of the frames into its own PNG image, and saves the images
 * as a single ZIP archive.
 *
 * @returns result for each frame, failed ones included. Rejects (AbortError)
 * if cancelled through the signal or by dismissing the file dialog, in which
 * case no archive is saved.
 */
export const bundledExport = async (
  frames: readonly NonDeleted<ExcalidrawFrameLikeElement>[],
  {
    name,
    signal,
    onProgress,
    onFailure,
    save,
    ownerDocument,
    ...settings
  }: BundleSettings & {
    /** archive filename, without the extension */
    name: string;
    /** document of the editor, in case it's not the global one */
    ownerDocument?: Document;
    signal?: AbortSignal;
    onProgress?: (progress: MissionProgress) => void;
    onFailure?: (failure: MissionFailure<Blob>) => void;
    save?: typeof fileSave;
  },
): Promise<MissionResult<Blob>[]> => {
  const missions = parseBundle(frames, settings);

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) {
    abort();
  }
  signal?.addEventListener("abort", abort);

  const results = trackProgress(missions, {
    signal: controller.signal,
    onProgress,
    onFailure,
  });

  const framesById = new Map(frames.map((frame) => [frame.id, frame]));

  try {
    await exportBundle(results, {
      name,
      getPlaceholder: (failure) =>
        createBlankPlaceholder(framesById.get(failure.id)!, ownerDocument),
      save,
    });
    return await results;
  } catch (error: any) {
    // no point in exporting the remaining frames if we can't save them
    abort();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
};
