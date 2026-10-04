import { atom, useAtomValue } from "../editor-jotai";
import { t } from "../i18n";

import { Dialog } from "./Dialog";
import DialogActionButton from "./DialogActionButton";

import "./BundledExportStatus.scss";

import type { MissionFailure } from "../data/bundledExport";

export type BundledExportStatusState = {
  phase: "running" | "finished";
  /** number of frames exported so far, including the failed ones */
  completed: number;
  total: number;
  /** in the order the failures were detected */
  failures: readonly Pick<MissionFailure, "id" | "label" | "message">[];
  onCancel: () => void;
  onClose: () => void;
};

export const bundledExportStatusAtom = atom<BundledExportStatusState | null>(
  null,
);

/**
 * Progress of the bundled export, and the frames that failed so far.
 *
 * Unlike `appState.errorMessage`, which only holds the most recent error,
 * failures are listed here one after another as they come in.
 */
export const BundledExportStatus = () => {
  const status = useAtomValue(bundledExportStatusAtom);

  if (!status) {
    return null;
  }

  const { phase, completed, total, failures, onCancel, onClose } = status;
  const isRunning = phase === "running";
  const onDismiss = isRunning ? onCancel : onClose;

  return (
    <Dialog
      size="small"
      title={t(
        isRunning
          ? "bundledExport.title.running"
          : "bundledExport.title.failed",
      )}
      onCloseRequest={onDismiss}
      closeOnClickOutside={false}
    >
      <div className="BundledExportStatus" data-testid="bundled-export-status">
        <div
          className="BundledExportStatus__progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={completed}
        >
          <div
            className="BundledExportStatus__progress__fill"
            style={{ width: `${total ? (completed / total) * 100 : 0}%` }}
          />
        </div>
        <div data-testid="bundled-export-progress">
          {t("bundledExport.progress", { completed, total })}
        </div>
        {failures.length > 0 && (
          <>
            <div className="BundledExportStatus__summary">
              {t("bundledExport.failed", { count: failures.length })}
            </div>
            <ol
              className="BundledExportStatus__failures"
              data-testid="bundled-export-failures"
            >
              {failures.map((failure) => (
                <li key={failure.id}>
                  <strong>{failure.label}</strong> ({failure.id}):{" "}
                  {failure.message}
                </li>
              ))}
            </ol>
            {!isRunning && <div>{t("bundledExport.failedHint")}</div>}
          </>
        )}
        <div className="BundledExportStatus__buttons">
          <DialogActionButton
            label={isRunning ? t("buttons.cancel") : t("buttons.close")}
            onClick={onDismiss}
          />
        </div>
      </div>
    </Dialog>
  );
};
