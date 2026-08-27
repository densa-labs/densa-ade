import { z } from "zod";

import {
  specificationQuestionCategorySchema,
  specificationQuestionImpactSchema,
} from "./project-specification.js";
import type { JsonObject } from "./json.js";

const preservedTextSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Interview text must contain non-whitespace content",
});
const questionIdSchema = z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);

export const specificationListFieldSchema = z.enum([
  "targetUsers",
  "coreUserJourneys",
  "requiredFeatures",
  "nonGoals",
  "architectureConstraints",
  "platformRuntimeConstraints",
  "integrations",
  "dataStorageNeeds",
  "securityPrivacyRequirements",
  "uxConstraints",
  "deploymentIntent",
]);
export type SpecificationListField = z.infer<typeof specificationListFieldSchema>;

export const interviewAdditionSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("initial_idea") }),
  z.strictObject({ kind: z.literal("answer"), questionId: questionIdSchema }),
]);
export type InterviewAdditionSource = z.infer<typeof interviewAdditionSourceSchema>;

export const interviewSpecificationAdditionSchema = z
  .strictObject({
    field: specificationListFieldSchema,
    value: preservedTextSchema,
    source: interviewAdditionSourceSchema,
  })
  .readonly();
export type InterviewSpecificationAddition = z.infer<typeof interviewSpecificationAdditionSchema>;

export const interviewQuestionSchema = z
  .strictObject({
    id: questionIdSchema,
    question: preservedTextSchema,
    category: specificationQuestionCategorySchema,
    impact: specificationQuestionImpactSchema,
    context: preservedTextSchema.optional(),
    proposedDefault: preservedTextSchema.optional(),
    defaultRationale: preservedTextSchema.optional(),
    defaultCanBeUsedWithoutAnswer: z.boolean().optional(),
    batchKey: preservedTextSchema,
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
export type InterviewQuestion = z.infer<typeof interviewQuestionSchema>;

const interviewAgentQuestionSchema = z
  .strictObject({
    id: questionIdSchema,
    question: preservedTextSchema,
    category: specificationQuestionCategorySchema,
    impact: specificationQuestionImpactSchema,
    context: preservedTextSchema.nullable().optional(),
    proposedDefault: preservedTextSchema.nullable().optional(),
    defaultRationale: preservedTextSchema.nullable().optional(),
    defaultCanBeUsedWithoutAnswer: z.boolean().nullable().optional(),
    batchKey: preservedTextSchema,
  })
  .transform((question) =>
    interviewQuestionSchema.parse({
      id: question.id,
      question: question.question,
      category: question.category,
      impact: question.impact,
      batchKey: question.batchKey,
      ...(question.context == null ? {} : { context: question.context }),
      ...(question.proposedDefault == null ? {} : { proposedDefault: question.proposedDefault }),
      ...(question.defaultRationale == null ? {} : { defaultRationale: question.defaultRationale }),
      ...(question.defaultCanBeUsedWithoutAnswer == null
        ? {}
        : { defaultCanBeUsedWithoutAnswer: question.defaultCanBeUsedWithoutAnswer }),
    }),
  );

export const interviewAgentProposalSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    additions: z.array(interviewSpecificationAdditionSchema),
    questions: z.array(interviewAgentQuestionSchema),
  })
  .superRefine((proposal, context) => {
    const ids = new Set<string>();
    for (const [index, question] of proposal.questions.entries()) {
      if (ids.has(question.id)) {
        context.addIssue({
          code: "custom",
          message: `Interview question ID ${question.id} is duplicated`,
          path: ["questions", index, "id"],
        });
      }
      ids.add(question.id);
    }
  })
  .readonly();
export type InterviewAgentProposal = z.infer<typeof interviewAgentProposalSchema>;

/** JSON Schema supplied to adapters with constrained final-response support. */
export const interviewAgentProposalOutputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["formatVersion", "additions", "questions"],
  properties: {
    formatVersion: { type: "integer", enum: [1] },
    additions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "value", "source"],
        properties: {
          field: { type: "string", enum: specificationListFieldSchema.options },
          value: { type: "string", minLength: 1 },
          source: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["kind"],
                properties: { kind: { type: "string", enum: ["initial_idea"] } },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind", "questionId"],
                properties: {
                  kind: { type: "string", enum: ["answer"] },
                  questionId: { type: "string", minLength: 1 },
                },
              },
            ],
          },
        },
      },
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "question",
          "category",
          "impact",
          "context",
          "proposedDefault",
          "defaultRationale",
          "defaultCanBeUsedWithoutAnswer",
          "batchKey",
        ],
        properties: {
          id: { type: "string", minLength: 1 },
          question: { type: "string", minLength: 1 },
          category: { type: "string", enum: specificationQuestionCategorySchema.options },
          impact: { type: "string", enum: specificationQuestionImpactSchema.options },
          context: { type: ["string", "null"] },
          proposedDefault: { type: ["string", "null"] },
          defaultRationale: { type: ["string", "null"] },
          defaultCanBeUsedWithoutAnswer: { type: ["boolean", "null"] },
          batchKey: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

export const interviewAnswerSchema = z
  .strictObject({
    questionId: questionIdSchema,
    answer: preservedTextSchema,
  })
  .readonly();
export type InterviewAnswer = z.infer<typeof interviewAnswerSchema>;
