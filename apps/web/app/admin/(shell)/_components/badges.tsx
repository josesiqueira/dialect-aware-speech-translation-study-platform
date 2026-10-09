import type { SessionStatus, StudyMode } from "@dialect/domain";
import { Badge, type BadgeVariant } from "@/components/ui";

/** TEST and DEMO are always labelled. Research gets a quiet neutral badge when `showResearch` is set. */
export function ModeBadge({
  mode,
  size = "sm",
  showResearch = false,
}: {
  mode: StudyMode;
  size?: "sm" | "md";
  showResearch?: boolean;
}) {
  if (mode === "test") {
    return (
      <Badge variant="test" size={size}>
        TEST
      </Badge>
    );
  }
  if (mode === "demo") {
    return (
      <Badge variant="demo" size={size}>
        DEMO
      </Badge>
    );
  }
  return showResearch ? (
    <Badge variant="neutral" size={size} className="uppercase tracking-wide">
      Research
    </Badge>
  ) : null;
}

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  created: "Created",
  consented: "Consented",
  mic_check: "Microphone check",
  recording: "Recording",
  background_questionnaire: "Background questionnaire",
  post_questionnaire: "Post questionnaire",
  completed: "Completed",
  withdrawn: "Withdrawn",
  abandoned: "Abandoned",
};

const SESSION_STATUS_VARIANTS: Partial<Record<SessionStatus, BadgeVariant>> = {
  completed: "completed",
  withdrawn: "incomplete",
  abandoned: "incomplete",
};

export function SessionStatusBadge({ status, size = "sm" }: { status: SessionStatus; size?: "sm" | "md" }) {
  return (
    <Badge variant={SESSION_STATUS_VARIANTS[status] ?? "neutral"} size={size}>
      {SESSION_STATUS_LABELS[status]}
    </Badge>
  );
}
