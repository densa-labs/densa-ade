import { z } from "zod";

export type JsonPrimitive = boolean | null | number | string;

export type JsonObject = {
  [key: string]: JsonValue;
};

export type JsonValue = JsonObject | JsonPrimitive | JsonValue[];

/**
 * The complete set of values allowed across Densa's IPC boundary.
 *
 * In particular, this rejects Date, bigint, undefined, NaN, and infinities.
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

/** ISO-8601 timestamp with an explicit UTC or numeric offset. */
export const isoTimestampSchema = z.iso.datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;
