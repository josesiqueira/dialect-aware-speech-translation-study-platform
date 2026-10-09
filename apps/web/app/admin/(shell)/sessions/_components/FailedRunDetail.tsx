import type { corpusSchemas } from "@dialect/domain";

type Row = { label: string; value: string; mono?: boolean; pre?: boolean };

function rowsOf(run: corpusSchemas.ModelRunSummary): Row[] {
  const failure = run.failure;
  const rows: Row[] = [];
  if (failure?.providerStatus !== null && failure?.providerStatus !== undefined) {
    rows.push({ label: "Provider status", value: String(failure.providerStatus), mono: true });
  }
  if (failure?.providerErrorCode) rows.push({ label: "Provider error code", value: failure.providerErrorCode, mono: true });
  if (failure?.responseStatus) rows.push({ label: "Response status", value: failure.responseStatus, mono: true });
  if (run.providerRequestId) rows.push({ label: "Request id", value: run.providerRequestId, mono: true });
  if (failure?.responseId) rows.push({ label: "Response id", value: failure.responseId, mono: true });
  if (failure && failure.retryable !== null) {
    rows.push({ label: "Retried automatically", value: failure.retryable ? "yes, while attempts remain" : "no" });
  }
  if (failure?.refusal) rows.push({ label: "Refusal", value: failure.refusal, pre: true });
  if (failure && failure.outputText !== null) {
    rows.push({
      label: "Output text (not stored as a translation)",
      value: failure.outputText === "" ? "(empty)" : failure.outputText,
      pre: failure.outputText !== "",
    });
  }
  if (Object.keys(run.parameters).length > 0) {
    rows.push({ label: "Parameters sent", value: JSON.stringify(run.parameters, null, 2), mono: true, pre: true });
  }
  return rows;
}

/**
 * What a failed model run kept (spec 146): the error, the provider's answer and
 * the parameters of the request. A refused, cut-off or empty translation is
 * shown here with its exact text, because it is not stored as a translation.
 */
export function FailedRunDetail({ run }: { run: corpusSchemas.ModelRunSummary }) {
  if (run.status !== "failed") return null;
  const rows = rowsOf(run);
  return (
    <div className="mt-0.5 w-64 text-xs" data-testid="failed-run-detail">
      <p className="text-rose-700">
        {run.errorCode}
        {run.errorMessage ? `: ${run.errorMessage}` : ""}
      </p>
      {rows.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-slate-600 hover:text-slate-900">Provider response and request</summary>
          <dl className="mt-1 space-y-1">
            {rows.map((row) => (
              <div key={row.label}>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{row.label}</dt>
                <dd
                  className={[
                    "break-words text-slate-800",
                    row.mono ? "font-mono text-[11px]" : "",
                    row.pre ? "whitespace-pre-wrap" : "",
                  ].join(" ")}
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}
