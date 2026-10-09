"use client";

import { useCallback, useEffect, useState } from "react";
import { demoSchemas } from "@dialect/domain";
import { recordingForm } from "@/app/demo/_components/demoApi";
import type { RecordingCandidate } from "@/components/participant/recorder";
import { Badge, Button, Card, CardBody, CardHeader, InlineMessage, RadioGroup } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import type { RecorderFallbackInfo } from "@/lib/client/recorder";
import { PipelineTestRecorder } from "./PipelineTestRecorder";
import { PipelineTestResult } from "./PipelineTestResult";

const TEST_URL = "/api/admin/ai/test";
// The server enforces the same limit.
const MAX_CLIP_SECONDS = demoSchemas.PIPELINE_TEST_MAX_RECORDING_SECONDS;

type Provider = demoSchemas.PipelineProviderMode;

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The pipeline test could not be run.";
}

/**
 * "Run pipeline test" (spec 52): a short end-to-end check of storage, ASR, both
 * translation conditions and TTS, with a recorded clip or a generated test
 * tone. Each step is shown as PASS or FAIL. Everything the test creates has
 * the mode `test` and is never part of a research export.
 *
 * The page renders <PipelineTestSlot /> without props as its last section.
 */
export function PipelineTestSlot() {
  const [provider, setProvider] = useState<Provider>("active");
  const [capture, setCapture] = useState<"pcm" | "compressed">("compressed");
  const [mockAvailable, setMockAvailable] = useState(false);
  const [timeZone, setTimeZone] = useState("UTC");
  const [result, setResult] = useState<demoSchemas.PipelineTestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<demoSchemas.LastPipelineTestResponse>(TEST_URL)
      .then((response) => {
        if (cancelled) return;
        setMockAvailable(response.mockAvailable);
        setTimeZone(response.timeZone);
        setResult(response.last);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(`The last test result could not be loaded: ${messageOf(caught)}`);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runWithTone = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const body: demoSchemas.PipelineTestBody = { source: "generated_tone", provider };
      const response = await apiFetch<demoSchemas.PipelineTestResponse>(TEST_URL, { method: "POST", body });
      setResult(response.result);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setRunning(false);
    }
  }, [provider]);

  const runWithClip = useCallback(
    async (candidate: RecordingCandidate, fallback: RecorderFallbackInfo | null) => {
      setRunning(true);
      setError(null);
      try {
        const form = recordingForm(candidate, fallback);
        form.append("options", JSON.stringify({ provider }));
        const response = await apiFetch<demoSchemas.PipelineTestResponse>(TEST_URL, { method: "POST", body: form });
        setResult(response.result);
      } catch (caught) {
        setError(messageOf(caught));
        throw caught;
      } finally {
        setRunning(false);
      }
    },
    [provider],
  );

  return (
    <Card padding="none" as="section" aria-labelledby="pipeline-test-heading" data-testid="pipeline-test">
      <CardHeader
        title={<span id="pipeline-test-heading">Run pipeline test</span>}
        meta={<Badge variant="test">Test data</Badge>}
        description="A short end-to-end check of storage, ASR, both translation conditions and TTS with a test recording."
      />
      <CardBody className="space-y-5">
        <p className="text-sm text-slate-600">
          The test stores one short clip and runs it through the whole pipeline. Everything it creates has the mode
          TEST: a test session, a test batch and their outputs. Test data is never part of a research export unless a
          researcher explicitly includes it.
        </p>

        <div className="grid gap-5 md:grid-cols-2">
          <RadioGroup
            label="Configurations"
            value={provider}
            onChange={(value) => setProvider(value === "mock" ? "mock" : "active")}
            disabled={running}
            options={[
              {
                value: "active",
                label: "Active configurations",
                description: "Exactly the models and prompts a processing batch would use now.",
              },
              ...(mockAvailable
                ? [
                    {
                      value: "mock",
                      label: "Mock provider",
                      description:
                        "A check of storage, database and page only. No model is called, and the output is generated placeholder text and a test tone.",
                    },
                  ]
                : []),
            ]}
          />
          <RadioGroup
            label="Capture of a recorded clip"
            value={capture}
            onChange={(value) => setCapture(value === "pcm" ? "pcm" : "compressed")}
            disabled={running}
            options={[
              { value: "compressed", label: "Compressed", description: "The browser codec. Small upload." },
              { value: "pcm", label: "Lossless", description: "PCM WAV, the capture used in the study." },
            ]}
          />
        </div>

        <div className="space-y-4 rounded-lg border border-slate-200 p-4">
          {/* The key gives the recorder a fresh state when the capture choice changes. */}
          <PipelineTestRecorder
            key={capture}
            maxDurationMs={MAX_CLIP_SECONDS * 1000}
            prefer={capture}
            disabled={running}
            onRun={runWithClip}
          />
          <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
            <Button
              variant="secondary"
              onClick={() => void runWithTone()}
              disabled={running}
              loading={running}
              loadingLabel="Running the test..."
            >
              Use a generated test tone
            </Button>
            <span className="max-w-xl text-xs text-slate-500">
              For a machine without a microphone. The server generates a short sine tone. A real ASR model hears no
              speech in a tone, so its transcript is empty or meaningless, and the translation rows can then fail for
              that reason alone. Record a spoken clip to test the models themselves.
            </span>
          </div>
        </div>

        <p role="status" aria-live="polite" className="sr-only">
          {running ? "The pipeline test is running." : result && loaded ? `Pipeline test finished: ${result.passed ? "all rows passed" : "at least one row failed"}.` : ""}
        </p>

        {error && <InlineMessage variant="error">{error}</InlineMessage>}

        {result ? (
          <PipelineTestResult result={result} timeZone={timeZone} />
        ) : (
          loaded && !error && <p className="text-sm text-slate-600">No pipeline test has been run yet.</p>
        )}
      </CardBody>
    </Card>
  );
}
