import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProjectSpecificationMarkdownError,
  detectSpecificationContradictions,
  parseProjectSpecificationMarkdown,
  renderProjectSpecificationMarkdown,
} from "@densa/core";
import { projectSpecificationSchema } from "@densa/protocol";

function makeSpecification(overrides = {}) {
  return {
    formatVersion: 1,
    projectGoal: "Build a local-first planning IDE without weakening user constraints.",
    targetUsers: ["Developers who want controllable agent orchestration"],
    coreUserJourneys: ["Turn an idea into a complete, inspectable roadmap"],
    requiredFeatures: ["Show every unresolved high-impact question"],
    nonGoals: ["Cloud-only operation"],
    architectureConstraints: ["Densa Core must remain editor-independent"],
    platformRuntimeConstraints: ["v0.1 targets macOS"],
    integrations: ["Official Codex CLI authentication"],
    dataStorageNeeds: ["SQLite is the detailed runtime source of truth"],
    securityPrivacyRequirements: ["Telemetry is off by default"],
    uxConstraints: ["Unknown usage state must be displayed as unknown"],
    deploymentIntent: ["Ship as a local Code - OSS-based application"],
    explicitUserDecisions: [
      {
        topic: "Worker concurrency",
        decision: "v0.1 executes one implementation worker at a time",
      },
    ],
    unresolvedQuestions: [
      {
        id: "security.secret-store",
        question: "Which user-managed secret stores must v0.1 support?",
        category: "security_privacy",
        impact: "high",
        context: "The choice affects credential persistence and process injection boundaries.",
      },
    ],
    ...overrides,
  };
}

test("example structured specifications round-trip losslessly through SPEC.md", () => {
  const specification = projectSpecificationSchema.parse(
    makeSpecification({
      projectGoal: "  Preserve this exact spacing and Markdown: **do not reinterpret**.  ",
      architectureConstraints: ["First line\nSecond line with `code` and ünicode."],
    }),
  );

  const markdown = renderProjectSpecificationMarkdown(specification);

  assert.match(markdown, /^# Project Specification\n/u);
  assert.match(markdown, /## Unresolved questions/u);
  assert.match(markdown, /Impact: \*\*HIGH\*\*/u);
  assert.match(markdown, /Canonical structured specification/u);
  assert.deepEqual(parseProjectSpecificationMarkdown(markdown), specification);
  assert.equal(renderProjectSpecificationMarkdown(specification), markdown);
});

test("the versioned schema represents high-impact unresolved questions and rejects drift", () => {
  const specification = projectSpecificationSchema.parse(makeSpecification());
  assert.equal(specification.formatVersion, 1);
  assert.equal(specification.unresolvedQuestions[0].impact, "high");
  assert.equal(Object.isFrozen(specification), true);

  assert.equal(
    projectSpecificationSchema.safeParse({ ...makeSpecification(), formatVersion: 2 }).success,
    false,
  );
  assert.equal(
    projectSpecificationSchema.safeParse({
      ...makeSpecification(),
      unresolvedQuestions: [
        makeSpecification().unresolvedQuestions[0],
        makeSpecification().unresolvedQuestions[0],
      ],
    }).success,
    false,
  );
  assert.equal(
    projectSpecificationSchema.safeParse({ ...makeSpecification(), providerPrompt: "hidden" })
      .success,
    false,
  );
});

test("contradictory scope and explicit decisions are detected and surfaced in SPEC.md", () => {
  const specification = projectSpecificationSchema.parse(
    makeSpecification({
      requiredFeatures: ["Offline operation"],
      nonGoals: ["  offline   operation  "],
      explicitUserDecisions: [
        { topic: "Storage", decision: "Use SQLite" },
        { topic: " storage ", decision: "Use PostgreSQL" },
      ],
    }),
  );

  const contradictions = detectSpecificationContradictions(specification);
  assert.deepEqual(
    contradictions.map(({ code, paths }) => ({ code, paths })),
    [
      {
        code: "REQUIRED_FEATURE_IS_NON_GOAL",
        paths: ["requiredFeatures.0", "nonGoals.0"],
      },
      {
        code: "CONFLICTING_USER_DECISIONS",
        paths: ["explicitUserDecisions.0.decision", "explicitUserDecisions.1.decision"],
      },
    ],
  );
  const markdown = renderProjectSpecificationMarkdown(specification);
  assert.match(markdown, /REQUIRED_FEATURE_IS_NON_GOAL/u);
  assert.match(markdown, /CONFLICTING_USER_DECISIONS/u);
});

test("SPEC.md parsing fails closed on missing, duplicate, or unsupported canonical data", () => {
  assert.throws(
    () => parseProjectSpecificationMarkdown("# Handwritten specification\n"),
    (error) =>
      error instanceof ProjectSpecificationMarkdownError &&
      error.code === "USER_CONFIGURATION_ERROR",
  );

  const markdown = renderProjectSpecificationMarkdown(
    projectSpecificationSchema.parse(makeSpecification()),
  );
  assert.throws(
    () => parseProjectSpecificationMarkdown(`${markdown}\n${markdown}`),
    /more than one canonical/u,
  );
  assert.throws(
    () =>
      parseProjectSpecificationMarkdown(
        markdown.replace('"formatVersion": 1', '"formatVersion": 2'),
      ),
    /not valid version 1/u,
  );
});
