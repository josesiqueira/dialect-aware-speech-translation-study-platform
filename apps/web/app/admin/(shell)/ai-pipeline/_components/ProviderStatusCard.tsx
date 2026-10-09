import { Badge, Card, CardBody, CardHeader } from "@/components/ui";
import type { ProviderStatus } from "./types";

/** Which AI providers this server offers. Shows only yes or no for the API key, never the key. */
export function ProviderStatusCard({ providers }: { providers: ProviderStatus[] }) {
  const openai = providers.find((provider) => provider.name === "openai");
  return (
    <Card padding="none" as="section" aria-labelledby="providers-heading">
      <CardHeader
        title={<span id="providers-heading">Providers on this server</span>}
        meta={
          openai?.configured ? (
            <Badge variant="status">OpenAI API key configured</Badge>
          ) : (
            <Badge variant="warning">No OpenAI API key</Badge>
          )
        }
        description="The API key is read from the server environment and is never shown or sent to the browser."
      />
      <CardBody className="space-y-3">
        {!openai?.configured && (
          <p className="text-sm text-slate-700">
            No OpenAI API key is configured on the server. Recording collection works without it. Processing with the{" "}
            <span className="font-mono">openai</span> provider fails with a clear error until the key is set in the server
            environment (the variable is listed in <span className="font-mono">.env.example</span>).
          </p>
        )}
        <ul className="divide-y divide-slate-100 text-sm">
          {providers.map((provider) => (
            <li key={provider.name} className="flex flex-wrap items-center gap-3 py-2 first:pt-0 last:pb-0">
              <span className="font-mono text-slate-900">{provider.name}</span>
              {provider.isMock ? (
                <>
                  <Badge variant="test">Mock</Badge>
                  <span className="text-slate-600">
                    Not a real model. It returns generated placeholder text and a test tone and never calls an external
                    service. Use it for development and tests only.
                  </span>
                </>
              ) : provider.configured ? (
                <Badge variant="status">Available</Badge>
              ) : (
                <Badge variant="warning">Not configured</Badge>
              )}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
