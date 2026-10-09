import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/en";
import { fi } from "@/lib/i18n/fi";
import { PREVIEW_PARTICIPANT_CODE, PreviewFlow, type PreviewProtocol, type PreviewStudy } from "./PreviewFlow";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const STUDY: PreviewStudy = {
  name: "Speech study",
  locales: ["fi", "en"],
  defaultLocale: "en",
  maxUtteranceSeconds: 120,
  studyLaptopMode: false,
};

// Mock data: only the fields the preview reads.
const PROTOCOL = {
  protocol: {
    id: "00000000-0000-4000-8000-000000000001",
    versionNumber: 3,
    status: "draft",
    name: "Internal protocol name",
    welcomeContent: "Welcome text of the protocol.",
    informationContent: "Information text of the protocol.",
    instructionContent: "Instruction text of the protocol.",
    debriefContent: "Debrief text of the protocol.",
    orderConfigJson: {
      blocks: [
        { key: "fixed", title: "Opening", orderMode: "fixed" },
        { key: "main", title: "Main tasks", orderMode: "shuffle_within_block" },
      ],
    },
  },
  consentVersion: {
    id: "00000000-0000-4000-8000-000000000002",
    title: "Consent form title",
    informationText: "Consent version text.",
    itemsJson: [
      { id: "take_part", text: "I agree to take part.", required: true },
      { id: "reuse", text: "My recordings may be reused.", required: false },
    ],
    privacyNoticeUrl: null,
    contactText: "research@example.org",
  },
  tasks: [
    {
      id: "task-1",
      taskKey: "hometown",
      title: "Where you grew up",
      participantPrompt: "Tell us about the place where you grew up.",
      contextText: null,
      instructionsText: null,
      minDurationSeconds: null,
      suggestedDurationSeconds: 60,
      maxDurationSeconds: 300,
      privacyReminder: true,
      enabled: true,
      configJson: { followupMode: "optional" },
      followups: [
        { id: "f-1", promptText: "What do you miss about it?", enabled: true, isRequired: true },
        { id: "f-2", promptText: "A disabled follow-up.", enabled: false, isRequired: true },
      ],
    },
    {
      id: "task-2",
      taskKey: "disabled_task",
      title: "A disabled task",
      participantPrompt: "Never shown.",
      contextText: null,
      instructionsText: null,
      minDurationSeconds: null,
      suggestedDurationSeconds: null,
      maxDurationSeconds: null,
      privacyReminder: false,
      enabled: false,
      configJson: null,
      followups: [],
    },
  ],
  backgroundQuestionnaire: {
    id: "q-1",
    name: "About you",
    description: "A few questions about you.",
    items: [
      { itemKey: "comment", type: "short_text", prompt: "Anything to add?", helpText: null, required: false, configJson: {} },
    ],
  },
  postQuestionnaire: null,
} as unknown as PreviewProtocol;

function renderPreview(study: PreviewStudy = STUDY) {
  return render(<PreviewFlow protocol={PROTOCOL} study={study} />);
}

const controls = () => within(screen.getByTestId("preview-controls"));
const nextStep = () => userEvent.click(controls().getByRole("button", { name: "Next step" }));

describe("PreviewFlow", () => {
  const fetchSpy = vi.fn();
  const getUserMedia = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchSpy);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    window.scrollTo = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockReset();
    getUserMedia.mockReset();
    document.cookie.split(";").forEach((cookie) => expect(cookie.trim()).toBe(""));
  });

  it("shows the welcome page of the study inside the participant shell, with the preview banner", () => {
    renderPreview();
    expect(screen.getByTestId("participant-flow")).toBeInTheDocument();
    expect(screen.getByText("PREVIEW - NOT RESEARCH DATA")).toBeInTheDocument();
    expect(screen.getByText("Protocol v3 (draft)")).toBeInTheDocument();
    // The study name is the heading, as on the real welcome page, not the internal protocol name.
    expect(screen.getByRole("heading", { level: 1, name: "Speech study" })).toBeInTheDocument();
    expect(screen.getByText("Welcome text of the protocol.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.welcome.begin })).toBeInTheDocument();
  });

  it("offers the language buttons of the study and uses the participant dictionaries", async () => {
    renderPreview();
    await userEvent.click(screen.getByRole("button", { name: fi.languageName }));
    expect(screen.getByRole("button", { name: fi.welcome.begin })).toBeInTheDocument();
    expect(screen.getByTestId("participant-flow")).toHaveAttribute("lang", "fi");
    // The researcher controls stay in English.
    expect(controls().getByRole("button", { name: "Next step" })).toBeInTheDocument();
    expect(screen.getByText("PREVIEW - NOT RESEARCH DATA")).toBeInTheDocument();
  });

  it("shows the study texts in the language chosen with the language buttons", async () => {
    const translated = {
      ...PROTOCOL,
      protocol: {
        ...PROTOCOL.protocol,
        translationsJson: { fi: { welcomeContent: "Tervetuloa tutkimukseen.", informationContent: "Tietoa tutkimuksesta." } },
      },
    } as PreviewProtocol;
    render(<PreviewFlow protocol={translated} study={{ ...STUDY, nameByLocale: { fi: "Puhetutkimus", en: "Speech study" } }} />);
    expect(screen.getByText("Welcome text of the protocol.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: fi.languageName }));
    expect(screen.getByRole("heading", { level: 1, name: "Puhetutkimus" })).toBeInTheDocument();
    expect(screen.getByText("Tervetuloa tutkimukseen.")).toBeInTheDocument();
    await nextStep();
    expect(screen.getByText("Tietoa tutkimuksesta.")).toBeInTheDocument();
    // A text without a translation is shown in the base text.
    await userEvent.click(screen.getByRole("button", { name: en.languageName }));
    expect(screen.getByText("Information text of the protocol.")).toBeInTheDocument();
  });

  it("shows no language buttons when the study offers one language", () => {
    renderPreview({ ...STUDY, locales: ["en"] });
    expect(screen.queryByRole("button", { name: fi.languageName })).not.toBeInTheDocument();
  });

  it("lists the steps in the order of the study and leaves out disabled tasks and follow-ups", () => {
    renderPreview();
    const options = within(controls().getByRole("combobox", { name: "Go to step" })).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "1. Welcome",
      "2. Participant information",
      "3. Consent",
      "4. Microphone check",
      "5. Instructions",
      "6. Task 1: Where you grew up",
      "7. Task 1, follow-up 1",
      "8. Background questionnaire",
      "9. Debrief",
      "10. Final screen",
    ]);
    expect(controls().getByText(/tasks of Main tasks are presented in random order/)).toBeInTheDocument();
  });

  it("shows the information text first and then the consent form, as the study does", async () => {
    renderPreview();
    await userEvent.click(screen.getByRole("button", { name: en.welcome.begin }));
    expect(screen.getByRole("heading", { level: 1, name: en.information.heading })).toBeInTheDocument();
    expect(screen.getByText("Information text of the protocol.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: en.information.continue }));
    expect(screen.getByRole("heading", { level: 1, name: "Consent form title" })).toBeInTheDocument();
    expect(screen.getByText("Consent version text.")).toBeInTheDocument();
    // No box is checked in advance, and the agree button waits for the required item.
    expect(screen.getByRole("button", { name: en.consent.agree })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /I agree to take part/ }));
    await userEvent.click(screen.getByRole("button", { name: en.consent.agree }));
    expect(screen.getByRole("heading", { level: 1, name: en.micCheck.heading })).toBeInTheDocument();
  });

  it("never opens the microphone: the mic check and the recording control stay in their starting state", async () => {
    renderPreview();
    await userEvent.selectOptions(controls().getByRole("combobox", { name: "Go to step" }), "3");
    expect(controls().getByText(/does not use the microphone/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: en.micCheck.labels.allow }));
    expect(controls().getByRole("status")).toHaveTextContent("the microphone was not opened");
    // Back in the starting state: the same button is offered again.
    expect(screen.getByRole("button", { name: en.micCheck.labels.allow })).toBeEnabled();
    expect(screen.getByTestId("mic-check")).toHaveAttribute("data-state", "idle");

    await userEvent.selectOptions(controls().getByRole("combobox", { name: "Go to step" }), "5");
    expect(controls().getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByRole("heading", { level: 1, name: "Where you grew up" })).toBeInTheDocument();
    expect(screen.getByText(en.task.privacyReminder)).toBeInTheDocument();
    // The study limit (120 s) applies, not the longer limit of the task.
    expect(screen.getByText(/stops by itself after 02:00/)).toBeInTheDocument();
    expect(screen.getByText("Task 1 of 1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: en.task.recording.start }));
    expect(controls().getByRole("status")).toHaveTextContent("the microphone was not opened");
    expect(screen.getByRole("button", { name: en.task.recording.start })).toBeEnabled();

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("shows a follow-up as an optional turn when the task makes follow-ups optional", async () => {
    renderPreview();
    await userEvent.selectOptions(controls().getByRole("combobox", { name: "Go to step" }), "6");
    expect(screen.getByTestId("task-current-prompt")).toHaveTextContent("What do you miss about it?");
    expect(screen.getByTestId("task-original-prompt")).toHaveTextContent("Tell us about the place where you grew up.");
    await userEvent.click(screen.getByRole("button", { name: en.task.skip }));
    expect(screen.getByRole("heading", { level: 1, name: "About you" })).toBeInTheDocument();
  });

  it("walks to the final screen without calling any API and without storing anything", async () => {
    renderPreview();
    await userEvent.selectOptions(controls().getByRole("combobox", { name: "Go to step" }), "7");
    expect(screen.getByText("A few questions about you.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: en.questionnaire.submit }));

    expect(screen.getByRole("heading", { level: 1, name: en.debrief.heading })).toBeInTheDocument();
    expect(screen.getByText("Debrief text of the protocol.")).toBeInTheDocument();
    expect(screen.getByTestId("participant-code")).toHaveTextContent(PREVIEW_PARTICIPANT_CODE);
    expect(screen.getByText("research@example.org")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: en.debrief.finish }));

    expect(screen.getByTestId("completed-step")).toBeInTheDocument();
    expect(screen.getByText("PREVIEW - NOT RESEARCH DATA")).toBeInTheDocument();
    expect(controls().getByRole("button", { name: "Next step" })).toBeDisabled();
    await userEvent.click(controls().getByRole("button", { name: "Previous step" }));
    expect(screen.getByRole("heading", { level: 1, name: en.debrief.heading })).toBeInTheDocument();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("keeps the banner and the controls on every step", async () => {
    renderPreview();
    for (let step = 0; step < 9; step += 1) {
      expect(screen.getByText("PREVIEW - NOT RESEARCH DATA")).toBeInTheDocument();
      expect(controls().getByText(`Step ${step + 1} of 10`)).toBeInTheDocument();
      await nextStep();
    }
    expect(controls().getByText("Step 10 of 10")).toBeInTheDocument();
  });
});
