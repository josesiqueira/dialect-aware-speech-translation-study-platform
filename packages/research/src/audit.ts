// Writes one row to admin_audit_log. Call it inside the same transaction as the
// change it describes, so the log and the change commit together.
import { adminAuditLog, type DbOrTx } from "@dialect/db";
import type { AuditAction, EntityType } from "@dialect/domain";

export type AuditEntry = {
  action: AuditAction;
  entityType: EntityType;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  actorLabel: string | null;
};

export async function recordAudit(dbOrTx: DbOrTx, entry: AuditEntry): Promise<void> {
  await dbOrTx.insert(adminAuditLog).values({
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    beforeJson: entry.before ?? null,
    afterJson: entry.after ?? null,
    actorLabel: entry.actorLabel,
  });
}
