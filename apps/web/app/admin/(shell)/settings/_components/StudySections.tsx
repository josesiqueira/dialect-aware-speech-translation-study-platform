"use client";

import { useState } from "react";
import type { corpusSchemas } from "@dialect/domain";
import {
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  FormField,
  InlineMessage,
  Select,
  TextInput,
  useUnsavedChangesGuard,
} from "@/components/ui";
import { Actions, useSection } from "./EditableSections";

type Settings = corpusSchemas.SettingsView;

const LANGUAGE_NAMES: Record<string, string> = { en: "English", fi: "Finnish" };
const languageName = (code: string) => (LANGUAGE_NAMES[code] ? `${LANGUAGE_NAMES[code]} (${code})` : code);

function namesOf(settings: Settings) {
  return {
    studyName: settings.study.name,
    participantTitle: settings.study.participantTitle ?? "",
    // The title in the other languages offered to participants.
    participantTitleTranslations: settings.study.participantTitleTranslations ?? {},
  };
}

/** The participant languages that get their own title field: all but English, the base language. */
function titleLocales(settings: Settings): string[] {
  return settings.languages.participantLocales.filter((locale) => locale !== "en");
}

function languagesOf(settings: Settings) {
  return {
    sourceLanguage: settings.languages.sourceLanguage ?? "",
    targetLanguage: settings.languages.targetLanguage ?? "",
    participantLocales: settings.languages.participantLocales,
    defaultLocale: settings.languages.defaultLocale ?? "",
  };
}

/**
 * The message shown on Settings and on the Dashboard while the current
 * protocol still contains example text from the development seed.
 */
export function ExampleTextNotice({ exampleText }: { exampleText: Settings["exampleText"] }) {
  if (!exampleText.present) return null;
  return (
    <InlineMessage variant="warning" announce="none" title="Example text in the current protocol">
      <p>{exampleText.message}</p>
      <p className="mt-1">
        Replace it in a new protocol version on the Study Flow page (and in the consent and questionnaire versions it
        selects), then publish that version.
      </p>
      {exampleText.fields.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {exampleText.fields.map((field) => (
            <li key={field}>{field}</li>
          ))}
        </ul>
      )}
    </InlineMessage>
  );
}

/**
 * Study names and languages. The internal name is for the researchers. The
 * participant-facing title is what participants read before they speak, so it
 * is checked for wording that names the research focus (spec 6.1, 6.4).
 */
export function StudySections({ settings, onSaved }: { settings: Settings; onSaved: () => Promise<void> }) {
  const [names, setNames] = useState(() => namesOf(settings));
  const [languages, setLanguages] = useState(() => languagesOf(settings));
  const namesSection = useSection(onSaved);
  const languagesSection = useSection(onSaved);

  const storedNames = namesOf(settings);
  const storedLanguages = languagesOf(settings);
  const namesDirty = JSON.stringify(names) !== JSON.stringify(storedNames);
  const languagesDirty = JSON.stringify(languages) !== JSON.stringify(storedLanguages);
  useUnsavedChangesGuard(namesDirty || languagesDirty);

  const { interfaceLocales } = settings.languages;
  const toggleLocale = (locale: string, checked: boolean) => {
    // Keeps the order of the interface languages, so the list is stable.
    const next = interfaceLocales.filter((code) =>
      code === locale ? checked : languages.participantLocales.includes(code),
    );
    setLanguages({ ...languages, participantLocales: next });
  };
  const languagesMissing = !settings.languages.sourceLanguage || !settings.languages.targetLanguage;

  return (
    <>
      <Card padding="none" as="section">
        <CardHeader
          title="Study name and participant title"
          description="Participants never see the internal name. They see the participant-facing title on the welcome page and in the browser tab."
          actions={
            <Actions
              dirty={namesDirty}
              section={namesSection}
              onCancel={() => {
                setNames(storedNames);
                namesSection.reset();
              }}
              onSave={() =>
                void namesSection
                  .save({
                    studyName: names.studyName,
                    participantTitle: names.participantTitle,
                    ...(titleLocales(settings).length > 0
                      ? { participantTitleTranslations: names.participantTitleTranslations }
                      : {}),
                  })
                  .then((saved) => saved && setNames(namesOf(saved)))
              }
            />
          }
        />
        <CardBody className="space-y-4">
          <FormField label="Internal study name" help="Shown in the admin and in exports only.">
            <TextInput
              maxLength={200}
              value={names.studyName}
              onChange={(event) => setNames({ ...names, studyName: event.target.value })}
            />
          </FormField>
          <FormField
            label="Participant-facing title"
            help={`Truthful, without the research focus or an expected result. Shown to participants now: "${settings.study.effectiveParticipantTitle}". When empty, the neutral standard title is used.`}
          >
            <TextInput
              maxLength={120}
              value={names.participantTitle}
              onChange={(event) => setNames({ ...names, participantTitle: event.target.value })}
            />
          </FormField>
          {titleLocales(settings).map((locale) => (
            <FormField
              key={locale}
              label={`Participant-facing title, ${languageName(locale)}`}
              help="Shown to participants who choose this language. Empty: they see the title above."
            >
              <TextInput
                lang={locale}
                maxLength={120}
                value={names.participantTitleTranslations[locale] ?? ""}
                onChange={(event) =>
                  setNames({
                    ...names,
                    participantTitleTranslations: { ...names.participantTitleTranslations, [locale]: event.target.value },
                  })
                }
              />
            </FormField>
          ))}
          {settings.study.participantTitleWarnings.map((warning) => (
            <InlineMessage key={warning} variant="warning" announce="none" title="Wording note (does not block saving)">
              {warning}
            </InlineMessage>
          ))}
        </CardBody>
      </Card>

      <Card padding="none" as="section">
        <CardHeader
          title="Languages"
          description="The source and target language are stored with every translation batch. The interface languages are the ones participants can choose."
          actions={
            <Actions
              dirty={languagesDirty}
              section={languagesSection}
              onCancel={() => {
                setLanguages(storedLanguages);
                languagesSection.reset();
              }}
              onSave={() =>
                void languagesSection
                  .save({
                    sourceLanguage: languages.sourceLanguage,
                    targetLanguage: languages.targetLanguage,
                    participantLocales: languages.participantLocales as Array<"en" | "fi">,
                    ...(languages.defaultLocale ? { defaultLocale: languages.defaultLocale as "en" | "fi" } : {}),
                  })
                  .then((saved) => saved && setLanguages(languagesOf(saved)))
              }
            />
          }
        />
        <CardBody className="space-y-4">
          {languagesMissing && (
            <InlineMessage variant="warning" announce="none">
              The source language or the target language is not set. A translation batch cannot be created until both
              are set.
            </InlineMessage>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Source language" help='Language participants speak. A short tag such as "fi".'>
              <TextInput
                mono
                maxLength={20}
                value={languages.sourceLanguage}
                onChange={(event) => setLanguages({ ...languages, sourceLanguage: event.target.value })}
              />
            </FormField>
            <FormField label="Target language" help='Language of the translations. A short tag such as "en" or "en-GB".'>
              <TextInput
                mono
                maxLength={20}
                value={languages.targetLanguage}
                onChange={(event) => setLanguages({ ...languages, targetLanguage: event.target.value })}
              />
            </FormField>
          </div>
          <fieldset>
            <legend className="text-sm font-medium text-slate-700">Interface languages offered to participants</legend>
            <p className="text-xs text-slate-500">
              Only languages the participant interface exists in can be offered. The study texts themselves are written
              in one language on the Study Flow page.
            </p>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {interfaceLocales.map((locale) => (
                <Checkbox
                  key={locale}
                  label={languageName(locale)}
                  checked={languages.participantLocales.includes(locale)}
                  onChange={(event) => toggleLocale(locale, event.target.checked)}
                />
              ))}
            </div>
          </fieldset>
          <FormField label="Default interface language" help="Shown first. It must be one of the offered languages.">
            <Select
              value={languages.defaultLocale}
              onChange={(event) => setLanguages({ ...languages, defaultLocale: event.target.value })}
              options={[
                ...(languages.defaultLocale === "" ? [{ value: "", label: "Not set" }] : []),
                ...interfaceLocales.map((locale) => ({ value: locale, label: languageName(locale) })),
              ]}
              className="max-w-xs"
            />
          </FormField>
        </CardBody>
      </Card>
    </>
  );
}
