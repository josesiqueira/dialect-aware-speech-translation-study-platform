// Client-side shapes of the protocol API responses. They are the service
// result types with dates as ISO text, which is how JSON delivers them.
import type { protocolSchemas } from "@dialect/domain";
import type { protocols } from "@dialect/research";

type Serialized<T> = protocolSchemas.Serialized<T>;

export type ProtocolDetail = Serialized<protocols.ProtocolDetail>;
export type ProtocolSummary = Serialized<protocols.ProtocolVersionSummary>;
export type ProtocolOptions = Serialized<protocols.ProtocolOptions>;
export type ProtocolValidation = protocols.ProtocolValidation;
export type ProtocolProblem = protocols.ProtocolProblem;
export type ProtocolDiff = protocols.ProtocolDiff;
export type TextChange = protocols.TextChange;
export type PublishResult = Serialized<protocols.PublishResult>;
export type ConsentVersion = Serialized<protocols.ConsentVersionSummary>;

export type Task = ProtocolDetail["tasks"][number];
export type Followup = Task["followups"][number];
export type OrderBlock = ProtocolDetail["protocol"]["orderConfigJson"]["blocks"][number];

export type Overview = {
  studyId: string;
  currentProtocolVersionId: string | null;
  draftProtocolVersionId: string | null;
  protocols: ProtocolSummary[];
  options: ProtocolOptions;
};

export const TASK_TYPE_LABELS: Record<Task["taskType"], string> = {
  controlled: "Controlled",
  semi_structured: "Semi-structured",
  free_speech: "Free speech",
};

export const ORDER_MODE_LABELS: Record<OrderBlock["orderMode"], string> = {
  fixed: "Fixed order",
  shuffle_within_block: "Random order within the block",
};

export function protocolLabel(version: { versionNumber: number }): string {
  return `Protocol v${version.versionNumber}`;
}
