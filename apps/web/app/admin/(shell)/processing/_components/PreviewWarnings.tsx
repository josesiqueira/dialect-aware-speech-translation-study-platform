import { InlineMessage } from "@/components/ui";
import type { BatchPreview } from "./types";

/**
 * Notes of the batch preview that the researcher should read before creating
 * the batch. They never block it. Today: the normalized transcript (C) of some
 * utterances was written from an earlier state of the dialect transcript (B).
 */
export function PreviewWarnings({ warnings }: { warnings: BatchPreview["warnings"] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="batch-preview-warnings">
      {warnings.map((warning) => (
        <InlineMessage key={warning.code} variant="warning">
          {warning.message} The batch can still be created.
        </InlineMessage>
      ))}
    </div>
  );
}
