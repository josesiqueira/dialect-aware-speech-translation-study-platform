"use client";

import type { InputHTMLAttributes, Ref } from "react";
import { cn } from "./cn";
import { useFieldControl } from "./FormField";
import { inputBase, inputSizes, type InputSize } from "./styles";

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** md: admin density. lg: participant density (text-base, rounded-lg). */
  inputSize?: InputSize;
  /** Monospace tabular text for identifiers and numbers. */
  mono?: boolean;
  ref?: Ref<HTMLInputElement>;
}

/** Native text input. Inside a FormField it picks up id, aria-describedby and aria-invalid. */
export function TextInput({ inputSize = "md", mono = false, className, ...rest }: TextInputProps) {
  const field = useFieldControl();
  return (
    <input
      type="text"
      {...field}
      {...rest}
      className={cn(inputBase, inputSizes[inputSize], mono && "font-mono tabular-nums", className)}
    />
  );
}
