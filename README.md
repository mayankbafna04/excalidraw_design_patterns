# Excalidraw — CMU 17-695

Course copy of [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) (MIT). See [`COURSE.md`](./COURSE.md).

## Run

Needs Node >= 18 and Yarn 1. From this repo:

```bash
yarn install
yarn start                 # opens http://localhost:3000
```

Project checks:

```bash
yarn test:typecheck        # TypeScript
yarn test:code             # eslint
yarn test:app --watch=false
```

Request 05 tests only (old distribute + new spacing + new gap command):

```bash
yarn vitest run packages/element/tests/distribute.test.tsx \
  packages/element/tests/spacing.test.ts \
  packages/element/tests/distributeWithGap.test.tsx
```

---

## Samarth Shukla

- **Andrew ID:** sshukla3@andrew.cmu.edu
- **GitHub:** [@samarthshukla6](https://github.com/samarthshukla6)

### Request 05 — Arrange objects with a specified gap

The old _Distribute_ buttons only even out leftover space inside the selection’s current width or height. You cannot type a number. This request adds that: enter a gap (for example 24 drawing units) and arrange the selected objects with that spacing, even when they have different sizes.

### The change

![Before and after: distributeElements split into order, spacing rules, and move](docs/request-05-system-diagram.png)

The old `distributeElements` function grouped the selection, sorted it, computed gaps, and moved shapes — and the move loop was written twice. It is now four small parts:

1. **`orderSelectionUnits`** — groups the selection into movable units (a group of shapes counts as one) and sorts them by the centre of each unit’s bounding box. The sort is the same as before.
2. **`spaceBetween` and `fixedGap`** — the two spacing rules. Each takes bounding boxes and returns how far to move each one. They do not touch the scene, so they can be tested on plain numbers.
   - `spaceBetween` is today’s rule: equal leftover gaps inside the current extent (including the old “spread the centres” fallback when the boxes do not fit).
   - `fixedGap` is the new rule: first unit stays put; each next unit starts at the previous end + the typed gap.
3. **`applyTranslations`** — the single move loop. Bound labels and arrows are updated here, as before.
4. **`distributeElements`** — looks the requested rule up in a `spacingRules` table and runs the three parts.

`Distribution` is a union: `{ space: "between" }` or `{ space: "fixedGap", gap }`. `gap` exists only on the new rule. The table is typed so adding a third rule without an entry is a compile error. The coordinator and the old actions do not change when a rule is added.

On the UI: two new actions, _Distribute horizontally with gap_ and _Distribute vertically with gap_ (no keyboard shortcut), plus a number input (minimum 0) in the Align panel. The typed value is `appState.currentItemDistributeGap`, default **24**. The two old distribute actions were not edited.

Safety is inside `perform`, not only on the button: if the selection has a **frame** (Excalidraw’s container box around other shapes), fewer than 3 units, or a negative / non-numeric gap, the action returns the elements unchanged.

### Results of the checks

These are the proposal’s step checks. All of them live in the repo; the Request 05 command in **Run** reruns the automated ones.

| What the proposal asked to check | What we observed |
| --- | --- |
| Write characterization tests first, using today’s output as the expected result (the course fixture and the centre fallback). | Done first. Fixture A at x=0 w100, B (a group of two shapes) at x=120 w50, C at x=198 w80: old command → **0, 124, 154, 198**. Centre fallback (boxes too wide to fit): **0, 100, 100**. |
| Extract grouping/sorting and the move loop. Existing `distribute.test.tsx` must pass unedited. Also an order test on overlapping shapes. | File unedited, **4/4 pass**. Overlapping units sort by box centre as **B, A, C**. Group B is one unit: `[A], [B1, B2], [C]`. |
| Move the old math into `spaceBetween`. Unit tests must still give **0, 150, 300**. | **0, 150, 300** — same numbers the old tests assert. |
| Add `fixedGap`. Check unequal widths, gap 0 (boxes touch), overlapping starts, and a wide leftmost object where the first-by-centre must not move. | Unequal: **0, 124, 198**. Gap 0: **0, 100, 150**. Overlap: first unit stays at **30**, others at **140, 350**. |
| Register the new actions. Reject a negative gap and a frame **inside `perform`**. Differential test: old command and new command with gap 24 must match on the fixture, and B must be a group. | Both commands → **0, 124, 154, 198**. Negative gap, NaN, fewer than 3 units, or a frame in the selection: nothing moves. |
| Add the gap input, `appState` field, and label. Snapshot diff must be only the new key. | Only `currentItemDistributeGap: 24` (133 snapshot lines, all that one key). |
| Integration tests: a rotated rectangle, a bound label, a group, and a frame. | Rotated unit: gap 24 measured on the rotated box. Bound label moves with its container. Group treated as one unit. Frame: no-op. |

Also: `yarn test:typecheck` — 0 errors. `yarn test:code` — clean. New files: `spacing.test.ts` **12/12**, `distributeWithGap.test.tsx` **20/20**. Nearby `align.test.tsx` **50/50**.

Manual (type a gap, click the button, confirm on screen): three rectangles at x=100 w200, x=420 w90, x=560 w160. Old button → **100, 385, 560** (equal gaps of 85, original extent kept). New button, gap 60 → **100, 360, 510** (first shape unmoved).

### What changed from the RFC

- **Offsets, not final positions.** The proposal sketched rules that return where each box should sit. The code returns how far to move it. That is what the old function already computed, so `spaceBetween` matches today exactly (including the 0, 150, 300 case).
- **A third rule needs one table entry.** The RFC said a third spacing rule would need no edit outside the new function and the union. The rule still has to be reachable, so it is one function, one union member, and one entry in `spacingRules`. The coordinator itself is not edited. TypeScript errors if the entry is missing (checked by adding a dummy member: one error, on the table).
- **The two commands do not always agree.** They give the same positions only when the first object in sort order is also the leftmost. Otherwise the gaps match but the whole run is shifted, because `fixedGap` anchors on the first object and `spaceBetween` anchors on the left edge of the selection. There is a test for each case.
- **Two files the RFC did not list:** `packages/common/src/constants.ts` (`DEFAULT_DISTRIBUTE_GAP = 24`) and `packages/excalidraw/components/Actions.scss` (layout for the gap row).

### What remains

- **Frames are not distributed.** A frame is Excalidraw’s container around other shapes. The old buttons already refuse a selection that contains one (`TODO enable distributing frames when implemented properly`). The new buttons do the same, including inside `perform`. Supporting frames was out of scope.
- No keyboard shortcut for the new commands; one axis per click.
- The gap is the space between **bounding boxes**. For a rotated shape that is the rotated box, not the drawn edge.
- Button labels are in `en.json` only.

---
