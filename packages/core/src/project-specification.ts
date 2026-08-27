import { projectSpecificationSchema, type ProjectSpecification } from "@densa/protocol";

const CANONICAL_BLOCK_START = "<!-- densa:project-specification:canonical -->\n```json\n";
const CANONICAL_BLOCK_END = "\n```\n<!-- /densa:project-specification:canonical -->";

export type SpecificationContradictionCode =
  "CONFLICTING_USER_DECISIONS" | "REQUIRED_FEATURE_IS_NON_GOAL";

export interface SpecificationContradiction {
  readonly code: SpecificationContradictionCode;
  readonly message: string;
  readonly paths: readonly string[];
}

export class ProjectSpecificationMarkdownError extends Error {
  readonly code = "USER_CONFIGURATION_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectSpecificationMarkdownError";
  }
}

function comparisonKey(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

export function detectSpecificationContradictions(
  input: ProjectSpecification,
): readonly SpecificationContradiction[] {
  const specification = projectSpecificationSchema.parse(input);
  const contradictions: SpecificationContradiction[] = [];
  const nonGoals = new Map<string, number[]>();

  for (const [index, nonGoal] of specification.nonGoals.entries()) {
    const key = comparisonKey(nonGoal);
    const indexes = nonGoals.get(key) ?? [];
    indexes.push(index);
    nonGoals.set(key, indexes);
  }
  for (const [featureIndex, feature] of specification.requiredFeatures.entries()) {
    for (const nonGoalIndex of nonGoals.get(comparisonKey(feature)) ?? []) {
      contradictions.push(
        Object.freeze({
          code: "REQUIRED_FEATURE_IS_NON_GOAL",
          message: `The same scope is both required and excluded: ${feature.trim()}`,
          paths: Object.freeze([`requiredFeatures.${featureIndex}`, `nonGoals.${nonGoalIndex}`]),
        }),
      );
    }
  }

  const decisionsByTopic = new Map<
    string,
    { readonly index: number; readonly decisionKey: string; readonly topic: string }
  >();
  for (const [index, decision] of specification.explicitUserDecisions.entries()) {
    const topicKey = comparisonKey(decision.topic);
    const earlier = decisionsByTopic.get(topicKey);
    if (earlier === undefined) {
      decisionsByTopic.set(topicKey, {
        index,
        decisionKey: comparisonKey(decision.decision),
        topic: decision.topic,
      });
      continue;
    }
    if (earlier.decisionKey !== comparisonKey(decision.decision)) {
      contradictions.push(
        Object.freeze({
          code: "CONFLICTING_USER_DECISIONS",
          message: `Explicit user decisions disagree for topic: ${earlier.topic.trim()}`,
          paths: Object.freeze([
            `explicitUserDecisions.${earlier.index}.decision`,
            `explicitUserDecisions.${index}.decision`,
          ]),
        }),
      );
    }
  }

  return Object.freeze(contradictions);
}

function inlineText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function appendTextList(lines: string[], title: string, values: readonly string[]): void {
  lines.push(`## ${title}`, "");
  if (values.length === 0) {
    lines.push("_None recorded._", "");
    return;
  }
  for (const value of values) {
    lines.push(`- ${value.replace(/\r\n?/gu, "\n").replace(/\n/gu, "\n  ")}`);
  }
  lines.push("");
}

/** Render the structured source of truth into deterministic, inspectable SPEC.md content. */
export function renderProjectSpecificationMarkdown(input: ProjectSpecification): string {
  const specification = projectSpecificationSchema.parse(input);
  const contradictions = detectSpecificationContradictions(specification);
  const lines = [
    "# Project Specification",
    "",
    "> Generated from Densa Core's versioned project specification. The canonical block at the end preserves exact values for lossless import.",
    "",
    "## Project goal",
    "",
    specification.projectGoal.replace(/\r\n?/gu, "\n"),
    "",
  ];

  appendTextList(lines, "Target users", specification.targetUsers);
  appendTextList(lines, "Core user journeys", specification.coreUserJourneys);
  appendTextList(lines, "Required features", specification.requiredFeatures);
  appendTextList(lines, "Non-goals", specification.nonGoals);
  appendTextList(lines, "Architecture constraints", specification.architectureConstraints);
  appendTextList(
    lines,
    "Platform and runtime constraints",
    specification.platformRuntimeConstraints,
  );
  appendTextList(lines, "Integrations", specification.integrations);
  appendTextList(lines, "Data and storage needs", specification.dataStorageNeeds);
  appendTextList(
    lines,
    "Security and privacy requirements",
    specification.securityPrivacyRequirements,
  );
  appendTextList(lines, "UX constraints", specification.uxConstraints);
  appendTextList(lines, "Deployment intent", specification.deploymentIntent);

  lines.push("## Explicit user decisions", "");
  if (specification.explicitUserDecisions.length === 0) {
    lines.push("_None recorded._", "");
  } else {
    for (const decision of specification.explicitUserDecisions) {
      lines.push(
        `### ${inlineText(decision.topic)}`,
        "",
        decision.decision.replace(/\r\n?/gu, "\n"),
        "",
      );
    }
  }

  lines.push("## Unresolved questions", "");
  if (specification.unresolvedQuestions.length === 0) {
    lines.push("_None recorded._", "");
  } else {
    for (const question of specification.unresolvedQuestions) {
      lines.push(
        `### ${inlineText(question.question)}`,
        "",
        `- ID: \`${question.id}\``,
        `- Category: \`${question.category}\``,
        `- Impact: **${question.impact.toUpperCase()}**`,
      );
      if (question.context !== undefined) {
        lines.push("", question.context.replace(/\r\n?/gu, "\n"));
      }
      if (question.proposedDefault !== undefined) {
        lines.push("", `Proposed default: ${question.proposedDefault.replace(/\r\n?/gu, "\n")}`);
        if (question.defaultRationale !== undefined) {
          lines.push(
            "",
            `Default rationale: ${question.defaultRationale.replace(/\r\n?/gu, "\n")}`,
          );
        }
        lines.push(
          "",
          `May proceed without an answer: ${question.defaultCanBeUsedWithoutAnswer === true ? "yes" : "no"}`,
        );
      }
      if (question.batchKey !== undefined) {
        lines.push("", `Interview batch: ${question.batchKey.replace(/\r\n?/gu, "\n")}`);
      }
      lines.push("");
    }
  }

  lines.push("## Contradictions", "");
  if (contradictions.length === 0) {
    lines.push("_No structural contradictions detected._", "");
  } else {
    for (const contradiction of contradictions) {
      lines.push(
        `- **${contradiction.code}**: ${contradiction.message} (${contradiction.paths.join(", ")})`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Canonical structured specification",
    "",
    "This machine-readable block is part of the portable document and must remain synchronized with the human-readable sections above.",
    "",
    `${CANONICAL_BLOCK_START}${JSON.stringify(specification, undefined, 2)}${CANONICAL_BLOCK_END}`,
    "",
  );
  return lines.join("\n");
}

/** Parse only renderer-produced SPEC.md files, validating the embedded schema version and shape. */
export function parseProjectSpecificationMarkdown(markdown: string): ProjectSpecification {
  const startIndex = markdown.indexOf(CANONICAL_BLOCK_START);
  if (startIndex === -1) {
    throw new ProjectSpecificationMarkdownError(
      "SPEC.md does not contain a canonical project specification block",
    );
  }
  if (markdown.indexOf(CANONICAL_BLOCK_START, startIndex + CANONICAL_BLOCK_START.length) !== -1) {
    throw new ProjectSpecificationMarkdownError(
      "SPEC.md contains more than one canonical project specification block",
    );
  }
  const jsonStart = startIndex + CANONICAL_BLOCK_START.length;
  const endIndex = markdown.indexOf(CANONICAL_BLOCK_END, jsonStart);
  if (endIndex === -1) {
    throw new ProjectSpecificationMarkdownError(
      "SPEC.md canonical project specification block is incomplete",
    );
  }

  try {
    return projectSpecificationSchema.parse(JSON.parse(markdown.slice(jsonStart, endIndex)));
  } catch (error) {
    throw new ProjectSpecificationMarkdownError(
      "SPEC.md canonical project specification is not valid version 1 data",
      { cause: error },
    );
  }
}
