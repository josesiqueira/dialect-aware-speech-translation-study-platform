"use client";

import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { cn } from "./cn";
import type { SelectOption } from "./Select";
import { filterControl } from "./styles";

export interface FilterBarProps {
  /** Accessible name of the filter region, for example "Session filters". */
  label: string;
  children: ReactNode;
  className?: string;
}

/** Wrapping row of compact native filter controls above a list or table (reference FilterBar). */
export function FilterBar({ label, children, className }: FilterBarProps) {
  return (
    <div role="search" aria-label={label} className={cn("flex flex-wrap items-center gap-3", className)}>
      {children}
    </div>
  );
}

/** A filter that is not at its default value gets a blue tint, so active filters are visible at a glance. */
const activeFilter = "border-blue-300 bg-blue-50";

export interface FilterSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value"> {
  /** Accessible name, for example "Filter by mode". Not shown; the first option names the dimension. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Label of the first option with the empty value, for example "All modes". */
  allLabel: string;
  options: SelectOption[];
}

export function FilterSelect({
  label,
  value,
  onChange,
  allLabel,
  options,
  className,
  ...rest
}: FilterSelectProps) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(filterControl, "px-3", value !== "" && activeFilter, className)}
      {...rest}
    >
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export interface FilterDateInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> {
  /** Visible label before the input: "From", "To". */
  label: string;
  /** ISO date (YYYY-MM-DD) or the empty string. */
  value: string;
  onChange: (value: string) => void;
}

export function FilterDateInput({ label, value, onChange, className, ...rest }: FilterDateInputProps) {
  return (
    <label className="flex items-center gap-1.5 text-sm text-slate-600">
      <span>{label}</span>
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(filterControl, "px-2", value !== "" && activeFilter, className)}
        {...rest}
      />
    </label>
  );
}

export interface FilterSearchProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> {
  /** Accessible name, for example "Search sessions". */
  label: string;
  value: string;
  onChange: (value: string) => void;
}

export function FilterSearch({
  label,
  value,
  onChange,
  placeholder = "Search...",
  className,
  ...rest
}: FilterSearchProps) {
  return (
    <input
      type="search"
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className={cn(filterControl, "w-48 px-3", value !== "" && activeFilter, className)}
      {...rest}
    />
  );
}

export interface ClearFiltersButtonProps {
  onClick: () => void;
  /** Default "Clear filters". */
  label?: string;
  className?: string;
}

/** Text-only action. Render it only while at least one filter is active. */
export function ClearFiltersButton({ onClick, label = "Clear filters", className }: ClearFiltersButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded text-xs text-slate-500 underline underline-offset-2 hover:text-slate-800",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600",
        className,
      )}
    >
      {label}
    </button>
  );
}
