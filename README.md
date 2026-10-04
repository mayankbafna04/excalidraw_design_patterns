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

| Check | Result |
| --- | --- |
| `yarn test:typecheck` / `yarn test:code` | 0 errors / clean |
| `distribute.test.tsx` (unedited) | 4/4 |
| `spacing.test.ts` (pure) | 12/12 |
| `distributeWithGap.test.tsx` | 20/20 |
| `align.test.tsx` | 50/50 |
| Snapshots | only `currentItemDistributeGap: 24` (133 lines) |

New tests: unequal sizes, group-as-one-unit, y-axis, gap 0, overlap, rotation, bound label, bound arrow, undo, each refusal, and the two rules side-by-side (agree only when the first object is also the leftmost). Adding a dummy `Distribution` member produced one `tsc` error, on the table.

Manual, three rects at 100/w200, 420/w90, 560/w160: old button → 100 / 385 / 560 (gaps 85/85, extent kept). New button, gap 60 → 100 / 360 / 510 (first unmoved).

### What changed from the RFC

- Rules return **offsets**, not positions — `spaceBetween` is bit-identical to today.
- A third rule is one function + one union member + **one table entry** (not “no edit anywhere”).
- Old and new commands match **only** when the first-in-order object is also the leftmost; otherwise same gaps, whole run shifted. Tested both ways.
- Extra files: `packages/common/src/constants.ts` (`DEFAULT_DISTRIBUTE_GAP`), `Actions.scss` (gap row).

### What remains

Frames still excluded (upstream TODO). No shortcut; one axis per click. Gap is to the rotation-aware box, not the drawn edge. Labels in `en.json` only.

---
