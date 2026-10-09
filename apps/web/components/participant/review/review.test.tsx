import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { sessionSchemas } from "@dialect/domain";
import { format } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { EnglishCheckStep } from "./EnglishCheckStep";
import { OutputReviewStep } from "./OutputReviewStep";

const englishCheck: sessionSchemas.EnglishCheckContent = {
  version: "lextale-en-2011",
  items: [
    { index: 0, text: "platery" },
    { index: 1, text: "denial" },
    { index: 2, text: "generic" },
  ],
};

const ownItem: sessionSchemas.OutputReviewItemContent = {
  id: "11111111-1111-4111-8111-111111111111",
  sourceText: "mä en oo",
  versions: [
    { slot: 1, text: "I'm not" },
    { slot: 2, text: "I am not" },
  ],
  audio: { source: true },
};

describe("EnglishCheckStep", () => {
  it("shows the instructions, then one item at a time in order, and sends every answer at the end", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<EnglishCheckStep t={en} englishCheck={englishCheck} onSubmit={onSubmit} onSkip={() => undefined} />);
    expect(screen.getByText(en.englishCheck.instructions[0]!)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: en.englishCheck.start }));
    expect(screen.getByTestId("english-check-item")).toHaveTextContent("platery");
    await userEvent.click(screen.getByRole("button", { name: en.englishCheck.no }));
    expect(screen.getByTestId("english-check-item")).toHaveTextContent("denial");
    await userEvent.click(screen.getByRole("button", { name: en.englishCheck.yes }));
    await userEvent.click(screen.getByRole("button", { name: en.englishCheck.yes }));
    expect(onSubmit).toHaveBeenCalledWith([false, true, true]);
  });

  it("can be skipped before it starts", async () => {
    const onSkip = vi.fn();
    render(<EnglishCheckStep t={en} englishCheck={englishCheck} onSubmit={vi.fn()} onSkip={onSkip} />);
    await userEvent.click(screen.getByRole("button", { name: en.englishCheck.skip }));
    expect(onSkip).toHaveBeenCalled();
  });
});

describe("OutputReviewStep", () => {
  const ready = (item: sessionSchemas.OutputReviewItemContent): sessionSchemas.OutputReviewContent => ({
    status: "ready",
    itemNumber: 2,
    totalItems: 5,
    item,
  });

  it("names the versions only Version 1 and Version 2, plays the own recording, and asks for every answer", async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <OutputReviewStep t={en} review={ready(ownItem)} audioUrl={(id, which) => `/a/${id}/${which}`} onAnswer={onAnswer} onSkip={() => undefined} />,
    );
    expect(screen.getByTestId("review-source-text")).toHaveTextContent("mä en oo");
    expect(screen.getByTestId("review-version-1")).toHaveTextContent("Version 1");
    expect(screen.getByTestId("review-version-2")).toHaveTextContent("Version 2");
    expect(document.body.textContent).not.toMatch(/default|preservation|condition|model/i);
    expect(screen.getByText(format(en.review.progress, { current: 2, total: 5 }))).toBeInTheDocument();
    // Only the participant's own recording is offered.
    expect(document.querySelectorAll("audio")).toHaveLength(1);
    // Every point of both scales is labelled, plus "I can't say".
    for (const [question, points] of [
      [en.review.meaning, en.review.meaningScale],
      [en.review.representation, en.review.representationScale],
    ] as const) {
      const groups = screen.getAllByRole("group", { name: question });
      expect(groups).toHaveLength(2);
      for (const group of groups) {
        for (const point of [...points, en.review.cantSay]) expect(within(group).getByLabelText(point)).toBeInTheDocument();
      }
    }

    await userEvent.click(screen.getByRole("button", { name: en.review.next }));
    expect(screen.getByText(en.review.answerAll)).toBeInTheDocument();
    expect(onAnswer).not.toHaveBeenCalled();

    const pick = async (legend: string, value: string, nth = 0) => {
      const group = screen.getAllByRole("group", { name: legend })[nth]!;
      await userEvent.click(within(group).getByLabelText(value));
    };
    await pick(en.review.said, en.review.saidPartly);
    await pick(en.review.meaning, en.review.meaningScale[4], 0);
    await pick(en.review.representation, en.review.representationScale[3], 0);
    await pick(en.review.meaning, en.review.cantSay, 1);
    await pick(en.review.representation, en.review.representationScale[1], 1);
    await userEvent.click(screen.getByRole("button", { name: en.review.next }));
    expect(onAnswer).toHaveBeenCalledWith(ownItem.id, {
      source: { said: "partly" },
      versions: {
        "1": { meaning: 5, representation: 4 },
        "2": { meaning: "cant_judge", representation: 2 },
      },
    });
  });

  it("shows a calm preparing screen while the recordings are processed", () => {
    render(
      <OutputReviewStep
        t={en}
        review={{ status: "preparing", waitedSeconds: 10, maxWaitSeconds: 120 }}
        audioUrl={() => ""}
        onAnswer={vi.fn()}
        onSkip={() => undefined}
      />,
    );
    expect(screen.getByRole("heading", { name: en.review.preparingTitle })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.review.skip })).toBeInTheDocument();
  });
});
