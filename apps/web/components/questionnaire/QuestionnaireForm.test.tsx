import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { questionnaireSchemas } from "@dialect/domain";
import {
  QUESTIONNAIRE_FORM_LABELS_EN,
  QUESTIONNAIRE_FORM_LABELS_FI,
  QuestionnaireAnswersView,
  QuestionnaireForm,
} from "./index";

type Item = questionnaireSchemas.QuestionnaireItemDefinition;

const ITEMS: Item[] = [
  {
    itemKey: "natural",
    type: "likert",
    prompt: "How naturally did you speak?",
    helpText: "Think of the whole session.",
    required: true,
    config: { scaleMin: 1, scaleMax: 5, scaleMinLabel: "Not at all", scaleMaxLabel: "Completely" },
  },
  {
    itemKey: "age_range",
    type: "single_choice",
    prompt: "What is your age range?",
    helpText: null,
    required: true,
    config: {
      options: [
        { value: "18_24", label: "18 to 24" },
        { value: "25_34", label: "25 to 34" },
      ],
    },
  },
  {
    itemKey: "languages",
    type: "multi_choice",
    prompt: "Which languages do you use?",
    helpText: null,
    required: false,
    config: {
      options: [
        { value: "fi", label: "Finnish" },
        { value: "sv", label: "Swedish" },
        { value: "en", label: "English" },
      ],
    },
  },
  { itemKey: "comment", type: "free_text", prompt: "Any comments?", helpText: null, required: false, config: {} },
  { itemKey: "region", type: "short_text", prompt: "Where did you grow up?", helpText: null, required: true, config: { maxLength: 50 } },
  { itemKey: "years", type: "integer", prompt: "Years lived there", helpText: null, required: false, config: { min: 0, max: 120 } },
  { itemKey: "changed", type: "boolean", prompt: "Did you change how you speak?", helpText: null, required: true, config: {} },
];

function setup(props: Partial<React.ComponentProps<typeof QuestionnaireForm>> = {}) {
  const onSubmit = vi.fn();
  render(
    <QuestionnaireForm items={ITEMS} onSubmit={onSubmit} submitLabel="Continue" labels={QUESTIONNAIRE_FORM_LABELS_EN} {...props} />,
  );
  return { onSubmit, user: userEvent.setup() };
}

async function answerRequired(user: ReturnType<typeof userEvent.setup>) {
  const likert = screen.getByRole("group", { name: /How naturally did you speak/ });
  await user.click(within(likert).getByRole("radio", { name: "4" }));
  await user.click(screen.getByRole("radio", { name: "25 to 34" }));
  await user.type(screen.getByRole("textbox", { name: /Where did you grow up/ }), "Oulu");
  await user.click(screen.getByRole("radio", { name: "No" }));
}

describe("QuestionnaireForm", () => {
  it("renders every item type with a visible label, and marks required items in text", () => {
    setup();
    const likert = screen.getByRole("group", { name: "How naturally did you speak? (required)" });
    expect(within(likert).getAllByRole("radio")).toHaveLength(5);
    expect(likert).toHaveAccessibleDescription(/Think of the whole session\..*Not at all.*Completely/);

    const single = screen.getByRole("group", { name: "What is your age range? (required)" });
    expect(within(single).getAllByRole("radio")).toHaveLength(2);

    const multi = screen.getByRole("group", { name: "Which languages do you use?" });
    expect(within(multi).getAllByRole("checkbox")).toHaveLength(3);
    expect(multi).toHaveAccessibleDescription("You can choose more than one.");

    expect(screen.getByRole("textbox", { name: "Any comments?" }).tagName).toBe("TEXTAREA");
    expect(screen.getByRole("textbox", { name: "Where did you grow up? (required)" })).toHaveAttribute("maxlength", "50");
    expect(screen.getByRole("textbox", { name: "Years lived there" })).toHaveAttribute("inputmode", "numeric");

    const yesNo = screen.getByRole("group", { name: "Did you change how you speak? (required)" });
    expect(within(yesNo).getByRole("radio", { name: "Yes" })).toBeInTheDocument();
    expect(within(yesNo).getByRole("radio", { name: "No" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toHaveAttribute("type", "submit");
  });

  it("operates the Likert scale with the keyboard as one radio group", async () => {
    const { user } = setup();
    const likert = screen.getByRole("group", { name: /How naturally did you speak/ });
    const radios = within(likert).getAllByRole("radio");
    // One name for the whole scale: the browser treats it as a single tab stop.
    expect(new Set(radios.map((radio) => radio.getAttribute("name"))).size).toBe(1);

    await user.tab();
    expect(radios[0]).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(radios[1]).toHaveFocus();
    expect(radios[1]).toBeChecked();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(radios[3]).toBeChecked();
    await user.keyboard("{ArrowLeft}");
    expect(radios[2]).toBeChecked();
    expect(radios[3]).not.toBeChecked();

    // Tab leaves the scale and reaches the next item.
    await user.tab();
    expect(screen.getByRole("radio", { name: "18 to 24" })).toHaveFocus();
  });

  it("shows required errors next to the fields, announces them and moves focus to the first invalid item", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByRole("radio", { name: "25 to 34" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(onSubmit).not.toHaveBeenCalled();
    const alert = screen.getAllByRole("alert")[0]!;
    expect(alert).toHaveTextContent("Please check the marked questions (3).");

    const likert = screen.getByRole("group", { name: /How naturally did you speak/ });
    expect(likert).toHaveAccessibleDescription(/Please answer this question\./);
    const firstRadio = within(likert).getAllByRole("radio")[0]!;
    expect(firstRadio).toHaveFocus();
    expect(firstRadio).toHaveAccessibleDescription("Please answer this question.");

    const region = screen.getByRole("textbox", { name: /Where did you grow up/ });
    expect(region).toHaveAttribute("aria-invalid", "true");
    expect(region).toHaveAccessibleDescription("Please answer this question.");
    // The answered and the optional items have no error.
    expect(screen.getByRole("group", { name: /What is your age range/ })).not.toHaveAccessibleDescription(/Please answer/);
    expect(screen.getByRole("textbox", { name: "Any comments?" })).not.toHaveAttribute("aria-invalid");

    // Answering an item removes its error.
    await user.click(within(likert).getByRole("radio", { name: "2" }));
    expect(likert).not.toHaveAccessibleDescription(/Please answer/);
  });

  it("moves focus to a later item when the first ones are valid, and explains a number out of range", async () => {
    const { user, onSubmit } = setup();
    await answerRequired(user);
    const years = screen.getByRole("textbox", { name: "Years lived there" });
    await user.type(years, "150");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(years).toHaveFocus();
    expect(years).toHaveAccessibleDescription("Enter a number from 0 to 120.");

    await user.clear(years);
    await user.type(years, "twelve");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(years).toHaveAccessibleDescription("Enter a whole number.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits typed values and leaves unanswered optional items out", async () => {
    const { user, onSubmit } = setup();
    await answerRequired(user);
    await user.click(screen.getByRole("checkbox", { name: "English" }));
    await user.click(screen.getByRole("checkbox", { name: "Finnish" }));
    await user.type(screen.getByRole("textbox", { name: "Years lived there" }), "12");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      natural: 4,
      age_range: "25_34",
      languages: ["fi", "en"],
      region: "Oulu",
      years: 12,
      changed: false,
    });
    expect(screen.queryAllByRole("alert").every((alert) => alert.textContent === "")).toBe(true);
  });

  it("starts from initial values", async () => {
    const { user, onSubmit } = setup({
      initialValues: { natural: 5, age_range: "18_24", languages: ["sv"], comment: "Fine", region: "Turku", years: 3, changed: true },
    });
    expect(screen.getByRole("radio", { name: "5" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Swedish" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Years lived there" })).toHaveValue("3");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledWith({
      natural: 5,
      age_range: "18_24",
      languages: ["sv"],
      comment: "Fine",
      region: "Turku",
      years: 3,
      changed: true,
    });
  });

  it("locks the form while a submit is pending and reports a failed submit", async () => {
    let reject: (reason: Error) => void = () => {};
    const onSubmit = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => (reject = rejectPromise)));
    const { user } = setup({ onSubmit });
    await answerRequired(user);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const pending = screen.getByRole("button", { name: "Sending..." });
    expect(pending).toBeDisabled();
    expect(screen.getByRole("group", { name: /How naturally did you speak/ })).toBeDisabled();

    reject(new Error("network"));
    expect(await screen.findByText("Your answers could not be sent. Please try again.")).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    // The answers are kept.
    expect(screen.getByRole("textbox", { name: /Where did you grow up/ })).toHaveValue("Oulu");
  });

  it("sends nothing in read-only (preview) mode but still validates", async () => {
    const { user, onSubmit } = setup({ readOnly: true });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent("Please check the marked questions (4).");

    await answerRequired(user);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Preview: the answers are valid and nothing was sent.");
  });

  it("disables every control when disabled", () => {
    setup({ disabled: true });
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Any comments?" })).toBeDisabled();
    expect(screen.getByRole("group", { name: /What is your age range/ })).toBeDisabled();
  });

  it("takes its interface text from the labels and renders a secondary action", async () => {
    const { user } = setup({
      labels: QUESTIONNAIRE_FORM_LABELS_FI,
      submitLabel: "Jatka",
      secondaryAction: <button type="button">Takaisin</button>,
      title: "Taustakysely",
    });
    expect(screen.getByRole("heading", { name: "Taustakysely" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Takaisin" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "How naturally did you speak? (pakollinen)" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Kyllä" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Jatka" }));
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent("Tarkista merkityt kysymykset (4).");
    expect(screen.getByRole("textbox", { name: /Where did you grow up/ })).toHaveAccessibleDescription("Vastaa tähän kysymykseen.");
  });
});

describe("QuestionnaireAnswersView", () => {
  const responses: questionnaireSchemas.SessionQuestionnaireResponse[] = [
    {
      responseId: "r1",
      submittedAt: "2026-10-03T10:00:00.000Z",
      questionnaire: { versionId: "v1", key: "background", versionNumber: 2, name: "Background questionnaire" },
      answers: [
        { itemId: "i1", itemKey: "age_range", type: "single_choice", prompt: "Age range?", orderIndex: 0, value: "25_34", display: "25 to 34" },
        { itemId: "i2", itemKey: "comment", type: "free_text", prompt: "Comment?", orderIndex: 1, value: null, display: null },
      ],
    },
  ];

  it("shows prompt and answer pairs with the version and the submission time", () => {
    render(<QuestionnaireAnswersView responses={responses} timeZone="Europe/Helsinki" />);
    const section = screen.getByRole("region", { name: "Background questionnaire" });
    expect(within(section).getByRole("heading", { name: "Background questionnaire" })).toBeInTheDocument();
    expect(section).toHaveTextContent("background v2");
    expect(section).toHaveTextContent("Submitted 2026-10-03 13:00");
    expect(within(section).getByText("Age range?").closest("div")).toHaveTextContent("25 to 34");
    expect(within(section).getByText("Comment?").closest("div")).toHaveTextContent("Not answered");
  });

  it("says so when nothing was submitted", () => {
    render(<QuestionnaireAnswersView responses={[]} timeZone="Europe/Helsinki" />);
    expect(screen.getByText("No questionnaire was submitted in this session.")).toBeInTheDocument();
  });
});
