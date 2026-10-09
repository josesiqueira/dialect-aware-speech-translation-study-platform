"use client";

import type { Ref, SelectHTMLAttributes } from "react";
import { cn } from "./cn";
import { useFieldControl } from "./FormField";
import { inputBase, inputSizes, type InputSize } from "./styles";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  inputSize?: InputSize;
  /** Options to render. Alternatively pass <option> children. */
  options?: SelectOption[];
  /** Adds a first option with an empty value, for example "Select a model". */
  placeholder?: string;
  ref?: Ref<HTMLSelectElement>;
}

/** Native select. It is never replaced by a custom dropdown. */
export function Select({
  inputSize = "md",
  options,
  placeholder,
  className,
  children,
  ...rest
}: SelectProps) {
  const field = useFieldControl();
  return (
    <select {...field} {...rest} className={cn(inputBase, inputSizes[inputSize], className)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options?.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
      {children}
    </select>
  );
}
