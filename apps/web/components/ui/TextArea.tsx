"use client";

import type { Ref, TextareaHTMLAttributes } from "react";
import { cn } from "./cn";
import { useFieldControl } from "./FormField";
import { inputBase, inputSizes, type InputSize } from "./styles";

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  inputSize?: InputSize;
  /** System monospace, for AI prompts and code-like settings (reference Prompts editor). */
  mono?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

/** Native textarea. Use mono for system and AI prompts, the default sans for participant-facing prose. */
export function TextArea({ inputSize = "md", mono = false, className, rows = 3, ...rest }: TextAreaProps) {
  const field = useFieldControl();
  return (
    <textarea
      rows={rows}
      {...field}
      {...rest}
      className={cn(
        inputBase,
        inputSizes[inputSize],
        mono && "font-mono text-sm leading-relaxed text-slate-800",
        className,
      )}
    />
  );
}
