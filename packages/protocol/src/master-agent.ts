import { z } from "zod";

import { jsonValueSchema, type JsonObject, type JsonValue } from "./json.js";
import { eventIdSchema } from "./ids.js";
import { roadmapMutationOperationSchema } from "./roadmap-mutation.js";
import { executionModeSchema } from "./states.js";

const nonEmptyText = z.string().refine((value) => value.trim().length > 0, {
  message: "Master Agent text must contain non-whitespace content",
});

export const masterAgentIntentSchema = z.enum([
  "explain_project_status",
  "explain_decision",
  "explain_current_phase",
  "propose_roadmap_change",
  "resolve_roadmap_revision",
  "propose_project_constraint_change",
  "request_project_control",
  "summarize_failures",
]);
export type MasterAgentIntent = z.infer<typeof masterAgentIntentSchema>;

export const masterAgentCitationSchema = z
  .strictObject({
    kind: z.enum([
      "project",
      "phase",
      "task",
      "decision",
      "event",
      "roadmap_revision",
      "roadmap_revision_proposal",
    ]),
    id: nonEmptyText,
  })
  .readonly();
export type MasterAgentCitation = z.infer<typeof masterAgentCitationSchema>;

function createMasterAgentSchemas(jsonValueContract: z.ZodType<JsonValue>) {
  const projectConstraintChangeSchema = z
    .strictObject({
      operation: z.enum(["add", "replace", "remove"]),
      path: z.string().regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/u),
      value: jsonValueContract.optional(),
    })
    .superRefine((change, context) => {
      if (change.operation === "remove" && change.value !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Removing a project constraint must not include a replacement value",
          path: ["value"],
        });
      }
      if (change.operation !== "remove" && change.value === undefined) {
        context.addIssue({
          code: "custom",
          message: `${change.operation} project constraint proposals require a value`,
          path: ["value"],
        });
      }
    })
    .readonly();

  const masterAgentActionSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("respond") }).readonly(),
    z
      .strictObject({
        kind: z.literal("propose_roadmap_change"),
        operation: roadmapMutationOperationSchema,
        additionalOperations: z.array(roadmapMutationOperationSchema).max(31).optional(),
        rationale: nonEmptyText,
      })
      .readonly(),
    z
      .strictObject({
        kind: z.literal("resolve_roadmap_revision"),
        proposalEventId: eventIdSchema,
        resolution: z.enum(["approve", "reject"]),
        rationale: nonEmptyText,
      })
      .readonly(),
    z
      .strictObject({
        kind: z.literal("propose_project_constraint_change"),
        change: projectConstraintChangeSchema,
        rationale: nonEmptyText,
      })
      .readonly(),
    z.strictObject({ kind: z.literal("request_pause") }).readonly(),
    z
      .strictObject({
        kind: z.literal("request_resume"),
        acknowledgeIntervention: z.boolean().optional(),
      })
      .readonly(),
    z
      .strictObject({
        kind: z.literal("request_mode_change"),
        mode: executionModeSchema,
      })
      .readonly(),
  ]);

  function actionMatchesIntent(
    intent: MasterAgentIntent,
    action: z.infer<typeof masterAgentActionSchema>,
  ): boolean {
    switch (intent) {
      case "propose_roadmap_change":
        return action.kind === "propose_roadmap_change";
      case "propose_project_constraint_change":
        return action.kind === "propose_project_constraint_change";
      case "resolve_roadmap_revision":
        return action.kind === "resolve_roadmap_revision";
      case "request_project_control":
        return (
          action.kind === "request_pause" ||
          action.kind === "request_resume" ||
          action.kind === "request_mode_change"
        );
      default:
        return action.kind === "respond";
    }
  }

  const masterAgentProposalSchema = z
    .strictObject({
      formatVersion: z.literal(1),
      intent: masterAgentIntentSchema,
      response: nonEmptyText,
      citations: z.array(masterAgentCitationSchema).max(32),
      action: masterAgentActionSchema,
    })
    .superRefine((proposal, context) => {
      if (!actionMatchesIntent(proposal.intent, proposal.action)) {
        context.addIssue({
          code: "custom",
          message: `Action ${proposal.action.kind} does not match intent ${proposal.intent}`,
          path: ["action"],
        });
      }
    })
    .readonly();
  return { projectConstraintChangeSchema, masterAgentActionSchema, masterAgentProposalSchema };
}

export const { projectConstraintChangeSchema, masterAgentActionSchema, masterAgentProposalSchema } =
  createMasterAgentSchemas(jsonValueSchema);
export type ProjectConstraintChange = z.infer<typeof projectConstraintChangeSchema>;
export type MasterAgentAction = z.infer<typeof masterAgentActionSchema>;
export type MasterAgentProposal = z.infer<typeof masterAgentProposalSchema>;

// JSON Schema represents the wire shape, not the runtime clone transform. Keep the
// same proposal builder and strict schema export; this surrogate is never used to
// parse untrusted values, where Zod records would silently drop __proto__ data.
const jsonValueShapeSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueShapeSchema),
    z.record(z.string(), jsonValueShapeSchema),
  ]),
);

/** JSON Schema supplied to adapters with constrained final-response support. */
export const masterAgentProposalOutputSchema = z.toJSONSchema(
  createMasterAgentSchemas(jsonValueShapeSchema).masterAgentProposalSchema,
) as JsonObject;
