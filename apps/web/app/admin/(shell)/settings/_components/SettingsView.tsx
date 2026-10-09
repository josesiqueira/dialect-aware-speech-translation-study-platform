"use client";

import type { corpusSchemas } from "@dialect/domain";
import { Card, ErrorState, InlineMessage, LoadingState, PageHeading } from "@/components/ui";
import { useApiResource } from "../../_components/useApiResource";
import { DangerZone } from "./DangerZone";
import { EditableSections } from "./EditableSections";
import { OutputReviewSection } from "./OutputReviewSection";
import { StatusSections } from "./StatusSections";
import { ExampleTextNotice, StudySections } from "./StudySections";

/**
 * Settings: stacked white bordered cards, as on the reference Settings page.
 * The editable cards come first, then the read-only technical status, and the
 * destructive action sits apart at the end.
 */
export function SettingsView() {
  const resource = useApiResource<corpusSchemas.SettingsView>("/api/admin/settings");
  const settings = resource.data;

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeading
        title="Settings"
        description="Operational state of the study, limits and technical status. Study content is edited on its own pages."
      />
      {!settings ? (
        resource.error ? (
          <Card padding="sm">
            <ErrorState message={resource.error} onRetry={() => void resource.reload()} />
          </Card>
        ) : (
          <LoadingState />
        )
      ) : (
        <>
          {resource.error && <InlineMessage variant="error">The settings could not be refreshed: {resource.error}</InlineMessage>}
          <ExampleTextNotice exampleText={settings.exampleText} />
          <StudySections settings={settings} onSaved={resource.reload} />
          <EditableSections settings={settings} onSaved={resource.reload} />
          <OutputReviewSection settings={settings} onSaved={resource.reload} />
          <StatusSections settings={settings} onChanged={resource.reload} />
          <DangerZone settings={settings} onChanged={resource.reload} />
        </>
      )}
    </div>
  );
}
