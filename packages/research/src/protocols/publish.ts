// Publishing a protocol version (spec 49, 76, 127). Everything happens in one
// transaction: the check, the status change, the switch of the study's current
// protocol and the audit row. A failed check changes nothing.
import { eq } from "drizzle-orm";
import {
  isInvalidStateError,
  protocolVersions,
  studies,
  triggerErrorReason,
} from "@dialect/db";
import { AppError } from "@dialect/domain";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import { loadProtocolDiff, type ProtocolDiff } from "./diff";
import { loadProtocol, loadProtocolDetail, lockStudy, protocolLabel, type ProtocolDetail } from "./shared";
import { validateProtocol, type ProtocolProblem } from "./validation";

export type PublishResult = {
  protocol: ProtocolDetail;
  // The version that was current before, or null for a first publication.
  previousProtocolVersionId: string | null;
  // The difference against the previously current version, as written to the audit log.
  diffSummary: ProtocolDiff["summary"];
  // Warnings that were present when the version was published.
  warnings: ProtocolProblem[];
};

// Publishes a draft. From then on the version is immutable and is the protocol
// that NEW sessions receive. Sessions that already exist stay pinned to the
// version they started with. The previously current version stays published,
// because its sessions still refer to it. Use retireProtocol to retire it.
export async function publishProtocol(ctx: ServiceContext, id: string): Promise<PublishResult> {
  const result = await ctx.db
    .transaction(async (tx) => {
      const found = await loadProtocol(tx, id);
      // Same lock order as creating a draft: study first, then the protocol.
      const study = await lockStudy(tx, found.studyId);
      const protocol = await loadProtocol(tx, id, { lock: true });
      if (protocol.status !== "draft") {
        throw new AppError(
          "INVALID_STATE",
          `${protocolLabel(protocol)} is already ${protocol.status}. Only a draft can be published.`,
          { protocolVersionId: id, status: protocol.status },
        );
      }

      const validation = await validateProtocol(tx, id);
      if (!validation.canPublish) {
        throw new AppError(
          "VALIDATION_ERROR",
          `${protocolLabel(protocol)} cannot be published yet: ${validation.errors.length} problem${validation.errors.length === 1 ? "" : "s"} must be fixed first.`,
          { problems: validation.errors, warnings: validation.warnings },
        );
      }

      const previousId = study.currentProtocolVersionId;
      const diff = await loadProtocolDiff(tx, previousId, id);
      const publishedAt = ctx.now();
      await tx
        .update(protocolVersions)
        .set({ status: "published", publishedAt })
        .where(eq(protocolVersions.id, id));
      await tx.update(studies).set({ currentProtocolVersionId: id }).where(eq(studies.id, study.id));
      await recordAudit(tx, {
        action: "protocol.publish",
        entityType: "protocol_version",
        entityId: id,
        before: {
          status: "draft",
          currentProtocolVersionId: previousId,
          previousVersionNumber: diff.from?.versionNumber ?? null,
        },
        after: {
          status: "published",
          versionNumber: protocol.versionNumber,
          publishedAt: publishedAt.toISOString(),
          currentProtocolVersionId: id,
          diffSummary: diff.summary,
          warningCodes: validation.warnings.map((warning) => warning.code),
        },
        actorLabel: ctx.actorLabel,
      });
      return { previousProtocolVersionId: previousId, diffSummary: diff.summary, warnings: validation.warnings };
    })
    .catch((error: unknown) => {
      // The trigger repeats the consent and questionnaire checks. It can only
      // fire here if one of them changed between the check and the update.
      if (isInvalidStateError(error)) {
        throw new AppError(
          "INVALID_STATE",
          `The protocol could not be published: ${triggerErrorReason(error) ?? "a referenced version is not published"}.`,
        );
      }
      throw error;
    });
  return { protocol: await loadProtocolDetail(ctx.db, id), ...result };
}
