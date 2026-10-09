"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, ErrorState, LoadingState, PageHeading, Pagination, RefreshButton } from "@/components/ui";
import { errorMessage, fetchBatch, fetchBatches } from "./api";
import { BatchDetailCard } from "./BatchDetailCard";
import { BatchTable } from "./BatchTable";
import { CreateBatchWizard } from "./CreateBatchWizard";
import { isActiveStatus } from "./labels";
import type { BatchDetail, BatchList, BatchOptions } from "./types";

const AUTO_REFRESH_SECONDS = 5;

export function ProcessingClient({
  initialList,
  options,
  timeZone,
}: {
  initialList: BatchList;
  options: BatchOptions;
  timeZone: string;
}) {
  const [list, setList] = useState<BatchList>(initialList);
  const [selectedId, setSelectedId] = useState<string | null>(initialList.batches[0]?.id ?? null);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);

  // The newest request wins: a slow answer for an earlier selection is dropped.
  const requestRef = useRef(0);

  const load = useCallback(async (page: number, batchId: string | null) => {
    const request = (requestRef.current += 1);
    try {
      const [nextList, nextDetail] = await Promise.all([fetchBatches(page), batchId ? fetchBatch(batchId) : null]);
      if (request !== requestRef.current) return;
      setList(nextList);
      setDetail(nextDetail);
      setDetailError(null);
      setRefreshError(null);
      setLastUpdated(new Date());
    } catch (error) {
      if (request !== requestRef.current) return;
      setRefreshError(errorMessage(error));
    }
  }, []);

  // First load of the detail view, and the "last updated" time. It runs right
  // after the page is shown, from a timer callback.
  useEffect(() => {
    const id = setTimeout(() => void load(initialList.page, initialList.batches[0]?.id ?? null), 0);
    return () => clearTimeout(id);
  }, [load, initialList]);

  const hasActive =
    list.batches.some((batch) => isActiveStatus(batch.status)) || (detail !== null && isActiveStatus(detail.status));

  // Auto-refresh only while a batch is queued or running.
  useEffect(() => {
    if (!autoRefresh || !hasActive) return;
    const id = setInterval(() => void load(list.page, selectedId), AUTO_REFRESH_SECONDS * 1000);
    return () => clearInterval(id);
  }, [autoRefresh, hasActive, load, list.page, selectedId]);

  async function select(id: string) {
    setSelectedId(id);
    setDetailError(null);
    const request = (requestRef.current += 1);
    try {
      const next = await fetchBatch(id);
      if (request === requestRef.current) setDetail(next);
    } catch (error) {
      if (request === requestRef.current) {
        setDetail(null);
        setDetailError(errorMessage(error));
      }
    }
  }

  // After create, start, retry or cancel: show the batch and reload the list.
  function showBatch(batch: BatchDetail) {
    setSelectedId(batch.id);
    setDetail(batch);
    void load(1, batch.id);
  }

  return (
    <div className="space-y-6">
      <PageHeading
        title="Processing Runs"
        description="Run ASR, translation and TTS on a selection of utterances. Each batch keeps a frozen copy of its configuration."
        actions={
          !wizardOpen && (
            <Button size="sm" onClick={() => setWizardOpen(true)}>
              Create batch
            </Button>
          )
        }
      />

      {wizardOpen && <CreateBatchWizard options={options} onCreated={showBatch} onClose={() => setWizardOpen(false)} />}

      <section className="space-y-2" aria-label="Batches">
        <RefreshButton
          onRefresh={() => load(list.page, selectedId)}
          lastUpdated={lastUpdated}
          error={refreshError}
          isAutoRefreshing={autoRefresh}
          onToggleAutoRefresh={setAutoRefresh}
          autoRefreshSeconds={AUTO_REFRESH_SECONDS}
          className="justify-end"
        />
        <BatchTable batches={list.batches} selectedId={selectedId} timeZone={timeZone} onSelect={(id) => void select(id)} />
        {list.total > list.pageSize && (
          <Pagination
            page={list.page}
            pageSize={list.pageSize}
            total={list.total}
            itemLabel="batches"
            onPageChange={(page) => void load(page, selectedId)}
          />
        )}
        <p className="text-xs text-slate-500">
          Times are shown in {timeZone}. Auto-refresh runs only while a batch is queued or running.
        </p>
      </section>

      {detailError ? (
        <ErrorState title="The batch could not be loaded" message={detailError} onRetry={() => selectedId && void select(selectedId)} />
      ) : detail ? (
        <BatchDetailCard key={detail.id} batch={detail} timeZone={timeZone} onChanged={showBatch} />
      ) : selectedId ? (
        <Card padding="sm" aria-busy="true">
          <LoadingState label="Loading the batch..." size="sm" />
        </Card>
      ) : null}
    </div>
  );
}
