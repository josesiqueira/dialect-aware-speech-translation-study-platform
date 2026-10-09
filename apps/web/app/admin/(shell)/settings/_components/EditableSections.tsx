"use client";

import { useState } from "react";
import type { corpusSchemas } from "@dialect/domain";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  FormField,
  SaveButton,
  Select,
  TextArea,
  TextInput,
  useUnsavedChangesGuard,
  type SaveStatus,
} from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { errorMessage } from "../../_components/useApiResource";

type Settings = corpusSchemas.SettingsView;
type Update = corpusSchemas.SettingsUpdate;

type SectionState = { saving: boolean; status: SaveStatus; message?: string };
const IDLE: SectionState = { saving: false, status: "idle" };

export function useSection(onSaved: () => Promise<void>) {
  const [state, setState] = useState<SectionState>(IDLE);
  // Returns the stored settings after a successful save, null after a failure.
  async function save(changes: Update): Promise<Settings | null> {
    setState({ saving: true, status: "idle" });
    try {
      const saved = await apiFetch<Settings>("/api/admin/settings", { method: "PUT", body: changes });
      await onSaved();
      setState({ saving: false, status: "saved" });
      return saved;
    } catch (error) {
      setState({ saving: false, status: "error", message: errorMessage(error) });
      return null;
    }
  }
  return { state, save, reset: () => setState(IDLE) };
}

function operationalOf(settings: Settings) {
  return { ...settings.operational, maintenanceMessage: settings.operational.maintenanceMessage ?? "" };
}

function limitsOf(settings: Settings) {
  return {
    maxUploadMb: String(settings.limits.maxUploadMb),
    maxUtteranceSeconds: String(settings.limits.maxUtteranceSeconds),
    sessionInactivityTimeoutMinutes: String(settings.limits.sessionInactivityTimeoutMinutes),
    demoDailyRunLimit: String(settings.limits.demoDailyRunLimit),
  };
}

function optionsOf(settings: Settings) {
  return {
    ...settings.flags,
    adminTimezone: settings.adminTimezone,
    transcriptionConventionVersion: settings.conventions.transcriptionConventionVersion ?? "",
    annotationSchemeVersion: settings.conventions.annotationSchemeVersion ?? "",
  };
}

export function numberValue(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text);
}

export function Actions({
  dirty,
  section,
  onCancel,
  onSave,
}: {
  dirty: boolean;
  section: ReturnType<typeof useSection>;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <>
      {dirty && !section.state.saving && (
        <Button size="sm" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      )}
      <SaveButton
        size="sm"
        isLoading={section.state.saving}
        onClick={onSave}
        disabled={!dirty}
        status={dirty && section.state.status === "saved" ? "idle" : section.state.status}
        statusMessage={section.state.message}
      />
    </>
  );
}

/**
 * The three editable cards. Each card saves only its own fields. After a save
 * the form takes the values the server stored.
 */
export function EditableSections({ settings, onSaved }: { settings: Settings; onSaved: () => Promise<void> }) {
  const [operational, setOperational] = useState(() => operationalOf(settings));
  const [limits, setLimits] = useState(() => limitsOf(settings));
  const [options, setOptions] = useState(() => optionsOf(settings));

  const operationalSection = useSection(onSaved);
  const limitsSection = useSection(onSaved);
  const optionsSection = useSection(onSaved);

  const storedOperational = operationalOf(settings);
  const storedLimits = limitsOf(settings);
  const storedOptions = optionsOf(settings);
  const operationalDirty = JSON.stringify(operational) !== JSON.stringify(storedOperational);
  const limitsDirty = JSON.stringify(limits) !== JSON.stringify(storedLimits);
  const optionsDirty = JSON.stringify(options) !== JSON.stringify(storedOptions);
  useUnsavedChangesGuard(operationalDirty || limitsDirty || optionsDirty);

  const accepting = operational.status === "active" && operational.allowNewSessions && !operational.maintenanceMode;

  return (
    <>
      <Card padding="none" as="section">
        <CardHeader
          title="Study operational state"
          description={
            accepting
              ? "New participants can start a session."
              : "New participants cannot start a session with these values."
          }
          actions={
            <Actions
              dirty={operationalDirty}
              section={operationalSection}
              onCancel={() => {
                setOperational(storedOperational);
                operationalSection.reset();
              }}
              onSave={() =>
                void operationalSection
                  .save({
                    status: operational.status,
                    allowNewSessions: operational.allowNewSessions,
                    maintenanceMode: operational.maintenanceMode,
                    maintenanceMessage: operational.maintenanceMessage.trim() === "" ? null : operational.maintenanceMessage,
                  })
                  .then((saved) => saved && setOperational(operationalOf(saved)))
              }
            />
          }
        />
        <CardBody className="space-y-4">
          <FormField label="Study status" help="Paused and closed studies accept no new participants.">
            <Select
              value={operational.status}
              onChange={(event) =>
                setOperational({ ...operational, status: event.target.value as Settings["operational"]["status"] })
              }
              options={[
                { value: "active", label: "Active" },
                { value: "paused", label: "Paused" },
                { value: "closed", label: "Closed" },
              ]}
              className="max-w-xs"
            />
          </FormField>
          <Checkbox
            label="Allow new sessions"
            description="When this is off, the welcome page says that the study is not currently accepting new participants. Sessions in progress can finish."
            checked={operational.allowNewSessions}
            onChange={(event) => setOperational({ ...operational, allowNewSessions: event.target.checked })}
          />
          <Checkbox
            label="Maintenance mode"
            description="Closes the participant pages for everyone, including sessions in progress. Use it only for planned maintenance."
            checked={operational.maintenanceMode}
            onChange={(event) => setOperational({ ...operational, maintenanceMode: event.target.checked })}
          />
          <FormField label="Maintenance message" help="Shown to participants while maintenance mode is on. Leave empty for the standard text.">
            <TextArea
              rows={2}
              maxLength={1000}
              value={operational.maintenanceMessage}
              onChange={(event) => setOperational({ ...operational, maintenanceMessage: event.target.value })}
            />
          </FormField>
        </CardBody>
      </Card>

      <Card padding="none" as="section">
        <CardHeader
          title="Limits"
          description="Applied to new uploads. A session without activity for longer than the timeout counts as abandoned."
          actions={
            <Actions
              dirty={limitsDirty}
              section={limitsSection}
              onCancel={() => {
                setLimits(storedLimits);
                limitsSection.reset();
              }}
              onSave={() =>
                void limitsSection
                  .save({
                    maxUploadMb: numberValue(limits.maxUploadMb),
                    maxUtteranceSeconds: numberValue(limits.maxUtteranceSeconds),
                    sessionInactivityTimeoutMinutes: numberValue(limits.sessionInactivityTimeoutMinutes),
                    demoDailyRunLimit: numberValue(limits.demoDailyRunLimit),
                  })
                  .then((saved) => saved && setLimits(limitsOf(saved)))
              }
            />
          }
        />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Maximum upload size" help="Megabytes, 1 to 2000.">
            <TextInput
              type="number"
              min={1}
              max={2000}
              className="tabular-nums"
              value={limits.maxUploadMb}
              onChange={(event) => setLimits({ ...limits, maxUploadMb: event.target.value })}
            />
          </FormField>
          <FormField label="Maximum utterance duration" help="Seconds, 5 to 3600.">
            <TextInput
              type="number"
              min={5}
              max={3600}
              className="tabular-nums"
              value={limits.maxUtteranceSeconds}
              onChange={(event) => setLimits({ ...limits, maxUtteranceSeconds: event.target.value })}
            />
          </FormField>
          <FormField label="Session inactivity timeout" help="Minutes, 5 to 10080.">
            <TextInput
              type="number"
              min={5}
              max={10080}
              className="tabular-nums"
              value={limits.sessionInactivityTimeoutMinutes}
              onChange={(event) => setLimits({ ...limits, sessionInactivityTimeoutMinutes: event.target.value })}
            />
          </FormField>
          <FormField label="Demo Mode runs per day" help="Largest number of Demo Mode pipeline runs per day, 1 to 100000.">
            <TextInput
              type="number"
              min={1}
              max={100000}
              className="tabular-nums"
              value={limits.demoDailyRunLimit}
              onChange={(event) => setLimits({ ...limits, demoDailyRunLimit: event.target.value })}
            />
          </FormField>
        </CardBody>
      </Card>

      <Card padding="none" as="section">
        <CardHeader
          title="Collection and display options"
          description="The admin time zone is used for every time shown in the admin."
          actions={
            <Actions
              dirty={optionsDirty}
              section={optionsSection}
              onCancel={() => {
                setOptions(storedOptions);
                optionsSection.reset();
              }}
              onSave={() =>
                void optionsSection
                  .save({
                  studyLaptopMode: options.studyLaptopMode,
                  autoQueueAsr: options.autoQueueAsr,
                  demoPersist: options.demoPersist,
                  demoPublic: options.demoPublic,
                  adminTimezone: options.adminTimezone,
                  ...(options.transcriptionConventionVersion.trim()
                    ? { transcriptionConventionVersion: options.transcriptionConventionVersion }
                    : {}),
                  ...(options.annotationSchemeVersion.trim()
                    ? { annotationSchemeVersion: options.annotationSchemeVersion }
                    : {}),
                  })
                  .then((saved) => saved && setOptions(optionsOf(saved)))
              }
            />
          }
        />
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Checkbox
              label="Study laptop mode"
              description='The completion page offers "Start next participant".'
              checked={options.studyLaptopMode}
              onChange={(event) => setOptions({ ...options, studyLaptopMode: event.target.checked })}
            />
            <Checkbox
              label="Queue ASR after each upload"
              description="A transcription job is queued when a research or test recording is submitted and the participant accepted external AI processing. Demo recordings are not queued."
              checked={options.autoQueueAsr}
              onChange={(event) => setOptions({ ...options, autoQueueAsr: event.target.checked })}
            />
            <Checkbox
              label="Keep Demo Mode recordings"
              description="When off, demo recordings are processed and not kept."
              checked={options.demoPersist}
              onChange={(event) => setOptions({ ...options, demoPersist: event.target.checked })}
            />
            <Checkbox
              label="Demo Mode open without sign-in"
              description="When off, only a signed-in researcher can open Demo Mode."
              checked={options.demoPublic}
              onChange={(event) => setOptions({ ...options, demoPublic: event.target.checked })}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField label="Admin time zone" help="IANA name such as Europe/Helsinki.">
              <TextInput
                mono
                value={options.adminTimezone}
                onChange={(event) => setOptions({ ...options, adminTimezone: event.target.value })}
              />
            </FormField>
            <FormField label="Transcription convention" help="Version stored with new revisions.">
              <TextInput
                mono
                value={options.transcriptionConventionVersion}
                onChange={(event) => setOptions({ ...options, transcriptionConventionVersion: event.target.value })}
              />
            </FormField>
            <FormField label="Annotation scheme" help="Version stored with new annotations.">
              <TextInput
                mono
                value={options.annotationSchemeVersion}
                onChange={(event) => setOptions({ ...options, annotationSchemeVersion: event.target.value })}
              />
            </FormField>
          </div>
        </CardBody>
      </Card>
    </>
  );
}
