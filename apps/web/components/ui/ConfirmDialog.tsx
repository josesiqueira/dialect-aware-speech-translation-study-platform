"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { InlineMessage } from "./InlineMessage";
import { inputBase, inputSizes } from "./styles";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** What will happen, in plain language, including what cannot be undone. */
  children?: ReactNode;
  /** Label of the confirming button. Name the action: "Delete TEST data", not "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** danger: rose confirm button, for destructive actions (spec 116). */
  tone?: "default" | "danger";
  /**
   * For highly destructive actions: the exact text the researcher must type
   * before the confirm button becomes available, for example "DELETE".
   */
  confirmPhrase?: string;
  /** True while the confirmed action runs. Disables both buttons and shows the spinner. */
  busy?: boolean;
  busyLabel?: string;
  /** Error from the confirmed action, shown inside the dialog. */
  error?: ReactNode;
  onConfirm: () => void;
  /** Called for Cancel, for the Escape key and for the dialog closing in any other way. */
  onCancel: () => void;
}

/**
 * Modal confirmation built on the native <dialog> element: showModal() gives
 * the focus trap, the inert background, Escape to cancel and focus return to
 * the element that opened it.
 *
 * Initial focus goes to the typed-phrase input when there is one, otherwise to
 * Cancel, so that pressing Enter by reflex never confirms a destructive action.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "default",
  confirmPhrase,
  busy = false,
  busyLabel = "Working...",
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const phraseId = useId();
  const [typed, setTyped] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Clear the typed phrase whenever the dialog is closed, so it never carries over.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setTyped("");
  }

  const phraseMatches = confirmPhrase === undefined || typed === confirmPhrase;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={children ? bodyId : undefined}
      onCancel={(event) => {
        // Escape key. Keep the dialog under React control.
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="m-auto w-full max-w-md rounded-lg border border-slate-200 bg-white p-0 text-slate-700 shadow-md"
    >
      {open && (
        <form
          method="dialog"
          onSubmit={(event) => {
            event.preventDefault();
            if (phraseMatches && !busy) onConfirm();
          }}
          className="p-6"
        >
          <h2 id={titleId} className="text-lg font-semibold text-slate-900">
            {title}
          </h2>
          {children && (
            <div id={bodyId} className="mt-2 space-y-2 text-sm text-slate-600">
              {children}
            </div>
          )}

          {confirmPhrase !== undefined && (
            <div className="mt-4">
              <label htmlFor={phraseId} className="block text-sm font-medium text-slate-700">
                Type <span className="font-mono font-semibold text-slate-900">{confirmPhrase}</span> to
                confirm
              </label>
              <input
                id={phraseId}
                type="text"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                disabled={busy}
                className={`${inputBase} ${inputSizes.md} mt-1 font-mono`}
              />
            </div>
          )}

          {error && (
            <InlineMessage variant="error" className="mt-4">
              {error}
            </InlineMessage>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={onCancel}
              disabled={busy}
              autoFocus={confirmPhrase === undefined}
            >
              {cancelLabel}
            </Button>
            <Button
              type="submit"
              variant={tone === "danger" ? "danger" : "primary"}
              disabled={!phraseMatches}
              loading={busy}
              loadingLabel={busyLabel}
            >
              {confirmLabel}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}
