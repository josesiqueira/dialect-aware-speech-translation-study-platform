"use client";

import { useEffect, useState } from "react";
import {
  ClearFiltersButton,
  FilterBar,
  FilterDateInput,
  FilterSearch,
  FilterSelect,
} from "@/components/ui";

export const FILTER_KEYS = [
  "search",
  "mode",
  "completion",
  "review",
  "flagged",
  "hasProcessingErrors",
  "excluded",
  "protocolVersionId",
  "dateFrom",
  "dateTo",
] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

const SEARCH_DELAY_MS = 300;

export interface SessionFilterBarProps {
  filters: Record<FilterKey, string>;
  protocolVersions: Array<{ id: string; versionNumber: number; name: string }>;
  onChange: (key: FilterKey, value: string) => void;
  onClear: () => void;
}

/** Compact native filters above the list (the reference FilterBar). Every filter is applied on the server. */
export function SessionFilterBar({ filters, protocolVersions, onChange, onClear }: SessionFilterBarProps) {
  const [search, setSearch] = useState(filters.search);

  // The search is sent after a short pause in typing, not on every key.
  useEffect(() => {
    if (search.trim() === filters.search) return;
    const id = setTimeout(() => onChange("search", search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(id);
    // onChange is a new function on every render of the parent; only the text matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const active = FILTER_KEYS.some((key) => filters[key] !== "") || search !== "";

  return (
    <FilterBar label="Session filters">
      <FilterSearch
        label="Search by participant code or session id"
        placeholder="Code or session id..."
        value={search}
        onChange={setSearch}
        className="w-52"
      />
      <FilterSelect
        label="Filter by mode"
        allLabel="All modes"
        value={filters.mode}
        onChange={(value) => onChange("mode", value)}
        options={[
          { value: "research", label: "Research" },
          { value: "demo", label: "Demo" },
          { value: "test", label: "Test" },
        ]}
      />
      <FilterSelect
        label="Filter by completion"
        allLabel="Any completion"
        value={filters.completion}
        onChange={(value) => onChange("completion", value)}
        options={[
          { value: "completed", label: "Completed" },
          { value: "incomplete", label: "Incomplete" },
        ]}
      />
      <FilterSelect
        label="Filter by review state"
        allLabel="Any review state"
        value={filters.review}
        onChange={(value) => onChange("review", value)}
        options={[
          { value: "complete", label: "Review complete" },
          { value: "incomplete", label: "Review incomplete" },
        ]}
      />
      <FilterSelect
        label="Filter by flag"
        allLabel="Flagged or not"
        value={filters.flagged}
        onChange={(value) => onChange("flagged", value)}
        options={[
          { value: "true", label: "Flagged" },
          { value: "false", label: "Not flagged" },
        ]}
      />
      <FilterSelect
        label="Filter by processing errors"
        allLabel="Any processing state"
        value={filters.hasProcessingErrors}
        onChange={(value) => onChange("hasProcessingErrors", value)}
        options={[
          { value: "true", label: "Has processing errors" },
          { value: "false", label: "No processing errors" },
        ]}
      />
      <FilterSelect
        label="Filter by exclusion"
        allLabel="Excluded or not"
        value={filters.excluded}
        onChange={(value) => onChange("excluded", value)}
        options={[
          { value: "true", label: "Excluded" },
          { value: "false", label: "Not excluded" },
        ]}
      />
      <FilterSelect
        label="Filter by protocol version"
        allLabel="All protocols"
        value={filters.protocolVersionId}
        onChange={(value) => onChange("protocolVersionId", value)}
        options={protocolVersions.map((version) => ({
          value: version.id,
          label: `Protocol v${version.versionNumber}`,
        }))}
      />
      <FilterDateInput label="From" value={filters.dateFrom} onChange={(value) => onChange("dateFrom", value)} />
      <FilterDateInput label="To" value={filters.dateTo} onChange={(value) => onChange("dateTo", value)} />
      {active && <ClearFiltersButton onClick={onClear} />}
    </FilterBar>
  );
}
