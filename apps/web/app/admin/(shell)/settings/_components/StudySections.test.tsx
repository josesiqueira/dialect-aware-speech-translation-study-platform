import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { corpusSchemas } from "@dialect/domain";
import { INTERFACE_LOCALES } from "@/lib/i18n";

const apiFetch = vi.fn();
vi.mock("@/lib/client/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  isApiClientError: () => false,
}));

import { ExampleTextNotice, StudySections } from "./StudySections";

type Settings = corpusSchemas.SettingsView;

// Mock data: only the parts of the settings view these cards read.
function settings(overrides: { study?: Partial<Settings["study"]>; languages?: Partial<Settings["languages"]> } = {}): Settings {
  return {
    study: {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "study",
      name: "Dialect-Aware Speech Translation Study",
      participantTitle: "Speech and translation study",
      effectiveParticipantTitle: "Speech and translation study",
      participantTitleWarnings: [],
      ...overrides.study,
    },
    languages: {
      sourceLanguage: "fi",
      targetLanguage: "en",
      participantLocales: ["fi", "en"],
      defaultLocale: "fi",
      interfaceLocales: ["en", "fi"],
      ...overrides.languages,
    },
  } as Settings;
}

describe("interface languages", () => {
  it("the list the settings accept equals the languages the interface has dictionaries for", () => {
    expect([...corpusSchemas.INTERFACE_LOCALES].sort()).toEqual([...INTERFACE_LOCALES].sort());
  });
});

describe("StudySections", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("saves the internal name and the participant-facing title as separate fields", async () => {
    const stored = settings();
    apiFetch.mockResolvedValue(stored);
    render(<StudySections settings={stored} onSaved={async () => undefined} />);
    expect(screen.getByLabelText("Internal study name")).toHaveValue("Dialect-Aware Speech Translation Study");
    fireEvent.change(screen.getByLabelText("Participant-facing title"), { target: { value: "Speech study" } });
    fireEvent.click(screen.getAllByRole("button", { name: /save/i })[0]!);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledWith("/api/admin/settings", {
      method: "PUT",
      body: {
        studyName: "Dialect-Aware Speech Translation Study",
        participantTitle: "Speech study",
        participantTitleTranslations: {},
      },
    });
  });

  it("saves the title of each other participant language", async () => {
    const stored = settings({ study: { participantTitleTranslations: { fi: "Puhetutkimus" } } });
    apiFetch.mockResolvedValue(stored);
    render(<StudySections settings={stored} onSaved={async () => undefined} />);
    const finnish = screen.getByLabelText("Participant-facing title, Finnish (fi)");
    expect(finnish).toHaveValue("Puhetutkimus");
    fireEvent.change(finnish, { target: { value: "Puhe- ja käännöstutkimus" } });
    fireEvent.click(screen.getAllByRole("button", { name: /save/i })[0]!);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledWith("/api/admin/settings", {
      method: "PUT",
      body: {
        studyName: "Dialect-Aware Speech Translation Study",
        participantTitle: "Speech and translation study",
        participantTitleTranslations: { fi: "Puhe- ja käännöstutkimus" },
      },
    });
  });

  it("shows the wording note of a title that names the research focus, without blocking", () => {
    const warning = 'The participant-facing title mentions dialect before the speech tasks (found "dialect", spec 6.4).';
    render(
      <StudySections
        settings={settings({ study: { participantTitle: "Dialect study", participantTitleWarnings: [warning] } })}
        onSaved={async () => undefined}
      />,
    );
    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(screen.getByText("Wording note (does not block saving)")).toBeInTheDocument();
  });

  it("saves the languages and offers only the interface languages", async () => {
    const stored = settings({ languages: { sourceLanguage: null, targetLanguage: null } });
    apiFetch.mockResolvedValue(stored);
    render(<StudySections settings={stored} onSaved={async () => undefined} />);
    expect(screen.getByText(/A translation batch cannot be created until both\s+are set/)).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Source language"), { target: { value: "fi" } });
    fireEvent.change(screen.getByLabelText("Target language"), { target: { value: "en" } });
    fireEvent.click(screen.getByLabelText("English (en)"));
    fireEvent.click(screen.getAllByRole("button", { name: /save/i })[1]!);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledWith("/api/admin/settings", {
      method: "PUT",
      body: { sourceLanguage: "fi", targetLanguage: "en", participantLocales: ["fi"], defaultLocale: "fi" },
    });
  });
});

describe("ExampleTextNotice", () => {
  it("shows the status and the texts to replace, and nothing when there is no example text", () => {
    const message =
      "The current protocol still contains example text; research sessions are disabled until it is replaced.";
    const { rerender } = render(
      <ExampleTextNotice
        exampleText={{ present: true, protocolVersionNumber: 1, fields: ["The welcome text"], message }}
      />,
    );
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByText("The welcome text")).toBeInTheDocument();
    rerender(<ExampleTextNotice exampleText={{ present: false, protocolVersionNumber: 1, fields: [], message: null }} />);
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });
});
