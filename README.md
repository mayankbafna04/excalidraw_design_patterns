# Excalidraw - CMU 17-695

Course copy of [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) (MIT). See [`COURSE.md`](./COURSE.md).

## Run

Node >= 18 and Yarn 1.

```bash
yarn install
yarn start                 # http://localhost:3000
yarn test:typecheck
yarn test:code
yarn test:app --watch=false
```

Just Request 05:

```bash
yarn vitest run packages/element/tests/distribute.test.tsx \
  packages/element/tests/spacing.test.ts \
  packages/element/tests/distributeWithGap.test.tsx
```

---

## Samarth Shukla

- **Andrew ID:** sshukla3@andrew.cmu.edu
- **GitHub:** [@samarthshukla6](https://github.com/samarthshukla6)

### Request 05 - Arrange objects with a specified gap

The old Distribute buttons only even out leftover space inside whatever width the selection already has. You cannot type a number. This request lets you enter a gap (say 24) and space selected objects by that amount, even when they are different sizes.

### The change

![Before and after: distributeElements split into order, spacing rules, and move](docs/request-05-system-diagram.png)

`distributeElements` used to group, sort, compute gaps, and move shapes, and the move loop was written twice. It is now four parts:

1. **`orderSelectionUnits`** groups the selection into units (a group of shapes counts as one) and sorts by box centre. Same sort as before.
2. **`spaceBetween` / `fixedGap`** take bounding boxes and return how far to move each one. No scene, so they test on plain numbers.
   - `spaceBetween` is the old rule: equal leftover gaps inside the current extent, plus the old centre fallback when boxes do not fit.
   - `fixedGap` is new: first unit stays put, each next one starts at the previous end + the typed gap.
3. **`applyTranslations`** is the one move loop. Bound labels and arrows still update here.
4. **`distributeElements`** looks the rule up in a `spacingRules` table and runs the three.

`Distribution` is `{ space: "between" }` or `{ space: "fixedGap", gap }`. `gap` only exists on the new rule. The table is typed: a third rule with no entry is a compile error. The coordinator and the old actions stay as they are.

UI: two new actions (Distribute horizontally / vertically with gap, no shortcut) and a number input (min 0) in Align. Value is `appState.currentItemDistributeGap`, default **24**. The two old actions were not edited.

`perform` itself refuses the move if the selection has a **frame** (Excalidraw's container around other shapes), fewer than 3 units, or a negative / non-numeric gap. It returns the elements unchanged. This is not only a disabled button.

### Results of the checks

These are the proposal's step checks. All of them are in the repo. The Request 05 command under Run reruns the automated ones.

| Asked | Observed |
| --- | --- |
| Characterization tests first, using today's output (fixture + centre fallback) | Done first. A at x=0 w100, B (group of two) at x=120 w50, C at x=198 w80: old command gives **0, 124, 154, 198**. Centre fallback: **0, 100, 100**. |
| Extract group/sort and the move loop. Existing `distribute.test.tsx` unedited. Order test on overlapping shapes. | File unedited, **4/4**. Overlap order by centre: **B, A, C**. Group B is one unit: `[A], [B1, B2], [C]`. |
| Old math in `spaceBetween` still gives **0, 150, 300** | **0, 150, 300**, same as the old tests. |
| `fixedGap`: unequal widths, gap 0 (boxes touch), overlapping starts, first-by-centre does not move | Unequal: **0, 124, 198**. Gap 0: **0, 100, 150**. Overlap: first stays at **30**, then **140, 350**. |
| New actions. Reject negative gap and frames inside `perform`. Both commands with gap 24 match on the fixture. B is a group. | Both give **0, 124, 154, 198**. Negative gap, NaN, fewer than 3 units, or a frame: nothing moves. |
| Gap input, `appState` field, label. Snapshot diff is only the new key. | Only `currentItemDistributeGap: 24` (133 lines, all that key). |
| Integration: rotated rectangle, bound label, group, frame | Rotated unit: gap 24 on the rotated box. Label moves with its container. Group is one unit. Frame: no-op. |

`yarn test:typecheck`: 0 errors. `yarn test:code`: clean. `spacing.test.ts` **12/12**. `distributeWithGap.test.tsx` **20/20**. `align.test.tsx` **50/50**.

Manual (type a gap, click the button): three rects at 100/w200, 420/w90, 560/w160. Old button: **100, 385, 560** (gaps 85/85). New button at gap 60: **100, 360, 510** (first shape unmoved).

### What changed from the RFC

- **Offsets, not final positions.** The RFC had rules return where each box should sit. The code returns how far to move it, which is what the old function already computed. So `spaceBetween` matches today, including 0, 150, 300.
- **A third rule needs one table entry.** The RFC said no edit outside the new function and the union. The rule still has to be reachable, so it is one function, one union member, and one entry in `spacingRules`. The coordinator is not edited. Adding a dummy member produced one type error, on the table.
- **The two commands do not always agree.** Same positions only when the first object in order is also the leftmost. Otherwise the gaps match but the whole run shifts: `fixedGap` anchors on the first object, `spaceBetween` on the left edge of the selection. There is a test for each case.
- **Two files the RFC did not list:** `packages/common/src/constants.ts` (`DEFAULT_DISTRIBUTE_GAP = 24`) and `packages/excalidraw/components/Actions.scss` (gap row layout).

### What remains

- **Frames are not distributed.** A frame is Excalidraw's container around other shapes. The old buttons already refuse a selection that contains one (`TODO enable distributing frames when implemented properly`). The new buttons do the same, including inside `perform`. Frame support was out of scope.
- No keyboard shortcut. One axis per click.
- The gap is between **bounding boxes**. For a rotated shape that is the rotated box, not the drawn edge.
- Labels are in `en.json` only.

---

# Qingyuan Yao

- Andrew ID: `@qingyuay@andrew.cmu.edu`
- GitHub: `@JasonYao-QY`

# Request 08 – Export several frames in one operation

The old export image only exports one file. We could select a single frame, and export as a single frame; we could also select multiple frames and export as a giant frame containing all of them. The new features allows us to select multiple frame, choose between exporting a giant frame or several small frames, and independently check each export as success or failure.

## The change

The export of images used to be handled by the pipeline `ImageExportDialog` → `App.onExportImage` → `exportCanvas` (in `data/index.ts`) → `exportToCanvas` (in `scene/export.ts`) → `fileSave`. The bulk of the pipeline is not changed. We refactor `ImageExportDialog` to allow calling `App.onBundledExport`, which export in bundle, and we introduce a new module `bundledExport` to manage exporting several frame in one operation.

## BundledExport includes:

1. `parseBundle` parses the bundle sent in by `App.onBundledExport`, and each mission calls `exportToPngBlob`.

2. `trackProgress` tracks each mission’s failure and redirects the failure back to `App`, which shows them in `BundledExportStatus` inside `LayerUI`.

3. `exportBundle` calls `createZip` (in `data/zip.ts`) → `fileSave`.

Right now the original export operation as a giant frame also calls `exportToPngBlob` when exporting. Apart from that, every detail from the old export feature is kept.

UI: One new toggle `exportFramesSeparately` and one new display region `BundledExportStatus`.

There are 59 new tests written that cover clipping, image assets, cancellation, and a render failure, as according to the request. Now, there are a total of 76 tests included, as mentioned below in section Results of the checks.

## Results of the checks

These are proposal 08's step checks. 43 of them are in `tests/data/bundledExport.test.ts`, 15 of them are in `tests/bundledExport.test.tsx`, and 1 of them is in `tests/scene/export.test.ts`, added alongside the 18 existing functions for old features.

| Checks on the proposal | Tests | Count |
| --- | --- | --- |
| Toggle directs the workflow | `.tsx` › "toggle between a single image and an image per 10 frame" (8); `scene/export.test.ts` › the existing "should export multiple frames when selected…" and the new "should export each of the selected frames on its own when exported as a bundle" (2) | 10 |
| `parseBundle` parses frames into missions | `.ts` › `parseBundle` (7) | 7 |
| `trackProgress` uses deterministic frame-id order | `.ts` › `trackProgress` › "completes the missions in the order of their ids", "doesn't reorder the supplied missions" (2) | 2 |
| Missions launch correctly; results identical to individual export; cancellation | `.ts` › "runs one mission at a time…" (1); `.ts` › `bundledExport` › "matches exporting each frame on its own" (7); `.tsx` › "images in the archive are the same as when exporting each frame on its own" (1); cancel tests in `trackProgress` (2); `bundledExport` › "cancelling" (3); `.tsx` › "can be cancelled while exporting" (1) | 15 |
| Every error type caught and displayed, in chronological order | `.ts` › `trackProgress` › "catches explicit and implicit failures…", "reports each failure as soon as it's detected" (2); `.ts` › `parseBundle` › "reports images that couldn't be rendered as a problem" (1); `.ts` › `bundledExport` › "failures" (4); `.tsx` › "progress and failures" (4) | 11 |
| ZIP is packed once every result is in | `.ts` › `exportBundle` (3), `createZip` (5), `getBundleFilenames` (5), "reports that saving failed", "doesn't request a file when there's nothing to export" (2) | 15 |
| Existing tests | `scene/export.test.ts` (18) | 18 |

Manual checks also completed where separate frame export, one giant frame export, mid-task cancellation, scaling error and rendering error are all displayed.

## What changed from the RFC

- **Default outputs of failing frames.** The RFC’s comment is worth taking: originally the failure is designed to output as it is, but this creates an inconsistency between image-generating failures and failures without an output. Right now both failures generate a white canvas that outputs nothing, and “failure” is indicated by the filename inside the zip bundle.

- **`filesystem.ts` is not edited.** Its extension type is derived from `MIME_TYPES`, so adding zip in `constants.ts` was enough.

- **`LayerUI.tsx` gets a new panel instead of a changed error column.** `appState.errorMessage` and `ErrorDialog` are untouched. A new `BundledExportStatus` component, fed by a jotai atom, lists the failures; `LayerUI` only renders it.

- **Additional design choices that AI automatically implements without specification:** A 10-frame limit (`BUNDLED_EXPORT_MAX_FRAMES`); filename sanitising, with duplicates and case-only collisions suffixed; PNG only: the SVG and clipboard buttons are hidden while the toggle is on.

## What remains

- **The old feature.** A frame is still able to be exported on its own, and one giant frame export still remains. The system still defaults to exporting one frame when multiple frames are selected, and only changes when the toggle is manually turned on.

- **The old tests.** The 18 old tests for `export.ts` are kept, in order to track that the original features have stayed normal.

- **Old design patterns.** The pattern of parsing missions, tracking processes individually, and merging at the end proved to be effective. Moreover, it turns out that there are less refactoring needed than anticipated, so most changes are adding a framework that supports multiple processes in one operation.
