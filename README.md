# Excalidraw — CMU 17-695

Course copy of [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) (MIT). See [`COURSE.md`](./COURSE.md).

## Run

Node >= 18, Yarn 1.

```bash
yarn install
yarn start                 # http://localhost:3000
yarn test:typecheck        # tsc
yarn test:code             # eslint
yarn test:app --watch=false
yarn vitest run packages/element/tests/distribute.test.tsx \
  packages/element/tests/spacing.test.ts \
  packages/element/tests/distributeWithGap.test.tsx
```

---

## Samarth Shukla

**Andrew ID:** sshukla3@andrew.cmu.edu · **GitHub:** [@samarthshukla6](https://github.com/samarthshukla6)

### Request 05 — Arrange objects with a specified gap

Type a gap (e.g. 24) and space selected objects by that amount, even when sizes differ. The old _Distribute_ only equalises leftover space inside the current extent.

### The change

`distributeElements` did four jobs, with the move loop written twice. Split:

- `orderSelectionUnits` — group + sort (sort unchanged: by box centre)
- `spaceBetween` / `fixedGap` — boxes in, offsets out (no scene, no render)
- `applyTranslations` — the one move loop (`updateBoundElements` stays here)
- `distributeElements` — looks the rule up and wires the three

`Distribution` is `{ space: "between" }` or `{ space: "fixedGap", gap }`. Rules live in a `spacingRules` table keyed by `space`; a new union member is a type error until the table has an entry. Coordinator and actions are not edited for a third rule.

UI: `distributeHorizontallyWithGap` / `distributeVerticallyWithGap` (no shortcut), number input in Align, `currentItemDistributeGap` default 24. `fixedGap` never moves the first object in order. `perform` itself refuses frames, < 3 units, or a negative / non-numeric gap (returns elements unchanged). Existing distribute actions untouched.

### Results of the checks

RFC step checks (all in-repo; last command above reruns them):

| RFC check | Where | Observation |
| --- | --- | --- |
| Characterization first: fixture + center fallback as today's oracle | `distributeWithGap` “characterization”; `spacing` `spaceBetween` | Fixture → **0 / 124 / 154 / 198**. Fallback → **0 / 100 / 100** (A,C keep the extent; B, first-by-center, moves). Unit fallback: **0 / 50 / 200** and **100 / 0 / 100**. |
| Extract `orderSelectionUnits` / `applyTranslations`. Existing tests unedited + order on overlapping | `distribute.test.tsx` (file unedited); `shared ordering` | **4/4**. Overlap order by box centre: **B, A, C**. Group B is one unit: `[A], [B1,B2], [C]`. |
| `spaceBetween` keeps old math | `spacing.test.ts` | **0 / 150 / 300** — same numbers the old tests assert. |
| `fixedGap`: unequal widths, gap 0, overlapping starts, wide leftmost / first-by-center does not move | `spacing` + `the new command` | Unequal → **0 / 124 / 198**. Gap 0 → **0 / 100 / 150** (boxes touch). Overlap → first unmoved at **30**, then **140 / 350**. |
| Actions; reject negative gap and frames **inside `perform`**. Differential test | `the two commands agree` + refusals | Both commands, gap 24, B a 2-shape group → **0 / 124 / 154 / 198**. Negative / NaN / &lt;3 units / frame → positions unchanged. |
| Gap input + `appState` + label. Snapshot diff only the new key | snapshots | Only `currentItemDistributeGap: 24` (133 lines). |
| Integration: rotation, bound label, group, frame | `units that are not plain rectangles` + frame refusal | Rotated box: gap 24 on rotation-aware bounds. Label moves with container. Group = one unit. Frame: no-op. |

Also: `yarn test:typecheck` 0 errors; `yarn test:code` clean; `align.test.tsx` 50/50; 12 + 20 new tests.

Manual: three rects at 100/w200, 420/w90, 560/w160. Old button → **100 / 385 / 560** (gaps 85/85). New button, gap 60 → **100 / 360 / 510** (first unmoved).

### What changed from the RFC

- Rules return **offsets**, not positions — `spaceBetween` is bit-identical to today.
- A third rule is one function + one union member + **one table entry** (not “no edit anywhere”).
- Old and new commands match **only** when the first-in-order object is also the leftmost; otherwise same gaps, whole run shifted. Tested both ways.
- Extra files: `packages/common/src/constants.ts` (`DEFAULT_DISTRIBUTE_GAP`), `Actions.scss` (gap row).

### What remains

Frames still excluded (upstream TODO). No shortcut; one axis per click. Gap is to the rotation-aware box, not the drawn edge. Labels in `en.json` only.

---
