// Route parameter schemas of the session routes. A value that is not a UUID is
// answered with VALIDATION_ERROR (400) before any query runs.
import { z } from "zod";
import { corpusSchemas } from "@dialect/domain";

export const sessionParamsSchema = z.object({ id: z.uuid() });
export const utteranceParamsSchema = z.object({ id: z.uuid(), utteranceId: z.uuid() });
export const outputParamsSchema = z.object({
  kind: corpusSchemas.outputKindParamSchema,
  outputId: z.uuid(),
});
