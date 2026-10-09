import type { ReactNode } from "react";
import { Button, type ButtonSize } from "./Button";
import { InlineStatus } from "./InlineMessage";

export type SaveStatus = "idle" | "saved" | "error";

export interface SaveButtonProps {
  /** True while the save request is pending: disables the button, shows the spinner and "Saving...". */
  isLoading: boolean;
  onClick?: () => void;
  /** Idle label. Default "Save". */
  label?: string;
  /** Default "Saving...". */
  loadingLabel?: string;
  /** Result of the last save, shown inline next to the button. No toast. */
  status?: SaveStatus;
  /** Text for the status. Defaults: "Saved" and "Save failed". */
  statusMessage?: ReactNode;
  disabled?: boolean;
  size?: ButtonSize;
  /** Use "submit" when the button sits inside the form it saves. */
  type?: "button" | "submit";
}

/**
 * Dark slate Save with inline result, the rhythm of the reference SaveButton
 * and Settings sections. The parent owns the request and passes the state.
 */
export function SaveButton({
  isLoading,
  onClick,
  label = "Save",
  loadingLabel = "Saving...",
  status = "idle",
  statusMessage,
  disabled,
  size = "md",
  type = "button",
}: SaveButtonProps) {
  return (
    <div className="flex items-center gap-3">
      <Button
        type={type}
        size={size}
        onClick={onClick}
        loading={isLoading}
        loadingLabel={loadingLabel}
        disabled={disabled}
      >
        {label}
      </Button>
      {!isLoading && status === "saved" && (
        <InlineStatus variant="success">{statusMessage ?? "Saved"}</InlineStatus>
      )}
      {!isLoading && status === "error" && (
        <InlineStatus variant="error">{statusMessage ?? "Save failed"}</InlineStatus>
      )}
    </div>
  );
}
