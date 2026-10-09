import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  Badge,
  BADGE_VARIANTS,
  Button,
  ConfirmDialog,
  DataTable,
  FormField,
  InlineMessage,
  LikertScale,
  ListRowButton,
  MetricCard,
  Select,
  TextArea,
  TextInput,
} from "./index";

describe("Badge", () => {
  it.each(BADGE_VARIANTS)("renders its text for the %s variant", (variant) => {
    render(<Badge variant={variant}>Label for {variant}</Badge>);
    const badge = screen.getByText(`Label for ${variant}`);
    expect(badge).toBeVisible();
    expect(badge).toHaveAttribute("data-variant", variant);
  });

  it("gives TEST the striped treatment and DEMO a different one", () => {
    render(
      <>
        <Badge variant="test">TEST</Badge>
        <Badge variant="demo">DEMO</Badge>
      </>,
    );
    const test = screen.getByText("TEST");
    const demo = screen.getByText("DEMO");
    expect(test.className).toContain("bg-test-stripes");
    expect(demo.className).not.toContain("bg-test-stripes");
    expect(demo.className).not.toEqual(test.className);
  });

  it("hides decorative glyphs from assistive technology", () => {
    render(<Badge variant="flagged">Flagged</Badge>);
    const badge = screen.getByText("Flagged");
    expect(badge.querySelector("[aria-hidden='true']")).not.toBeNull();
  });
});

describe("Button", () => {
  it("is a real button with type=button by default", () => {
    render(<Button>Continue</Button>);
    const button = screen.getByRole("button", { name: "Continue" });
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
  });

  it("is disabled and busy while loading, shows the loading label and does not fire", async () => {
    const onClick = vi.fn();
    render(
      <Button loading loadingLabel="Saving..." onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Saving..." });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Save")).toBeNull();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not fire when disabled and is not marked busy", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Delete
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Delete" });
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("aria-busy");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("fires when enabled", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("FormField", () => {
  it("associates the label, help text and error with the control", () => {
    render(
      <FormField label="Contact email" help="Shown to participants." error="Enter a valid email address." required>
        <TextInput />
      </FormField>,
    );
    const input = screen.getByLabelText(/Contact email/);
    expect(input).toBeRequired();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Shown to participants. Enter a valid email address.");
    expect(screen.getByText("(required)")).toBeVisible();
  });

  it("does not mark the control invalid without an error", () => {
    render(
      <FormField label="Study name" help="Internal name.">
        <TextInput />
      </FormField>,
    );
    const input = screen.getByLabelText("Study name");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).toHaveAccessibleDescription("Internal name.");
  });

  it("works with TextArea and Select", () => {
    render(
      <>
        <FormField label="Prompt" error="The prompt is empty.">
          <TextArea mono />
        </FormField>
        <FormField label="Model" error="Select a model.">
          <Select placeholder="Select a model" options={[{ value: "a", label: "Model A" }]} />
        </FormField>
      </>,
    );
    expect(screen.getByLabelText("Prompt")).toHaveAccessibleDescription("The prompt is empty.");
    expect(screen.getByLabelText("Prompt").className).toContain("font-mono");
    expect(screen.getByLabelText("Model")).toHaveAccessibleDescription("Select a model.");
  });
});

function LikertHarness({ onChange }: { onChange?: (value: number) => void }) {
  const [value, setValue] = useState<number | null>(null);
  return (
    <LikertScale
      label="How natural did the task feel?"
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      lowLabel="Not at all"
      highLabel="Completely"
    />
  );
}

describe("LikertScale", () => {
  it("is a named group of radio buttons from 1 to 5 with nothing selected", () => {
    render(<LikertHarness />);
    const group = screen.getByRole("group", { name: "How natural did the task feel?" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(5);
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(["1", "2", "3", "4", "5"]);
    for (const radio of radios) expect(radio).not.toBeChecked();
    expect(group).toHaveAccessibleDescription(/Not at all/);
  });

  it("selects by click and reports the number", async () => {
    const onChange = vi.fn();
    render(<LikertHarness onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "4" }));
    expect(onChange).toHaveBeenCalledWith(4);
    expect(screen.getByRole("radio", { name: "4" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "3" })).not.toBeChecked();
  });

  it("is operable with the keyboard as one radio group", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LikertHarness onChange={onChange} />);
    await user.tab();
    expect(screen.getByRole("radio", { name: "1" })).toHaveFocus();
    await user.keyboard(" ");
    expect(screen.getByRole("radio", { name: "1" })).toBeChecked();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "2" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "2" })).toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith(2);
    // One tab stop for the whole group.
    await user.tab();
    expect(document.body).toHaveFocus();
  });

  it("supports other ranges", () => {
    render(<LikertScale label="Scale" value={7} onChange={() => undefined} min={1} max={7} />);
    expect(screen.getAllByRole("radio")).toHaveLength(7);
    expect(screen.getByRole("radio", { name: "7" })).toBeChecked();
  });
});

describe("ConfirmDialog", () => {
  it("gates the confirm button on the exact typed phrase", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        tone="danger"
        title="Delete all TEST data?"
        confirmLabel="Delete TEST data"
        confirmPhrase="DELETE TEST DATA"
        onConfirm={onConfirm}
        onCancel={() => undefined}
      >
        <p>This cannot be undone.</p>
      </ConfirmDialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Delete all TEST data?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete TEST data" });
    const input = within(dialog).getByRole("textbox", { name: /Type DELETE TEST DATA to confirm/ });
    expect(confirm).toBeDisabled();

    await user.type(input, "delete test data");
    expect(confirm).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "DELETE TEST DATA");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("confirms without a phrase and cancels through the Cancel button", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open title="Exclude this session?" confirmLabel="Exclude session" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Exclude session" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("renders nothing interactive while closed and disables actions while busy", () => {
    const { rerender } = render(
      <ConfirmDialog open={false} title="Cancel batch?" confirmLabel="Cancel batch" onConfirm={() => undefined} onCancel={() => undefined} />,
    );
    expect(screen.queryByRole("button", { name: "Cancel batch" })).toBeNull();
    rerender(
      <ConfirmDialog open busy busyLabel="Cancelling..." title="Cancel batch?" confirmLabel="Cancel batch" onConfirm={() => undefined} onCancel={() => undefined} />,
    );
    expect(screen.getByRole("button", { name: "Cancelling..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});

describe("InlineMessage", () => {
  it("uses alert for errors and status for the others", () => {
    render(
      <>
        <InlineMessage variant="error">Save failed</InlineMessage>
        <InlineMessage variant="success">Saved</InlineMessage>
      </>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });
});

describe("selected rows", () => {
  // slate-500 on the selected blue-50 background is 4.38:1; metadata inside a selected row is slate-600.
  it("ListRowButton marks the selected row and darkens muted metadata inside it", () => {
    render(
      <>
        <ListRowButton selected>
          <span className="text-slate-500">selected meta</span>
        </ListRowButton>
        <ListRowButton>
          <span className="text-slate-500">other meta</span>
        </ListRowButton>
      </>,
    );
    const [selected, other] = screen.getAllByRole("button");
    expect(selected).toHaveAttribute("aria-current", "true");
    expect(selected).toHaveClass("bg-blue-50");
    expect(other).not.toHaveAttribute("aria-current");
    // The rule is tied to aria-current, so it applies to the selected row only.
    for (const row of [selected, other]) {
      expect(row).toHaveClass("aria-[current=true]:[&_.text-slate-500]:text-slate-600");
    }
  });

  it("DataTable darkens muted metadata in the selected row only", () => {
    render(
      <DataTable
        caption="Versions"
        columns={[{ key: "name", header: "Name", cell: (row: { id: string }) => row.id }]}
        rows={[{ id: "a" }, { id: "b" }]}
        getRowKey={(row) => row.id}
        selectedKey="a"
      />,
    );
    const [, first, second] = screen.getAllByRole("row");
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(first).toHaveClass("bg-blue-50", "[&_.text-slate-500]:text-slate-600");
    expect(second).toHaveAttribute("aria-selected", "false");
    expect(second).not.toHaveClass("[&_.text-slate-500]:text-slate-600");
  });
});

describe("DataTable scrolling", () => {
  const props = {
    caption: "Model runs",
    columns: [{ key: "name", header: "Name", cell: (row: { id: string }) => row.id }],
    rows: [{ id: "a" }],
    getRowKey: (row: { id: string }) => row.id,
  };

  it("is a positioned container, so the hidden caption cannot stretch the page", () => {
    render(<DataTable {...props} />);
    const wrapper = screen.getByRole("table", { name: "Model runs" }).parentElement;
    expect(wrapper).toHaveClass("relative", "overflow-auto");
    // Without a height limit it is not an extra tab stop.
    expect(wrapper).not.toHaveAttribute("tabindex");
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("is a focusable region named by the caption when its height is limited", () => {
    const { rerender } = render(<DataTable {...props} maxHeightClassName="max-h-80" />);
    const region = screen.getByRole("region", { name: "Model runs" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveClass("max-h-80", "focus-visible:ring-2");
    region.focus();
    expect(region).toHaveFocus();

    // Rows with their own buttons opt out.
    rerender(<DataTable {...props} maxHeightClassName="max-h-80" scrollRegion={false} />);
    expect(screen.queryByRole("region")).toBeNull();
  });
});

describe("MetricCard tooltip", () => {
  it("stays described by its tooltip and can open toward the left in the last column", () => {
    render(
      <>
        <MetricCard label="Utterances" value="12" tooltip="Submitted recordings." tooltipAlign="end" />
        <MetricCard label="Consented" value="3" tooltip="Accepted the consent form." />
      </>,
    );
    const end = screen.getByRole("button", { name: "About Utterances" });
    expect(end).toHaveAccessibleDescription("Submitted recordings.");
    const [endTip, centerTip] = screen.getAllByRole("tooltip");
    expect(endTip).toHaveClass("right-0");
    expect(endTip).not.toHaveClass("left-1/2");
    expect(centerTip).toHaveClass("left-1/2", "-translate-x-1/2");
  });
});
