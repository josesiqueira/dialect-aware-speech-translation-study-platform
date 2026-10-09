"use client";

import { useEffect, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  InlineMessage,
  LoadingState,
} from "@/components/ui";
import { errorMessage, fetchDiff, publishProtocol, validateProtocol } from "./api";
import { DiffView } from "./DiffView";
import { protocolLabel, type ProtocolDetail, type ProtocolDiff, type ProtocolProblem, type ProtocolValidation } from "./types";

function ProblemList({ problems }: { problems: ProtocolProblem[] }) {
  return (
    <ul className="mt-1 list-disc space-y-1 pl-5">
      {problems.map((problem, index) => (
        <li key={`${problem.code}-${index}`}>{problem.message}</li>
      ))}
    </ul>
  );
}

export interface PublishReviewProps {
  draft: ProtocolDetail;
  /** The version that new sessions receive now, or null before the first publication. */
  currentVersionNumber: number | null;
  /** True while a card or form on the page holds unsaved edits. */
  hasUnsavedChanges: boolean;
  onClose: () => void;
  onPublished: (publishedId: string) => void;
}

/**
 * The review step before publishing (spec 49, 141): the publish check with
 * blocking errors and methodological warnings, the difference against the
 * currently published version, then a plain confirmation.
 */
export function PublishReview({ draft, currentVersionNumber, hasUnsavedChanges, onClose, onPublished }: PublishReviewProps) {
  const id = draft.protocol.id;
  const stamp = draft.protocol.updatedAt;
  const label = protocolLabel(draft.protocol);
  const [loaded, setLoaded] = useState<{ stamp: string; validation: ProtocolValidation; diff: ProtocolDiff } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  // Runs again whenever the draft is saved, so the review never shows a stale check.
  useEffect(() => {
    let cancelled = false;
    Promise.all([validateProtocol(id), fetchDiff(id)])
      .then(([validation, diff]) => {
        if (cancelled) return;
        setLoaded({ stamp, validation, diff });
        setLoadError(null);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [id, stamp, attempt]);

  const review = loaded && loaded.stamp === stamp ? loaded : null;

  async function publish() {
    setPublishing(true);
    setPublishError(null);
    try {
      const result = await publishProtocol(id);
      setConfirming(false);
      onPublished(result.protocol.protocol.id);
    } catch (caught) {
      setPublishError(errorMessage(caught));
      setAttempt((value) => value + 1);
    } finally {
      setPublishing(false);
    }
  }

  const blocked = !review || !review.validation.canPublish || hasUnsavedChanges;

  return (
    <Card padding="none" as="section" aria-label={`Review before publishing ${label}`} className="border-slate-300">
      <CardHeader
        title={`Review before publishing ${label}`}
        description="Check the problems and the differences. Nothing is published until you confirm."
        actions={
          <Button size="sm" variant="secondary" onClick={onClose}>
            Close review
          </Button>
        }
      />
      <CardBody className="space-y-6" aria-busy={!review && !loadError}>
        {loadError ? (
          <ErrorState
            title="The review could not be loaded"
            message={loadError}
            onRetry={() => {
              setLoadError(null);
              setAttempt((value) => value + 1);
            }}
          />
        ) : !review ? (
          <LoadingState size="sm" label="Checking the draft..." />
        ) : (
          <>
            <section className="space-y-3" aria-label="Publish check">
              <h3 className="text-base font-semibold text-slate-900">1. Publish check</h3>
              {review.validation.errors.length === 0 ? (
                <InlineMessage variant="success" announce="none">
                  No blocking problems. The required texts, the consent version, the questionnaires and the tasks are
                  complete.
                </InlineMessage>
              ) : (
                <InlineMessage
                  variant="error"
                  announce="none"
                  title={`${review.validation.errors.length} problem${review.validation.errors.length === 1 ? "" : "s"} must be fixed before publishing`}
                >
                  <ProblemList problems={review.validation.errors} />
                </InlineMessage>
              )}
              {review.validation.warnings.length > 0 && (
                <InlineMessage
                  variant="warning"
                  announce="none"
                  title={`${review.validation.warnings.length} methodological warning${review.validation.warnings.length === 1 ? "" : "s"} (publishing is still possible)`}
                >
                  <ProblemList problems={review.validation.warnings} />
                </InlineMessage>
              )}
            </section>

            <section className="space-y-3" aria-label="Differences">
              <h3 className="text-base font-semibold text-slate-900">
                2. Differences against {currentVersionNumber !== null ? `the published Protocol v${currentVersionNumber}` : "the published version"}
              </h3>
              <DiffView diff={review.diff} />
            </section>
          </>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
          <Button disabled={blocked} onClick={() => setConfirming(true)}>
            Publish {label}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {hasUnsavedChanges && (
            <span className="text-sm text-amber-800">Save or cancel your open edits before publishing.</span>
          )}
          {review && !review.validation.canPublish && !hasUnsavedChanges && (
            <span className="text-sm text-slate-500">Publishing is available when the problems above are fixed.</span>
          )}
        </div>
      </CardBody>

      <ConfirmDialog
        open={confirming}
        title={`Publish ${label}?`}
        confirmLabel={`Publish ${label}`}
        busy={publishing}
        busyLabel="Publishing..."
        error={publishError}
        onConfirm={publish}
        onCancel={() => {
          setConfirming(false);
          setPublishError(null);
        }}
      >
        <p>
          After publishing, {label} is immutable: it can no longer be edited or deleted. To change the study later you
          clone it to a new draft.
        </p>
        <p>
          It applies to new sessions only. Sessions that have already started stay on the version they started with
          {currentVersionNumber !== null ? `, and Protocol v${currentVersionNumber} stays published for them` : ""}.
        </p>
      </ConfirmDialog>
    </Card>
  );
}
