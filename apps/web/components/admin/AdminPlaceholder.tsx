import { Card, EmptyState, PageHeading } from "@/components/ui";

/**
 * Temporary content for an admin page that is not built yet. Each page under
 * app/admin/(shell)/ uses it until its owner replaces the file.
 */
export function AdminPlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-6">
      <PageHeading title={title} description={description} />
      <Card padding="none">
        <EmptyState
          title="This page is being built."
          description="The navigation and layout are in place. The content arrives in the next development wave."
        />
      </Card>
    </div>
  );
}
