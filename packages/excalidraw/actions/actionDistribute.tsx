import { getNonDeletedElements } from "@excalidraw/element";

import { isFrameLikeElement } from "@excalidraw/element";

import { CODES, KEYS, arrayToMap } from "@excalidraw/common";

import { updateFrameMembershipOfSelectedElements } from "@excalidraw/element";

import { distributeElements } from "@excalidraw/element";

import { CaptureUpdateAction } from "@excalidraw/element";

import { getSelectedElementsByGroup } from "@excalidraw/element";

import type {
  ElementsMap,
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import type { Distribution } from "@excalidraw/element";

import { IconButton } from "../components/IconButton";
import {
  DistributeHorizontallyIcon,
  DistributeVerticallyIcon,
} from "../components/icons";

import { t } from "../i18n";

import { isSomeElementSelected } from "../scene";

import { getShortcutKey } from "../shortcut";

import { register } from "./register";

import type { AppClassProperties, AppState, UIAppState } from "../types";

/**
 * Whether the selection can be distributed at all: it has to hold at least
 * three units and no frames.
 */
const canDistribute = (
  selectedElements: NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  appState: Readonly<Pick<AppState, "selectedGroupIds" | "editingGroupId">>,
) =>
  getSelectedElementsByGroup(selectedElements, elementsMap, appState).length >
    2 &&
  // TODO enable distributing frames when implemented properly
  !selectedElements.some((el) => isFrameLikeElement(el));

const enableActionGroup = (appState: UIAppState, app: AppClassProperties) =>
  canDistribute(
    app.scene.getSelectedElements(appState),
    app.scene.getNonDeletedElementsMap(),
    appState,
  );

const distributeSelectedElements = (
  elements: readonly ExcalidrawElement[],
  appState: Readonly<AppState>,
  app: AppClassProperties,
  distribution: Distribution,
) => {
  const selectedElements = app.scene.getSelectedElements(appState);

  const updatedElements = distributeElements(
    selectedElements,
    app.scene.getNonDeletedElementsMap(),
    distribution,
    appState,
    app.scene,
  );

  const updatedElementsMap = arrayToMap(updatedElements);

  return updateFrameMembershipOfSelectedElements(
    elements.map((element) => updatedElementsMap.get(element.id) || element),
    appState,
    app,
  );
};

/**
 * Runs a gap distribution, or gives the elements back untouched when the
 * selection or the gap cannot be distributed. The checks live here rather than
 * only on the button because the command palette and `executeAction` call
 * `perform` directly.
 */
const distributeSelectedElementsWithGap = (
  elements: readonly ExcalidrawElement[],
  appState: Readonly<AppState>,
  app: AppClassProperties,
  axis: Distribution["axis"],
) => {
  const gap = appState.currentItemDistributeGap;

  if (
    !Number.isFinite(gap) ||
    gap < 0 ||
    !canDistribute(
      app.scene.getSelectedElements(appState),
      app.scene.getNonDeletedElementsMap(),
      appState,
    )
  ) {
    return elements;
  }

  return distributeSelectedElements(elements, appState, app, {
    space: "fixedGap",
    axis,
    gap,
  });
};

export const distributeHorizontally = register({
  name: "distributeHorizontally",
  label: "labels.distributeHorizontally",
  trackEvent: { category: "element" },
  perform: (elements, appState, _, app) => {
    return {
      appState,
      elements: distributeSelectedElements(elements, appState, app, {
        space: "between",
        axis: "x",
      }),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  keyTest: (event) =>
    !event[KEYS.CTRL_OR_CMD] && event.altKey && event.code === CODES.H,
  PanelComponent: ({ elements, appState, updateData, app }) => (
    <IconButton
      hidden={!enableActionGroup(appState, app)}
      type="button"
      icon={DistributeHorizontallyIcon}
      onClick={() => updateData(null)}
      title={`${t("labels.distributeHorizontally")} — ${getShortcutKey(
        "Alt+H",
      )}`}
      aria-label={t("labels.distributeHorizontally")}
      visible={isSomeElementSelected(getNonDeletedElements(elements), appState)}
    />
  ),
});

export const distributeVertically = register({
  name: "distributeVertically",
  label: "labels.distributeVertically",
  trackEvent: { category: "element" },
  perform: (elements, appState, _, app) => {
    return {
      appState,
      elements: distributeSelectedElements(elements, appState, app, {
        space: "between",
        axis: "y",
      }),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  keyTest: (event) =>
    !event[KEYS.CTRL_OR_CMD] && event.altKey && event.code === CODES.V,
  PanelComponent: ({ elements, appState, updateData, app }) => (
    <IconButton
      hidden={!enableActionGroup(appState, app)}
      type="button"
      icon={DistributeVerticallyIcon}
      onClick={() => updateData(null)}
      title={`${t("labels.distributeVertically")} — ${getShortcutKey("Alt+V")}`}
      aria-label={t("labels.distributeVertically")}
      visible={isSomeElementSelected(getNonDeletedElements(elements), appState)}
    />
  ),
});

export const distributeHorizontallyWithGap = register({
  name: "distributeHorizontallyWithGap",
  label: "labels.distributeHorizontallyWithGap",
  trackEvent: { category: "element" },
  perform: (elements, appState, _, app) => {
    return {
      appState,
      elements: distributeSelectedElementsWithGap(elements, appState, app, "x"),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  PanelComponent: ({ elements, appState, updateData, app }) => (
    <IconButton
      hidden={!enableActionGroup(appState, app)}
      type="button"
      icon={DistributeHorizontallyIcon}
      onClick={() => updateData(null)}
      title={t("labels.distributeHorizontallyWithGap")}
      aria-label={t("labels.distributeHorizontallyWithGap")}
      visible={isSomeElementSelected(getNonDeletedElements(elements), appState)}
    />
  ),
});

export const distributeVerticallyWithGap = register({
  name: "distributeVerticallyWithGap",
  label: "labels.distributeVerticallyWithGap",
  trackEvent: { category: "element" },
  perform: (elements, appState, _, app) => {
    return {
      appState,
      elements: distributeSelectedElementsWithGap(elements, appState, app, "y"),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  PanelComponent: ({ elements, appState, updateData, app }) => (
    <IconButton
      hidden={!enableActionGroup(appState, app)}
      type="button"
      icon={DistributeVerticallyIcon}
      onClick={() => updateData(null)}
      title={t("labels.distributeVerticallyWithGap")}
      aria-label={t("labels.distributeVerticallyWithGap")}
      visible={isSomeElementSelected(getNonDeletedElements(elements), appState)}
    />
  ),
});
