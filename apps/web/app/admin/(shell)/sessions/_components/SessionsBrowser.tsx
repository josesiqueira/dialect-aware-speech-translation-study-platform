"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import type { corpusSchemas } from "@dialect/domain";
import { Card, EmptyState, ErrorState, LoadingState, PageHeading } from "@/components/ui";
import { useApiResource } from "../../_components/useApiResource";
import { SessionDetail } from "./SessionDetail";
import { FILTER_KEYS, SessionFilterBar, type FilterKey } from "./SessionFilterBar";
import { SessionList } from "./SessionList";

const LIST_KEYS = [...FILTER_KEYS, "page", "sort", "direction"] as const;

/**
 * The reference Conversations interaction: filters on top, the list on the
 * left (about 40 percent) and the detail of the selected session on the right.
 * The URL is the state: filters, sort, page and the selected session.
 */
export function SessionsBrowser() {
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("session");
  // Remounts the search box when the filters are cleared.
  const [clearCount, setClearCount] = useState(0);

  const update = useCallback(
    (changes: Record<string, string | null>, history: "push" | "replace" = "replace") => {
      const next = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      const url = query ? `?${query}` : window.location.pathname;
      if (query === window.location.search.replace(/^\?/, "")) return;
      // Next.js keeps useSearchParams in step with the native history calls.
      if (history === "push") window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    },
    [],
  );

  const listQuery = useMemo(() => {
    const query = new URLSearchParams();
    for (const key of LIST_KEYS) {
      const value = searchParams.get(key);
      if (value) query.set(key, value);
    }
    return query.toString();
  }, [searchParams]);

  const list = useApiResource<corpusSchemas.SessionListResult>(`/api/admin/sessions${listQuery ? `?${listQuery}` : ""}`);
  const detail = useApiResource<corpusSchemas.SessionDetail>(selectedId ? `/api/admin/sessions/${selectedId}` : null);
  const reloadList = list.reload;
  const reloadDetail = detail.reload;

  const filters = useMemo(
    () => Object.fromEntries(FILTER_KEYS.map((key) => [key, searchParams.get(key) ?? ""])) as Record<FilterKey, string>,
    [searchParams],
  );

  const onChanged = useCallback(async () => {
    await Promise.all([reloadDetail(), reloadList()]);
  }, [reloadDetail, reloadList]);

  return (
    <div className="space-y-4">
      <PageHeading title="Sessions" description="Browse participant sessions and inspect what happened to each utterance." />

      <SessionFilterBar
        key={clearCount}
        filters={filters}
        protocolVersions={list.data?.protocolVersions ?? []}
        onChange={(key, value) => update({ [key]: value, page: null })}
        onClear={() => {
          update(Object.fromEntries([...FILTER_KEYS, "page"].map((key) => [key, null])));
          setClearCount((count) => count + 1);
        }}
      />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[2fr_3fr]">
        <Card padding="none" className="relative max-h-[calc(100vh-13rem)] overflow-y-auto" aria-busy={list.loading}>
          {list.data ? (
            <SessionList
              result={list.data}
              selectedId={selectedId}
              loading={list.loading}
              error={list.error}
              onSelect={(id) => update({ session: id }, "push")}
              onSort={(sort, direction) => update({ sort, direction, page: null })}
              onPageChange={(page) => update({ page: page > 1 ? String(page) : null })}
            />
          ) : list.error ? (
            <ErrorState message={list.error} onRetry={() => void reloadList()} />
          ) : (
            <LoadingState size="sm" />
          )}
        </Card>

        <Card padding="sm" className="relative max-h-[calc(100vh-13rem)] min-w-0 overflow-y-auto" aria-busy={detail.loading}>
          {!selectedId ? (
            <EmptyState title="Select a session from the list." />
          ) : detail.data && detail.data.session.id === selectedId ? (
            <SessionDetail key={selectedId} detail={detail.data} onChanged={onChanged} refreshError={detail.error} />
          ) : detail.error ? (
            <ErrorState message={detail.error} onRetry={() => void reloadDetail()} />
          ) : (
            <LoadingState size="sm" />
          )}
        </Card>
      </div>
    </div>
  );
}
