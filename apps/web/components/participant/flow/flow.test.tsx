import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { sessionSchemas } from "@dialect/domain";
import { en } from "@/lib/i18n/en";
import { fi } from "@/lib/i18n/fi";
import { makeFakeEnvironment } from "../recorder/recorderTestHelpers";
import {
  CompletedStep,
  ConsentStep,
  DebriefStep,
  EndParticipationDialog,
  FlowShell,
  InformationStep,
  InstructionsStep,
  MessageScreen,
  MicCheckStep,
  QuestionnaireStep,
  StudyText,
  TaskStep,
  WelcomeStep,
  WithdrawnStep,
  parseStudyText,
  type TaskStepTask,
} from "./index";

const CONSENT: sessionSchemas.ConsentContent = {
  consentVersionId: "00000000-0000-4000-8000-000000000001",
  versionNumber: 1,
  title: "Information about the study and consent",
  informationText: "# Purpose\n\nWe study speech.\n\n- one\n- two",
  items: [
    { id: "participation", text: "I agree to take part.", required: true },
    { id: "voice", text: "I agree that my voice is recorded.", required: true },
    { id: "reuse", text: "My recordings may be reused.", required: false },
  ],
  privacyNoticeUrl: "https://example.org/privacy",
  contactText: "Research group\nresearch@example.org",
};

const TASK: TaskStepTask = {
  title: "Where you grew up",
  prompt: "Tell us about the place where you grew up.",
  context: null,
  instructions: null,
  minDurationSeconds: null,
  suggestedDurationSeconds: 60,
  maxDurationSeconds: 180,
  privacyReminder: false,
  topicSuggestions: [],
  turn: { turnIndex: 0, totalTurns: 2, promptText: "Tell us about the place where you grew up.", isFollowup: false, isOptional: false },
};

describe("StudyText", () => {
  it("splits a text into headings, lists and paragraphs", () => {
    expect(parseStudyText("# Title\nFirst line\nsecond line\n\n## Sub\n- a\n- b\n\nLast")).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", lines: ["First line", "second line"] },
      { kind: "heading", level: 2, text: "Sub" },
      { kind: "list", items: ["a", "b"] },
      { kind: "paragraph", lines: ["Last"] },
    ]);
    expect(parseStudyText("")).toEqual([]);
    expect(parseStudyText(null)).toEqual([]);
    expect(parseStudyText("one\r\n\r\ntwo")).toEqual([
      { kind: "paragraph", lines: ["one"] },
      { kind: "paragraph", lines: ["two"] },
    ]);
    // Only "# " and "## " at the start of a line are headings, and "- " needs the space.
    expect(parseStudyText("#hashtag\n-5 degrees")).toEqual([{ kind: "paragraph", lines: ["#hashtag", "-5 degrees"] }]);
  });

  it("renders headings below the page heading, lists and paragraphs with line breaks", () => {
    const { container } = render(<StudyText text={"# Purpose\n\nLine one\nline two\n\n## Detail\n\n- first\n- second"} />);
    expect(screen.getByRole("heading", { level: 2, name: "Purpose" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Detail" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["first", "second"]);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelectorAll("p br")).toHaveLength(1);
    expect(container.querySelector("h1")).toBeNull();
  });

  it("shows HTML in a study text as text and never renders it", () => {
    const text = '<script>window.hacked = true</script>\n\n<img src=x onerror="alert(1)"> <b>bold</b> <a href="javascript:alert(1)">link</a>\n\n# <i>Heading</i>\n\n- <u>item</u>';
    const { container } = render(<StudyText text={text} />);
    expect(container.querySelector("script, img, b, a, i, u")).toBeNull();
    expect(container.textContent).toContain("<script>window.hacked = true</script>");
    expect(container.textContent).toContain('<img src=x onerror="alert(1)"> <b>bold</b>');
    expect(screen.getByRole("heading", { name: "<i>Heading</i>" })).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent("<u>item</u>");
    expect((window as unknown as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("renders nothing for an empty text and sets lang only when it is given", () => {
    const { container, rerender } = render(<StudyText text={"  \n \n"} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<StudyText text="Hei" />);
    expect(screen.getByTestId("study-text")).not.toHaveAttribute("lang");
    rerender(<StudyText text="Hei" lang="fi" />);
    expect(screen.getByTestId("study-text")).toHaveAttribute("lang", "fi");
  });
});

describe("FlowShell", () => {
  const base = { t: en, locale: "en" as const, onLocaleChange: () => undefined };

  it("sets the interface language and shows language buttons only when there is a choice", async () => {
    const onLocaleChange = vi.fn();
    const { rerender } = render(
      <FlowShell {...base} locales={["fi", "en"]} onLocaleChange={onLocaleChange}>
        <p>content</p>
      </FlowShell>,
    );
    expect(screen.getByTestId("participant-flow")).toHaveAttribute("lang", "en");
    expect(screen.getByRole("main")).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Language" });
    expect(within(group).getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(group).getByRole("button", { name: "Suomi" }));
    expect(onLocaleChange).toHaveBeenCalledWith("fi");

    rerender(
      <FlowShell {...base} t={fi} locale="fi" locales={["fi"]}>
        <p>content</p>
      </FlowShell>,
    );
    expect(screen.getByTestId("participant-flow")).toHaveAttribute("lang", "fi");
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("keeps the task progress line inside the main landmark", () => {
    render(
      <FlowShell {...base} locales={["en"]} progress={{ taskNumber: 2, totalTasks: 5 }}>
        <p>content</p>
      </FlowShell>,
    );
    const main = screen.getByRole("main");
    expect(within(main).getByText("Task 2 of 5")).toBeInTheDocument();
    expect(within(main).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
  });

  it("writes a declared content language on study texts and task texts, and nothing when it is not declared", () => {
    const { rerender } = render(
      <FlowShell {...base} locales={["en"]}>
        <StudyText text="Tervetuloa tutkimukseen." />
        <TaskStep t={en} task={TASK} onSubmitRecording={() => Promise.resolve()} />
      </FlowShell>,
    );
    // Not declared (the participant API has no such field today): no lang attribute, nothing is guessed.
    expect(screen.getByTestId("study-text")).not.toHaveAttribute("lang");
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveAttribute("lang");
    expect(screen.getByTestId("task-current-prompt")).not.toHaveAttribute("lang");

    rerender(
      <FlowShell {...base} locales={["en"]} contentLang="fi">
        <StudyText text="Tervetuloa tutkimukseen." />
        <TaskStep t={en} task={TASK} onSubmitRecording={() => Promise.resolve()} />
      </FlowShell>,
    );
    expect(screen.getByTestId("participant-flow")).toHaveAttribute("lang", "en");
    expect(screen.getByTestId("study-text")).toHaveAttribute("lang", "fi");
    expect(screen.getByRole("heading", { level: 1 })).toHaveAttribute("lang", "fi");
    expect(screen.getByTestId("task-current-prompt")).toHaveAttribute("lang", "fi");
    // Interface words keep the interface language.
    expect(screen.getByText("Speaking task")).not.toHaveAttribute("lang");
  });

  it("shows a banner for test and demo sessions and never for research", () => {
    const { rerender, container } = render(
      <FlowShell {...base} locales={["en"]} mode="research">
        <p>content</p>
      </FlowShell>,
    );
    expect(container.querySelector("[data-mode]")).toBeNull();
    rerender(
      <FlowShell {...base} locales={["en"]} mode="test">
        <p>content</p>
      </FlowShell>,
    );
    expect(container.querySelector('[data-mode="TEST"]')).toHaveTextContent(en.modeBanner.test);
    rerender(
      <FlowShell {...base} locales={["en"]} mode="demo">
        <p>content</p>
      </FlowShell>,
    );
    expect(container.querySelector('[data-mode="DEMO"]')).toHaveTextContent(en.modeBanner.demo);
  });

  it("shows the task progress line and the end action only when they are passed", async () => {
    const onEnd = vi.fn();
    const { rerender } = render(
      <FlowShell {...base} locales={["en"]}>
        <p>content</p>
      </FlowShell>,
    );
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "End participation" })).not.toBeInTheDocument();
    rerender(
      <FlowShell {...base} locales={["en"]} progress={{ taskNumber: 2, totalTasks: 7 }} onEndParticipation={onEnd}>
        <p>content</p>
      </FlowShell>,
    );
    expect(screen.getByText("Task 2 of 7")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Task 2 of 7" })).toHaveAttribute("aria-valuenow", "2");
    await userEvent.click(screen.getByRole("button", { name: "End participation" }));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe("WelcomeStep", () => {
  it("shows the study name, the welcome text and one Begin button", async () => {
    const onBegin = vi.fn();
    render(<WelcomeStep t={en} studyName="Speech study" welcomeContent={"Welcome.\n\nIt takes 20 minutes."} onBegin={onBegin} />);
    expect(screen.getByRole("heading", { level: 1, name: "Speech study" })).toBeInTheDocument();
    expect(screen.getByText("It takes 20 minutes.")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Begin" }));
    expect(onBegin).toHaveBeenCalledTimes(1);
  });

  it("shows the closed message instead of the button when the study takes no participants", () => {
    render(
      <WelcomeStep t={en} studyName="Speech study" welcomeContent="Welcome." closedMessage={en.welcome.studyClosed} onBegin={() => undefined} />,
    );
    expect(screen.getByTestId("study-closed")).toHaveTextContent("This study is not currently accepting new participants.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("lets a running session continue even when the study is closed for new participants", () => {
    render(
      <WelcomeStep t={fi} studyName="Puhetutkimus" welcomeContent={null} closedMessage={fi.welcome.studyClosed} resumable onBegin={() => undefined} />,
    );
    expect(screen.getByRole("button", { name: "Jatka tutkimusta" })).toBeInTheDocument();
    expect(screen.queryByTestId("study-closed")).not.toBeInTheDocument();
  });

  it("shows a failure as an alert in plain language", () => {
    render(<WelcomeStep t={en} studyName="S" welcomeContent={null} error={en.errors.NETWORK_ERROR} onBegin={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The server could not be reached.");
  });
});

describe("InformationStep and InstructionsStep", () => {
  it("show the protocol text under one h1 and continue", async () => {
    const onContinue = vi.fn();
    const { unmount } = render(<InformationStep t={en} content={"# What happens\n\nYou record answers."} onContinue={onContinue} />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2, name: "What happens" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue to consent" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    unmount();

    const onStart = vi.fn();
    render(<InstructionsStep t={en} content="Speak naturally." onStart={onStart} />);
    expect(screen.getByRole("heading", { level: 1, name: "Instructions" })).toBeInTheDocument();
    expect(screen.getByText("Speak naturally.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});

describe("ConsentStep", () => {
  it("never checks a box in advance and enables the button only when every required item is checked", async () => {
    const user = userEvent.setup();
    const onAgree = vi.fn();
    render(<ConsentStep t={en} consent={CONSENT} onAgree={onAgree} onDecline={() => undefined} />);

    expect(screen.getByRole("heading", { level: 1, name: CONSENT.title })).toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    for (const box of boxes) expect(box).not.toBeChecked();
    const agree = screen.getByRole("button", { name: "I agree and continue" });
    expect(agree).toBeDisabled();
    expect(agree).toHaveAccessibleDescription(en.consent.requiredNote);

    await user.click(agree);
    expect(onAgree).not.toHaveBeenCalled();

    // Required is stated in text, not by color or an asterisk alone.
    const first = screen.getByRole("checkbox", { name: "I agree to take part. (required)" });
    const second = screen.getByRole("checkbox", { name: "I agree that my voice is recorded. (required)" });
    const optional = screen.getByRole("checkbox", { name: "My recordings may be reused. (optional)" });
    await user.click(first);
    expect(agree).toBeDisabled();
    await user.click(optional);
    expect(agree).toBeDisabled();
    await user.click(second);
    expect(agree).toBeEnabled();
    await user.click(optional);
    await user.click(second);
    expect(agree).toBeDisabled();
    await user.click(second);

    await user.click(agree);
    expect(onAgree).toHaveBeenCalledWith([
      { itemId: "participation", accepted: true },
      { itemId: "voice", accepted: true },
      { itemId: "reuse", accepted: false },
    ]);
  });

  it("opens the privacy notice in a new tab without access to the opener, and shows the contact text", () => {
    render(<ConsentStep t={en} consent={CONSENT} onAgree={() => undefined} onDecline={() => undefined} />);
    const link = screen.getByRole("link", { name: "Privacy notice" });
    expect(link).toHaveAttribute("href", "https://example.org/privacy");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("(opens in a new tab)")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Contact" })).toBeInTheDocument();
    expect(screen.getByText(/research@example.org/)).toBeInTheDocument();
  });

  it("does not render a privacy link that is not http or https", () => {
    render(
      <ConsentStep
        t={en}
        consent={{ ...CONSENT, privacyNoticeUrl: "javascript:alert(1)" }}
        onAgree={() => undefined}
        onDecline={() => undefined}
      />,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("offers a clear way out that does not submit consent", async () => {
    const onAgree = vi.fn();
    const onDecline = vi.fn();
    render(<ConsentStep t={fi} consent={CONSENT} onAgree={onAgree} onDecline={onDecline} />);
    await userEvent.click(screen.getByRole("button", { name: "En halua osallistua" }));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onAgree).not.toHaveBeenCalled();
  });
});

describe("MicCheckStep", () => {
  it("does not open the microphone by itself and reports only technical settings", async () => {
    const user = userEvent.setup();
    const env = makeFakeEnvironment();
    const onContinue = vi.fn();
    render(<MicCheckStep t={en} onContinue={onContinue} dependencies={env.dependencies} />);
    expect(screen.getByRole("heading", { level: 1, name: "Microphone check" })).toBeInTheDocument();
    expect(env.dependencies.requestMicrophone).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Allow microphone" }));
    await user.click(await screen.findByRole("button", { name: "Record test" }));
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));

    expect(onContinue).toHaveBeenCalledTimes(1);
    const result = onContinue.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(["audioEnvironment", "browserInfo", "constraintMismatches", "fallback"]);
    // No audio: nothing in the result is a Blob or a blob URL.
    expect(JSON.stringify(result)).not.toMatch(/blob/i);
    // The test recording left memory when the participant continued.
    expect(env.revokedUrls.length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Allow microphone" })).not.toBeInTheDocument();
  });
});

describe("TaskStep", () => {
  const submit = () => Promise.resolve();

  it("shows a neutral label, the title and the prompt, and never the task category", () => {
    const { container } = render(<TaskStep t={en} task={TASK} onSubmitRecording={submit} onSkip={() => undefined} />);
    expect(screen.getByText("Speaking task")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Where you grew up" })).toBeInTheDocument();
    expect(screen.getByTestId("task-current-prompt")).toHaveTextContent(TASK.prompt);
    expect(screen.queryByTestId("task-original-prompt")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start recording" })).toBeInTheDocument();
    expect(screen.getByText(/Suggested length: about 1 minute\./)).toBeInTheDocument();
    expect(screen.getByText("The recording stops by itself after 03:00.")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/controlled|semi|structured|free speech|dialect/i);
    // A required main prompt cannot be skipped.
    expect(screen.queryByRole("button", { name: "Skip this question" })).not.toBeInTheDocument();
    expect(screen.queryByText(en.task.privacyReminder)).not.toBeInTheDocument();
  });

  it("shows a follow-up as the current prompt with the original prompt quietly above", () => {
    const task: TaskStepTask = {
      ...TASK,
      turn: { turnIndex: 1, totalTurns: 2, promptText: "How do people speak there?", isFollowup: true, isOptional: false },
    };
    render(<TaskStep t={en} task={task} onSubmitRecording={submit} />);
    expect(screen.getByText("Follow-up question", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByTestId("task-current-prompt")).toHaveTextContent("How do people speak there?");
    expect(screen.getByTestId("task-original-prompt")).toHaveTextContent(TASK.prompt);
    expect(screen.getByText("Earlier in this task")).toBeInTheDocument();
  });

  it("offers Skip only for an optional turn", async () => {
    const onSkip = vi.fn();
    const task: TaskStepTask = {
      ...TASK,
      turn: { turnIndex: 1, totalTurns: 2, promptText: "Anything else?", isFollowup: true, isOptional: true },
    };
    render(<TaskStep t={en} task={task} onSubmitRecording={submit} onSkip={onSkip} />);
    expect(screen.getByText("Answering this question is optional.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Skip this question" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("shows the privacy reminder and the topic suggestions when the task has them", () => {
    render(
      <TaskStep
        t={fi}
        task={{ ...TASK, privacyReminder: true, topicSuggestions: ["A trip", "A hobby"] }}
        onSubmitRecording={submit}
      />,
    );
    expect(screen.getByText(fi.task.privacyReminder)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: fi.task.topicSuggestionsHeading })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["A trip", "A hobby"]);
    expect(screen.getByRole("button", { name: "Aloita äänitys" })).toBeInTheDocument();
  });

  it("keeps the recording after a failed upload, retries with the same recording and passes the attempt count", async () => {
    const user = userEvent.setup();
    const env = makeFakeEnvironment();
    const onSubmitRecording = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    render(<TaskStep t={en} task={TASK} onSubmitRecording={onSubmitRecording} dependencies={env.dependencies} />);
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await user.click(screen.getByRole("button", { name: "Record again" }));
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    await user.click(screen.getByRole("button", { name: "Submit and continue" }));
    expect(await screen.findByText(en.task.recording.uploadFailed)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try uploading again" }));
    await screen.findByText("The recording was saved.");
    expect(onSubmitRecording).toHaveBeenCalledTimes(2);
    expect(onSubmitRecording.mock.calls[1][0]).toBe(onSubmitRecording.mock.calls[0][0]);
    expect(onSubmitRecording.mock.calls[1][1]).toMatchObject({ attemptCount: 2 });
    // One recorder per attempt: the retry did not record again.
    expect(env.recorders).toHaveLength(2);
  });

  it("says that the recording must be made again when the server refuses the file itself", async () => {
    const user = userEvent.setup();
    const env = makeFakeEnvironment();
    const refused = Object.assign(new Error("not acceptable"), { code: "INVALID_AUDIO" });
    render(<TaskStep t={en} task={TASK} onSubmitRecording={() => Promise.reject(refused)} dependencies={env.dependencies} />);
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await user.click(screen.getByRole("button", { name: "Submit and continue" }));
    // Shown in the control and announced once.
    expect((await screen.findAllByText(en.upload.invalidAudio)).length).toBeGreaterThan(0);
    expect(screen.getByTestId("recording-announcement")).toHaveTextContent(en.upload.invalidAudio);
    expect(screen.queryByText(en.task.recording.uploadFailed)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record again" })).toBeEnabled();
  });
});

describe("QuestionnaireStep", () => {
  const questionnaire: Pick<sessionSchemas.QuestionnaireContent, "name" | "description" | "items"> = {
    name: "Background questionnaire",
    description: "A few questions about you.",
    items: [
      { itemKey: "region", type: "short_text", prompt: "Where did you grow up?", helpText: null, required: true, config: { maxLength: 50 } },
      { itemKey: "comfort", type: "likert", prompt: "How comfortable were you?", helpText: null, required: false, config: {} },
    ],
  };

  it("renders the questionnaire with localized interface text and submits typed answers", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<QuestionnaireStep t={fi} questionnaire={questionnaire} onSubmit={onSubmit} />);
    expect(screen.getByRole("heading", { level: 1, name: "Background questionnaire" })).toBeInTheDocument();
    expect(screen.getByText("A few questions about you.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Jatka" }));
    expect(screen.getByText("Vastaa tähän kysymykseen.")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: /Where did you grow up/ }), "Kuopio");
    await user.click(screen.getByRole("button", { name: "Jatka" }));
    expect(onSubmit).toHaveBeenCalledWith({ region: "Kuopio" });
  });

  it("lists the problems the server reports next to the question they belong to", () => {
    render(
      <QuestionnaireStep
        t={en}
        questionnaire={questionnaire}
        onSubmit={() => Promise.resolve()}
        serverIssues={[
          { itemKey: "region", code: "too_long" },
          { itemKey: "comfort", code: "out_of_range" },
          { itemKey: "unknown_item", code: "unknown_item" },
        ]}
      />,
    );
    const list = screen.getByTestId("questionnaire-server-issues");
    const entries = within(list).getAllByRole("listitem").map((item) => item.textContent);
    expect(entries).toEqual([
      "Where did you grow up? The answer can be at most 50 characters long.",
      "How comfortable were you? Enter a number from 1 to 5.",
    ]);
    expect(list.closest('[role="alert"]')).toHaveTextContent("Please check the marked questions (2).");
  });
});

describe("DebriefStep", () => {
  it("shows the debrief text, the contact text and the participant code with its explanation", async () => {
    const onFinish = vi.fn();
    render(
      <DebriefStep
        t={en}
        debrief={{ content: "Thank you.\n\nWe compare systems.", contactText: "research@example.org" }}
        participantCode="P-7K4M9Q"
        onFinish={onFinish}
      />,
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("We compare systems.")).toBeInTheDocument();
    const code = screen.getByTestId("participant-code");
    expect(code).toHaveTextContent("P-7K4M9Q");
    expect(code.className).toContain("font-mono");
    expect(screen.getByRole("group", { name: "Your participant code" })).toHaveAccessibleDescription(en.debrief.codeExplanation);
    expect(screen.getByText("research@example.org")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});

describe("final screens", () => {
  it("shows Start next participant only in study laptop mode", async () => {
    const onStartNext = vi.fn();
    const { rerender } = render(<CompletedStep t={en} studyLaptopMode={false} onStartNext={onStartNext} />);
    expect(screen.getByRole("heading", { level: 1, name: "Thank you for taking part" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(<CompletedStep t={en} studyLaptopMode onStartNext={onStartNext} />);
    await userEvent.click(screen.getByRole("button", { name: "Start next participant" }));
    expect(onStartNext).toHaveBeenCalledTimes(1);
  });

  it("shows the debrief, the code and the contact text after withdrawal, and promises no deletion", () => {
    const { container } = render(
      <WithdrawnStep
        t={en}
        debrief={{ content: "About the study.", contactText: "research@example.org" }}
        participantCode="P-7K4M9Q"
        onBackToStart={() => undefined}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Your participation has ended" })).toBeInTheDocument();
    expect(screen.getByText("About the study.")).toBeInTheDocument();
    expect(screen.getByTestId("participant-code")).toHaveTextContent("P-7K4M9Q");
    expect(screen.getByText("research@example.org")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/delet|remov|eras/i);
  });

  it("shows no code and no debrief when the participant declined before consent", () => {
    render(
      <WithdrawnStep
        t={en}
        declined
        debrief={{ content: "About the study.", contactText: "research@example.org" }}
        participantCode="P-7K4M9Q"
        onBackToStart={() => undefined}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "You chose not to take part" })).toBeInTheDocument();
    expect(screen.queryByTestId("participant-code")).not.toBeInTheDocument();
    expect(screen.queryByText("About the study.")).not.toBeInTheDocument();
    expect(screen.getByText("research@example.org")).toBeInTheDocument();
  });

  it("shows a calm message screen with a way forward", async () => {
    const onAction = vi.fn();
    render(
      <MessageScreen
        title={en.errorScreens.sessionExpiredTitle}
        message={en.errors.SESSION_EXPIRED}
        actionLabel={en.common.backToStart}
        onAction={onAction}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "The session has ended" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to the first page" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("confirms End participation in plain language without promising deletion", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(<EndParticipationDialog t={en} open onConfirm={onConfirm} onCancel={onCancel} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "End your participation?" })).toBeInTheDocument();
    expect(dialog.textContent).toContain("A recording that you have not submitted is discarded.");
    expect(dialog.textContent).not.toMatch(/will be deleted|we delete|erase/i);
    await userEvent.click(within(dialog).getByRole("button", { name: "Continue the study" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "End participation" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    rerender(<EndParticipationDialog t={en} open error={en.endParticipation.failed} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(en.endParticipation.failed);
  });
});
