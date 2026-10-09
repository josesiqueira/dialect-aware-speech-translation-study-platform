"use client";

import { createContext, useContext, useId, useMemo, type ReactNode } from "react";
import { cn } from "./cn";
import { labelBase } from "./styles";

/** Attributes that FormField hands to the control inside it. */
export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  required?: boolean;
}

const FormFieldContext = createContext<FieldControlProps | null>(null);

/**
 * Read the attributes of the surrounding FormField. TextInput, TextArea and
 * Select call this themselves. Use it for a custom control placed in a FormField.
 */
export function useFieldControl(): FieldControlProps | null {
  return useContext(FormFieldContext);
}

export interface FormFieldProps {
  label: ReactNode;
  /** Concise helper text under the label. */
  help?: ReactNode;
  /** Field-specific error. Sets aria-invalid on the control and is linked with aria-describedby. */
  error?: ReactNode;
  /** Adds the visible "(required)" text and the required attribute. */
  required?: boolean;
  /** Override the generated control id. */
  id?: string;
  /** Hide the label visually (it stays available to screen readers). */
  hideLabel?: boolean;
  /** One control: TextInput, TextArea or Select. */
  children: ReactNode;
  className?: string;
}

/**
 * Label, help text and error for one control. The control inside receives its
 * id, aria-describedby, aria-invalid and required attributes through context,
 * so the association cannot be forgotten.
 *
 * For a group of radio buttons or checkboxes use RadioGroup or LikertScale,
 * which render a fieldset and legend.
 */
export function FormField({
  label,
  help,
  error,
  required = false,
  id,
  hideLabel = false,
  children,
  className,
}: FormFieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const helpId = `${controlId}-help`;
  const errorId = `${controlId}-error`;
  const hasError = error !== undefined && error !== null && error !== false && error !== "";

  const control = useMemo<FieldControlProps>(() => {
    const describedBy = [help ? helpId : null, hasError ? errorId : null].filter(Boolean).join(" ");
    return {
      id: controlId,
      "aria-describedby": describedBy || undefined,
      "aria-invalid": hasError ? true : undefined,
      required: required || undefined,
    };
  }, [controlId, help, helpId, hasError, errorId, required]);

  return (
    <div className={className}>
      <label htmlFor={controlId} className={cn(labelBase, "mb-1", hideLabel && "sr-only")}>
        {label}
        {required && <span className="font-normal text-slate-500"> (required)</span>}
      </label>
      {help && (
        <p id={helpId} className="mb-1.5 text-xs text-slate-500">
          {help}
        </p>
      )}
      <FormFieldContext.Provider value={control}>{children}</FormFieldContext.Provider>
      {hasError && (
        <p id={errorId} className="mt-1 text-sm text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}
