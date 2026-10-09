import type { demoSchemas } from "@dialect/domain";
import { Badge, CopyableId, tableClasses } from "@/components/ui";
import { formatDateTime } from "@/lib/format";

function latency(ms: number | null): string {
  if (ms === null) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The five rows of spec 52, each PASS or FAIL, with latency, model and the failure message. */
export function PipelineTestResult({
  result,
  timeZone,
}: {
  result: demoSchemas.PipelineTestResult;
  timeZone: string;
}) {
  return (
    <div className="space-y-3" data-testid="pipeline-test-result" data-passed={result.passed ? "true" : "false"}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <h3 className="font-semibold text-slate-900">Last test</h3>
        <span className="text-slate-600 tabular-nums">{formatDateTime(result.ranAt, timeZone, { seconds: true, zone: true })}</span>
        <Badge variant={result.passed ? "status" : "error"}>{result.passed ? "All rows passed" : "At least one row failed"}</Badge>
        <Badge variant="test">Test</Badge>
        {result.isMock && <Badge variant="warning">Mock provider, not real model output</Badge>}
      </div>

      <div className={tableClasses.wrapper}>
        <table className={tableClasses.table}>
          <caption className="sr-only">Result of the pipeline test, one row per step</caption>
          <thead className={tableClasses.thead}>
            <tr>
              <th scope="col" className={tableClasses.th}>Step</th>
              <th scope="col" className={tableClasses.th}>Result</th>
              <th scope="col" className={`${tableClasses.th} text-right`}>Latency</th>
              <th scope="col" className={tableClasses.th}>Model</th>
              <th scope="col" className={tableClasses.th}>Message</th>
            </tr>
          </thead>
          <tbody className={tableClasses.tbody}>
            {result.rows.map((row) => (
              <tr key={row.key} data-row={row.key} data-result={row.result}>
                <th scope="row" className={`${tableClasses.td} font-medium whitespace-nowrap text-slate-900`}>
                  {row.label}
                </th>
                <td className={tableClasses.td}>
                  <Badge variant={row.result === "PASS" ? "status" : "error"}>{row.result}</Badge>
                </td>
                <td className={`${tableClasses.tdNumeric} whitespace-nowrap`}>{latency(row.latencyMs)}</td>
                <td className={`${tableClasses.td} font-mono text-xs break-all`}>{row.model ?? ""}</td>
                <td className={`${tableClasses.td} min-w-[14rem]`}>{row.message ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="grid gap-x-6 gap-y-1 text-xs text-slate-600 sm:grid-cols-2">
        <div className="flex flex-wrap items-center gap-2">
          <dt>Test session</dt>
          <dd className="flex items-center gap-2">
            <span className="font-mono text-slate-900">{result.participantCode}</span>
            <CopyableId value={result.sessionId} label="Session id" />
          </dd>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <dt>Test audio</dt>
          <dd className="text-slate-900">{result.source === "generated_tone" ? "Generated test tone" : "Recorded clip"}</dd>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <dt>Configurations</dt>
          <dd className="text-slate-900">{result.providerMode === "mock" ? "Mock provider" : "Active configurations"}</dd>
        </div>
        {result.transcriptExcerpt !== null && (
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <dt>ASR text</dt>
            <dd className="min-w-0 break-words text-slate-900">
              {result.transcriptExcerpt.trim() === "" ? "(empty)" : result.transcriptExcerpt}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
