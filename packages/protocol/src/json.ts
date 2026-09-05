import { z } from "zod";

export type JsonPrimitive = boolean | null | number | string;

export type JsonObject = {
  [key: string]: JsonValue;
};

export type JsonValue = JsonObject | JsonPrimitive | JsonValue[];

/**
 * The complete set of values allowed across Densa ADE's IPC boundary.
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
    jsonObjectSchema,
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z
  .preprocess(
    (value, context) => {
      if (
        typeof value !== "object" ||
        value === null ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      ) {
        context.addIssue({ code: "custom", message: "Expected a plain JSON object" });
        return z.NEVER;
      }
      if (
        Object.getOwnPropertySymbols(value).some((key) =>
          Object.prototype.propertyIsEnumerable.call(value, key),
        )
      ) {
        context.addIssue({ code: "custom", message: "JSON object keys must be strings" });
        return z.NEVER;
      }
      return Object.entries(value);
    },
    z.array(z.tuple([z.string(), jsonValueSchema])),
  )
  // Zod records skip __proto__. Define every validated key as own data instead;
  // recursive entry validation also clones values and checks that key's contents.
  .transform((entries) => Object.fromEntries(entries));

/** ISO-8601 timestamp with an explicit UTC or numeric offset. */
export const isoTimestampSchema = z.iso.datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;
