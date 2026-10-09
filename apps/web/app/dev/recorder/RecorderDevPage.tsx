"use client";

/**
 * Development test page for the recorder. It runs the mic check and one
 * recording task exactly as the study does, but instead of uploading it shows
 * the technical facts of the candidate and offers it as a local download.
 * No request with audio leaves this page: "submit" only waits and resolves
 * (or rejects once when the failure toggle is set).
 */

import { useCallback, useRef, useState } from "react";
import { ParticipantCard, ParticipantHeading, ParticipantShell } from "@/components/participant";
import {
  MicCheck,
  RecordingTask,
  type MicCheckResult,
  type RecorderStatus,
  type RecordingCandidate,
  type SubmitContext,
} from "@/components/participant/recorder";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { focusRing, scrollRegionProps } from "@/components/ui/styles";
import { Checkbox } from "@/components/ui/Checkbox";
import type { RecorderFallbackInfo } from "@/lib/client/recorder";

const MAX_DURATION_MS = 30_000;
const MIN_DURATION_MS = 1_000;

interface SubmitLogEntry {
  attemptCount: number;
  url: string;
  sizeBytes: number;
  outcome: "failed" | "accepted";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileNameFor(candidate: RecordingCandidate): string {
  const extension = candidate.mimeType.includes("wav")
    ? "wav"
    : candidate.mimeType.includes("webm")
      ? "webm"
      : candidate.mimeType.includes("ogg")
        ? "ogg"
        : "m4a";
  return `recorder-test-attempt-${candidate.attempt}.${extension}`;
}

function Fact({ name, label, value }: { name: string; label: string; value: string }) {
  return (
    <div className="grid grid-cols-[12rem_1fr] gap-3">
      <dt className="font-medium text-slate-700">{label}</dt>
      <dd className="min-w-0 break-words font-mono text-slate-900" data-testid={`fact-${name}`}>
        {value}
      </dd>
    </div>
  );
}

export function RecorderDevPage() {
  const [micCheck, setMicCheck] = useState<MicCheckResult | null>(null);
  const [taskKey, setTaskKey] = useState(1);
  const [candidate, setCandidate] = useState<RecordingCandidate | null>(null);
  const [taskState, setTaskState] = useState<RecorderStatus>("idle");
  const [fallback, setFallback] = useState<RecorderFallbackInfo | null>(null);
  const [failOnce, setFailOnce] = useState(false);
  const [compressed, setCompressed] = useState(false);
  const [submitLog, setSubmitLog] = useState<SubmitLogEntry[]>([]);
  const failOnceRef = useRef(false);

  const handleSubmit = useCallback(async (current: RecordingCandidate, context: SubmitContext) => {
    // A stand-in for the upload: it reports progress and sends nothing.
    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      await wait(120);
      context.onProgress(fraction);
    }
    const entry = { attemptCount: context.attemptCount, url: current.url, sizeBytes: current.sizeBytes };
    if (failOnceRef.current) {
      failOnceRef.current = false;
      setFailOnce(false);
      setSubmitLog((log) => [...log, { ...entry, outcome: "failed" }]);
      throw new Error("Simulated upload failure");
    }
    setSubmitLog((log) => [...log, { ...entry, outcome: "accepted" }]);
  }, []);

  const newTask = () => {
    setTaskKey((key) => key + 1);
    setCandidate(null);
    setFallback(null);
    setSubmitLog([]);
  };

  return (
    <ParticipantShell width="2xl">
      <ParticipantHeading
        title="Recorder test page"
        description="Development only. Nothing recorded here is uploaded or stored."
      />

      <section aria-labelledby="mic-check-heading" className="mb-10 space-y-4">
        <h2 id="mic-check-heading" className="text-lg font-semibold text-slate-900">
          1. Microphone check
        </h2>
        {micCheck ? (
          <ParticipantCard className="space-y-3">
            <p className="text-sm text-slate-700">The mic check returned these technical settings (no audio):</p>
            <pre
              {...scrollRegionProps("Technical settings returned by the mic check")}
              className={cn("max-h-80 overflow-auto rounded-lg bg-slate-50 p-3 text-xs text-slate-800", focusRing)}
              data-testid="mic-check-result"
            >
              {JSON.stringify(micCheck, null, 2)}
            </pre>
            <Button variant="secondary" onClick={() => setMicCheck(null)}>
              Run the mic check again
            </Button>
          </ParticipantCard>
        ) : (
          <MicCheck onContinue={setMicCheck} prefer={compressed ? "compressed" : "pcm"} />
        )}
      </section>

      <section aria-labelledby="task-heading" className="space-y-4">
        <h2 id="task-heading" className="text-lg font-semibold text-slate-900">
          2. Recording task
        </h2>

        <ParticipantCard className="space-y-3">
          <Checkbox
            label="Simulate upload failure once"
            description="The next Submit fails, the recording is kept, and Retry succeeds."
            checked={failOnce}
            onChange={(event) => {
              failOnceRef.current = event.target.checked;
              setFailOnce(event.target.checked);
            }}
          />
          <Checkbox
            label="Use the compressed recorder (MediaRecorder)"
            description="As in Demo Mode. Applies to the next recording."
            checked={compressed}
            onChange={(event) => setCompressed(event.target.checked)}
          />
        </ParticipantCard>

        <RecordingTask
          key={taskKey}
          prompt={<p className="text-slate-900">Test prompt: describe what you can see from where you are sitting.</p>}
          maxDurationMs={MAX_DURATION_MS}
          minDurationMs={MIN_DURATION_MS}
          prefer={compressed ? "compressed" : "pcm"}
          onSubmit={handleSubmit}
          onCandidateChange={setCandidate}
          onStateChange={setTaskState}
          onFallback={setFallback}
        />

        <ParticipantCard className="space-y-3 text-sm">
          <h3 className="font-semibold text-slate-900">Technical facts of the candidate</h3>
          <p className="text-slate-700">
            Task state: <span className="font-mono" data-testid="fact-task-state">{taskState}</span>
          </p>
          {fallback && (
            <p className="text-slate-700" data-testid="fact-fallback">
              Fallback in use: {fallback.reason} ({fallback.detail})
            </p>
          )}
          {candidate ? (
            <>
              <dl className="space-y-1">
                <Fact name="attempt" label="Attempt" value={String(candidate.attempt)} />
                <Fact name="capture-method" label="Capture method" value={candidate.captureMethod} />
                <Fact name="quality-class" label="Quality class" value={candidate.captureQualityClass} />
                <Fact name="mime-type" label="MIME type" value={candidate.mimeType} />
                <Fact name="sample-rate" label="Sample rate (file)" value={String(candidate.sampleRateHz)} />
                <Fact name="context-rate" label="AudioContext rate" value={String(candidate.audioContextSampleRate)} />
                <Fact name="track-rate" label="Track rate" value={String(candidate.actualTrackSettings.sampleRate)} />
                <Fact name="channels" label="Channels" value={String(candidate.channels)} />
                <Fact name="input-channels" label="Input channels" value={String(candidate.inputChannelCount)} />
                <Fact name="bit-depth" label="Bit depth" value={String(candidate.bitDepth)} />
                <Fact name="duration-ms" label="Duration (ms)" value={candidate.durationMs.toFixed(1)} />
                <Fact name="size-bytes" label="Size (bytes)" value={String(candidate.sizeBytes)} />
                <Fact name="peak" label="Peak" value={candidate.peak === null ? "null" : candidate.peak.toFixed(4)} />
                <Fact name="clipped" label="Clipped samples" value={String(candidate.clippedSampleCount)} />
                <Fact name="stopped-by" label="Stopped by" value={candidate.stoppedBy} />
                <Fact name="device" label="Device label" value={candidate.deviceLabel ?? "(not exposed)"} />
                <Fact name="mismatches" label="Constraint mismatches" value={JSON.stringify(candidate.constraintMismatches)} />
                <Fact name="settings" label="Actual track settings" value={JSON.stringify(candidate.actualTrackSettings)} />
                <Fact name="requested" label="Requested constraints" value={JSON.stringify(candidate.requestedConstraints)} />
                <Fact name="blob-url" label="Blob URL" value={candidate.url} />
              </dl>
              <a
                href={candidate.url}
                download={fileNameFor(candidate)}
                className="inline-block font-medium text-slate-900 underline underline-offset-2"
                data-testid="download-candidate"
              >
                Download this recording for inspection
              </a>
            </>
          ) : (
            <p className="text-slate-500" data-testid="no-candidate">
              No candidate in memory.
            </p>
          )}
        </ParticipantCard>

        <ParticipantCard className="space-y-3 text-sm">
          <h3 className="font-semibold text-slate-900">Submit log (simulated, nothing is sent)</h3>
          {submitLog.length === 0 ? (
            <p className="text-slate-500">No submit yet.</p>
          ) : (
            <ol className="list-decimal space-y-1 pl-5 font-mono text-slate-800" data-testid="submit-log">
              {submitLog.map((entry, index) => (
                <li key={index} data-outcome={entry.outcome} data-url={entry.url} data-attempt={entry.attemptCount}>
                  {entry.outcome}: attempt {entry.attemptCount}, {entry.sizeBytes} bytes
                </li>
              ))}
            </ol>
          )}
          <Button variant="secondary" onClick={newTask}>
            Start a new task
          </Button>
        </ParticipantCard>
      </section>
    </ParticipantShell>
  );
}
