// Every interface string of the demo page, in one place. The demo page is an
// operator and seminar tool, so it is in English only (the participant flow is
// localized, this page is not).
import { demoSchemas } from "@dialect/domain";

export const DEMO_STRINGS = {
  pageTitle: "Demo Mode",
  // The h1 names the page. "Original Finnish" is the heading of the section with the recording
  // and its transcript (spec 81), which exists only once the recorder is shown.
  heading: "Speech translation demo",
  originalHeading: "Original Finnish",
  headingDescription:
    "Record a short piece of spoken Finnish. It is transcribed, translated into English in two ways, and both translations are spoken by a synthetic voice.",
  bannerText: "Demonstration. Recordings are processed immediately and are not research data.",

  // The recording notice comes from the shared constant, because the server
  // stores the same text with the time of the acceptance.
  noticeTitle: demoSchemas.DEMO_RECORDING_NOTICE.title,
  noticeParagraphs: demoSchemas.DEMO_RECORDING_NOTICE.paragraphs,
  noticeAgree: demoSchemas.DEMO_RECORDING_NOTICE.agreeLabel,
  noticeAgreeBusy: "Starting...",
  noticeKept: "On this server demo recordings are kept and can be inspected by the researchers. They are marked DEMO.",
  noticeNotKept:
    "On this server demo recordings are not kept. They are deleted when you choose Clear and start again or leave this page.",

  loading: "Loading the demo...",
  loadFailed: "The demo could not be loaded.",
  retry: "Try again",

  recordPrompt: "Say something in Finnish. One or two sentences are enough.",
  recordHint: "Press Start recording, speak, then press Stop. You can listen and record again before you send it.",
  recordSubmitLabel: "Send to the pipeline",
  recordingSaved: "The recording was saved.",

  optionsSummary: "Options",
  captureLabel: "Capture",
  captureHelp: "Applies to the next recording.",
  captureLossless: "Lossless (PCM WAV)",
  captureLosslessDescription: "The same capture as in the study. Larger upload.",
  captureCompressed: "Compressed (browser codec)",
  captureCompressedDescription: "Smaller upload. Stored as a compressed fallback recording.",
  pipelineLabel: "Pipeline",
  pipelineHelp: "Researchers only.",
  pipelineActive: "Active configurations",
  pipelineActiveDescription: "The models and prompts that are active on the AI Pipeline page.",
  pipelineMock: "Mock provider",
  pipelineMockDescription: "A check of the plumbing. No model is called and the text is generated placeholder text.",
  mockTitle: "MOCK PROVIDER, not real model output",
  mockBody:
    "The transcript and the translations below are generated placeholder text, and the audio is a test tone. Nothing is sent to an AI service. Use this only to check that the page and the storage work.",

  leftoversButton: "Remove leftover demo data",
  leftoversTitle: "Remove leftover demo data?",
  leftoversBody:
    "This deletes demo sessions that ended or were left open without activity, with their recordings, transcripts, translations and synthesized audio. Research data and test data are not touched. This cannot be undone.",
  leftoversConfirm: "Remove leftover demo data",
  leftoversDone: "Removed leftover demo sessions: {count}.",

  progressTitle: "Progress",
  stageNames: { asr: "Transcribing", translation: "Translating", tts: "Synthesizing" },
  stageStates: {
    waiting: "waiting",
    running: "in progress",
    done: "done",
    failed: "failed",
    partial: "done with errors",
    skipped: "not run",
  },
  announce: {
    asrRunning: "Transcribing the recording.",
    asrDone: "Transcription finished. Translating.",
    asrFailed: "Transcription failed.",
    translationDone: "Translation finished. Synthesizing speech.",
    translationFailed: "Translation failed.",
    ttsDone: "Speech synthesis finished. The results are shown below.",
    ttsFailed: "Speech synthesis failed.",
  },

  sourceTitle: "Your recording",
  transcriptTitle: "ASR transcript",
  transcriptDescription: "The automatic transcript of the recording, exactly as the model returned it.",
  transcriptEmpty: "The model returned an empty transcript.",
  transcriptPending: "The transcript appears here.",
  comparisonTitle: "Two translations of the same transcript",
  comparisonCaption:
    "Both columns translate the transcript above. The left column uses the default translation instruction. The right column uses the instruction that asks the model to keep linguistic variation of the speaker. Both translations are read by the same synthetic voice.",
  translationPending: "The translation appears here.",
  translationNotRun: "Not run, because the transcription did not succeed.",
  synthesisPending: "The synthesized audio appears here.",
  synthesisNotRun: "No audio, because there is no translation to read.",
  playLabel: "Synthesized speech: {label}",
  stageFailedTitle: { asr: "Transcription failed", translation: "Translation failed", tts: "Speech synthesis failed" },
  adminConfigLink: "Open the AI Pipeline page",
  adminConfigHint: "The provider status and the active configurations are shown on the AI Pipeline page.",
  technicalDetail: "Technical detail",

  pipelineSummary: "Show pipeline",
  pipelineIntro: "What happened to this recording, step by step: source, ASR, translation, TTS.",
  pipelineSource: "Source recording",
  pipelineAsr: "ASR",
  pipelineTranslation: "Translation: {label}",
  pipelineTts: "TTS: {label}",
  pipelineModel: "Model",
  pipelinePrompt: "Prompt",
  pipelineTiming: "Time",
  pipelineNoPrompt: "none",
  pipelineNotRun: "not run",
  pipelineFailed: "failed",
  pipelineBatch: "Stored in the {mode} batch {name}.",

  recordAnother: "Record another",
  clear: "Clear and start again",
  clearBusy: "Clearing...",
  sessionEnded: "The demo session has ended. Accept the notice to start again.",
  genericError: "Something went wrong. Please try again.",
} as const;

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
