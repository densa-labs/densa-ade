import { z } from "zod";

import { projectIdSchema } from "./ids.js";

const secretReferenceIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

/**
 * A persistable locator for a secret. The credential value is deliberately not part of this
 * protocol contract and must remain in the selected secret store.
 */
export const secretRefSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    id: secretReferenceIdSchema,
    projectId: projectIdSchema,
    store: z.literal("macos_keychain"),
  })
  .readonly();
export type SecretRef = z.infer<typeof secretRefSchema>;
