import { z } from "zod";
import { validationError } from "./errors";
import type { ModelParameters } from "./types";

// Validates the free `parameters` record of a model configuration against an
// explicit allow-list for one endpoint.
//
// Rules (spec 103, 143):
// - a key outside the allow-list is rejected, never silently dropped;
// - a value of the wrong type or range is rejected;
// - nothing is added: a parameter that the configuration does not set is not sent.
//
// `reserved` maps keys that exist on the endpoint but are set elsewhere (for
// example through a typed input field) to a hint for the error message.
export function parseAllowedParameters<Shape extends z.ZodRawShape>(
  endpoint: string,
  parameters: ModelParameters | undefined,
  shape: Shape,
  reserved: Record<string, string> = {},
): Partial<z.infer<z.ZodObject<Shape>>> {
  const given: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters ?? {})) {
    if (value !== undefined) given[key] = value;
  }

  const allowed = Object.keys(shape);
  const unknownKeys = Object.keys(given).filter((key) => !allowed.includes(key));
  if (unknownKeys.length > 0) {
    const hints = unknownKeys
      .filter((key) => reserved[key] !== undefined)
      .map((key) => `"${key}": ${reserved[key]}`);
    const message =
      `Parameters not accepted for ${endpoint}: ${unknownKeys.map((k) => `"${k}"`).join(", ")}. ` +
      `Allowed parameters: ${allowed.length > 0 ? allowed.join(", ") : "(none)"}.` +
      (hints.length > 0 ? ` ${hints.join(" ")}` : "");
    throw validationError(message, { endpoint, unknownParameters: unknownKeys, allowedParameters: allowed });
  }

  const parsed = z.strictObject(shape).partial().safeParse(given);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      parameter: issue.path.join("."),
      message: issue.message,
    }));
    const text = issues.map((i) => `"${i.parameter}": ${i.message}`).join("; ");
    throw validationError(`Invalid parameter value for ${endpoint}: ${text}`, { endpoint, issues });
  }
  return parsed.data as Partial<z.infer<z.ZodObject<Shape>>>;
}
