/**
 * The step components of the participant flow. Each one is presentational: it
 * takes its content and its interface text (`t`, a Dictionary from "@/lib/i18n")
 * as props and calls no API. The study page (app/study) connects them to the
 * participant API, and a preview can render them with any content.
 * Documentation: docs/PARTICIPANT-UI.md.
 */
export { FlowShell, STEP_HEADING_ID, type FlowShellProps } from "./FlowShell";
export { StudyText, parseStudyText, type StudyTextBlock, type StudyTextProps } from "./StudyText";
export { WelcomeStep, type WelcomeStepProps } from "./WelcomeStep";
export { InformationStep, type InformationStepProps } from "./InformationStep";
export { ConsentStep, type ConsentResponses, type ConsentStepProps } from "./ConsentStep";
export { MicCheckStep, type MicCheckStepProps } from "./MicCheckStep";
export { InstructionsStep, type InstructionsStepProps } from "./InstructionsStep";
export { TaskStep, type TaskStepProps, type TaskStepTask } from "./TaskStep";
export { QuestionnaireStep, type QuestionnaireServerIssue, type QuestionnaireStepProps } from "./QuestionnaireStep";
export {
  ContactBlock,
  DebriefStep,
  ParticipantCode,
  type ContactBlockProps,
  type DebriefStepProps,
  type ParticipantCodeProps,
} from "./DebriefStep";
export {
  CompletedStep,
  EndParticipationDialog,
  MessageScreen,
  WithdrawnStep,
  type CompletedStepProps,
  type EndParticipationDialogProps,
  type MessageScreenProps,
  type WithdrawnStepProps,
} from "./FinalScreens";
