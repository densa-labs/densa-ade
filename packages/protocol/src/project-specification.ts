import { z } from "zod";

const preservedTextSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Specification text must contain non-whitespace content",
});

export const specificationQuestionCategorySchema = z.enum([
  "architecture",
  "security_privacy",
  "data_storage",
  "integration",
  "platform_runtime",
  "deployment",
  "user_journey",
  "feature_scope",
  "ux",
  "other",
]);
export type SpecificationQuestionCategory = z.infer<typeof specificationQuestionCategorySchema>;

export const specificationQuestionImpactSchema = z.enum(["high", "medium", "low"]);
export type SpecificationQuestionImpact = z.infer<typeof specificationQuestionImpactSchema>;

export const explicitUserDecisionSchema = z
  .strictObject({
    topic: preservedTextSchema,
    decision: preservedTextSchema,
  })
  .readonly();
export type ExplicitUserDecision = z.infer<typeof explicitUserDecisionSchema>;

export const unresolvedSpecificationQuestionSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u),
    question: preservedTextSchema,
    category: specificationQuestionCategorySchema,
    impact: specificationQuestionImpactSchema,
    context: preservedTextSchema.optional(),
    proposedDefault: preservedTextSchema.optional(),
    defaultRationale: preservedTextSchema.optional(),
    defaultCanBeUsedWithoutAnswer: z.boolean().optional(),
    batchKey: preservedTextSchema.optional(),
  })
  .superRefine((question, context) => {
    if (
      (question.defaultRationale !== undefined ||
        question.defaultCanBeUsedWithoutAnswer !== undefined) &&
      question.proposedDefault === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Default metadata requires a proposed default",
        path: ["proposedDefault"],
      });
    }
    if (question.impact === "high" && question.defaultCanBeUsedWithoutAnswer === true) {
      context.addIssue({
        code: "custom",
        message: "High-impact ambiguity always requires a user answer",
        path: ["defaultCanBeUsedWithoutAnswer"],
      });
    }
  })
  .readonly();
export type UnresolvedSpecificationQuestion = z.infer<typeof unresolvedSpecificationQuestionSchema>;

const preservedTextListSchema = z.array(preservedTextSchema);

/**
 * Version 1 of the complete, editor- and model-neutral project intent contract.
 *
 * Text values are validated but never trimmed or rewritten. Callers must retain the user's exact
 * constraint wording here and put interpretation in a separate decision or question.
 */
export const projectSpecificationSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    projectGoal: preservedTextSchema,
    targetUsers: preservedTextListSchema,
    coreUserJourneys: preservedTextListSchema,
    requiredFeatures: preservedTextListSchema,
    nonGoals: preservedTextListSchema,
    architectureConstraints: preservedTextListSchema,
    platformRuntimeConstraints: preservedTextListSchema,
    integrations: preservedTextListSchema,
    dataStorageNeeds: preservedTextListSchema,
    securityPrivacyRequirements: preservedTextListSchema,
    uxConstraints: preservedTextListSchema,
    deploymentIntent: preservedTextListSchema,
    explicitUserDecisions: z.array(explicitUserDecisionSchema),
    unresolvedQuestions: z.array(unresolvedSpecificationQuestionSchema),
  })
  .superRefine((specification, context) => {
    const seenQuestionIds = new Set<string>();
    for (const [index, question] of specification.unresolvedQuestions.entries()) {
      if (seenQuestionIds.has(question.id)) {
        context.addIssue({
          code: "custom",
          message: `Unresolved question ID ${question.id} is duplicated`,
          path: ["unresolvedQuestions", index, "id"],
        });
      }
      seenQuestionIds.add(question.id);
    }
  })
  .readonly();
export type ProjectSpecification = z.infer<typeof projectSpecificationSchema>;
