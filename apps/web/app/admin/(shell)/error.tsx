"use client";

import { Card, ErrorState } from "@/components/ui";

/** Error boundary for admin pages. The sidebar stays; only the content area shows the failure. */
export default function AdminError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <Card className="mx-auto mt-16 max-w-md" padding="sm">
      <ErrorState
        message={error.digest ? `The page could not be shown. Reference: ${error.digest}` : "The page could not be shown."}
        onRetry={retry}
      />
    </Card>
  );
}
