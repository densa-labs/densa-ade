import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AdaptiveInterviewError,
  AdaptiveInterviewPlanner,
  AgentAdapterMasterInterviewAgent,
  parseProjectSpecificationMarkdown,
} from "@densa-ade/core";
import { FakeAgentAdapter } from "@densa-ade/testing";

function proposal({ additions = [], questions = [] } = {}) {
  return JSON.stringify({ formatVersion: 1, additions, questions });
}

function question(overrides) {
  return {
    id: "scope.core-journey",
    question: "What must the core user journey accomplish?",
    category: "user_journey",
    impact: "high",
    batchKey: "core scope",
    ...overrides,
  };
}

function plannerFor(finalMessage, requests = []) {
  const adapter = new FakeAgentAdapter({
    finalMessage,
    exitCode: 0,
    onExecute: (request) => requests.push(request),
  });
  return new AdaptiveInterviewPlanner(
    new AgentAdapterMasterInterviewAgent(adapter, {
      cwd: process.cwd(),
      runIdFactory: () => `interview-${requests.length}`,
    }),
  );
}

test("different initial ideas produce different adaptive question sets through FakeAgentAdapter", async () => {
  const offlineRequests = [];
  const offlinePlanner = plannerFor(
    proposal({
      additions: [
        {
          field: "platformRuntimeConstraints",
          value: "offline macOS app",
          source: { kind: "initial_idea" },
        },
      ],
      questions: [
        question({
          id: "data.sync-model",
          question: "Must data ever synchronize between Macs?",
          category: "data_storage",
          batchKey: "local data",
        }),
      ],
    }),
    offlineRequests,
  );
  const commercePlanner = plannerFor(
    proposal({
      additions: [
        {
          field: "requiredFeatures",
          value: "marketplace",
          source: { kind: "initial_idea" },
        },
      ],
      questions: [
        question({
          id: "integration.payments",
          question: "Which payment processor must the marketplace use?",
          category: "integration",
          batchKey: "payments",
        }),
      ],
    }),
  );

  const offline = await offlinePlanner.start("Build an offline macOS app for field notes.");
  const commerce = await commercePlanner.start("Build a marketplace for local artists.");

  assert.deepEqual(
    offline.questions.map(({ id }) => id),
    ["data.sync-model"],
  );
  assert.deepEqual(
    commerce.questions.map(({ id }) => id),
    ["integration.payments"],
  );
  assert.equal(offline.specification.projectGoal, "Build an offline macOS app for field notes.");
  assert.deepEqual(offline.specification.platformRuntimeConstraints, ["offline macOS app"]);
  assert.match(offlineRequests[0].prompt, /Do not use a fixed questionnaire/u);
  assert.match(offlineRequests[0].prompt, /Build an offline macOS app for field notes/u);
  assert.equal(offlineRequests[0].outputSchema.type, "object");
});

test("Core ranks material risks ahead of cosmetics and batches related questions", async () => {
  const planner = plannerFor(
    proposal({
      questions: [
        question({
          id: "ux.accent-color",
          question: "Which accent color should the application use?",
          category: "ux",
          impact: "low",
          batchKey: "appearance",
          proposedDefault: "Use the system accent color.",
          defaultRationale: "It follows the host platform.",
          defaultCanBeUsedWithoutAnswer: true,
        }),
        question({
          id: "security.data-boundary",
          question: "May sensitive records leave the device?",
          category: "security_privacy",
          impact: "high",
          batchKey: "trust boundary",
        }),
        question({
          id: "architecture.authority",
          question: "Which process owns authoritative state?",
          category: "architecture",
          impact: "high",
          batchKey: "trust boundary",
        }),
        question({
          id: "integration.identity",
          question: "Which identity provider is required?",
          category: "integration",
          impact: "medium",
          batchKey: "identity",
        }),
      ],
    }),
  );

  const snapshot = await planner.start("Build a secure records application.");

  assert.deepEqual(
    snapshot.questions.map(({ id }) => id),
    ["architecture.authority", "security.data-boundary", "integration.identity", "ux.accent-color"],
  );
  assert.deepEqual(
    snapshot.questionBatches[0].questions.map(({ id }) => id),
    ["architecture.authority", "security.data-boundary"],
  );
  assert.equal(snapshot.questionBatches[0].topic, "trust boundary");

  const resumed = planner.resume(snapshot.specification);
  assert.deepEqual(
    resumed.questionBatches[0].questions.map(({ id }) => id),
    ["architecture.authority", "security.data-boundary"],
  );
  assert.deepEqual(resumed.readiness, snapshot.readiness);
  assert.equal(resumed.specificationMarkdown, snapshot.specificationMarkdown);
});

test("low-impact cosmetics and safe explicit defaults do not block roadmap readiness", async () => {
  const planner = plannerFor(
    proposal({
      questions: [
        question({
          id: "deployment.packaging",
          question: "Which package format should the prototype use?",
          category: "deployment",
          impact: "medium",
          batchKey: "packaging",
          proposedDefault: "Use an unsigned local application bundle for the prototype.",
          defaultRationale: "Distribution is outside the prototype scope.",
          defaultCanBeUsedWithoutAnswer: true,
        }),
        question({
          id: "ux.corner-radius",
          question: "How rounded should cards be?",
          category: "ux",
          impact: "low",
          batchKey: "appearance",
        }),
      ],
    }),
  );

  const snapshot = await planner.start("Build a local prototype.");

  assert.equal(snapshot.readiness.readyForRoadmap, true);
  assert.deepEqual(snapshot.readiness.blockingQuestionIds, []);
  assert.match(snapshot.specificationMarkdown, /Proposed default: Use an unsigned/u);
  assert.match(snapshot.specificationMarkdown, /May proceed without an answer: yes/u);
});

test("unresolved critical ambiguity prevents roadmap readiness even with a proposed default", async () => {
  const planner = plannerFor(
    proposal({
      questions: [
        question({
          id: "security.data-residency",
          question: "May regulated data leave the user's country?",
          category: "security_privacy",
          impact: "high",
          batchKey: "data boundary",
          proposedDefault: "Keep all regulated data in-country.",
          defaultRationale: "This is the conservative option but still changes architecture.",
          defaultCanBeUsedWithoutAnswer: false,
        }),
      ],
    }),
  );

  const snapshot = await planner.start("Build a records system for regulated clinics.");

  assert.equal(snapshot.readiness.readyForRoadmap, false);
  assert.deepEqual(snapshot.readiness.blockingQuestionIds, ["security.data-residency"]);
});

test("each answer batch records exact decisions and returns an updated round-trippable SPEC.md", async () => {
  const initial = await plannerFor(
    proposal({
      questions: [
        question({
          id: "data.primary-store",
          question: "Which primary database must the service use?",
          category: "data_storage",
          impact: "high",
          batchKey: "persistence",
        }),
      ],
    }),
  ).start("Build an inventory service.");
  const answerRequests = [];
  const answerPlanner = plannerFor(
    proposal({
      additions: [
        {
          field: "dataStorageNeeds",
          value: "PostgreSQL",
          source: { kind: "answer", questionId: "data.primary-store" },
        },
      ],
    }),
    answerRequests,
  );

  const updated = await answerPlanner.answerBatch({
    snapshot: initial,
    batchId: initial.questionBatches[0].id,
    answers: [{ questionId: "data.primary-store", answer: "Use PostgreSQL, self-hosted." }],
  });

  assert.deepEqual(updated.specification.dataStorageNeeds, ["PostgreSQL"]);
  assert.deepEqual(updated.specification.explicitUserDecisions, [
    {
      topic: "Which primary database must the service use?",
      decision: "Use PostgreSQL, self-hosted.",
    },
  ]);
  assert.deepEqual(updated.specification.unresolvedQuestions, []);
  assert.equal(updated.readiness.readyForRoadmap, true);
  assert.deepEqual(
    parseProjectSpecificationMarkdown(updated.specificationMarkdown),
    updated.specification,
  );
  assert.match(updated.specificationMarkdown, /Use PostgreSQL, self-hosted\./u);
  assert.match(updated.specificationMarkdown, /## Unresolved questions\n\n_None recorded\._/u);
  assert.match(answerRequests[0].prompt, /"stage":"answers"/u);
});

test("answering one batch cannot silently discard another unresolved critical question", async () => {
  const initial = await plannerFor(
    proposal({
      questions: [
        question({
          id: "architecture.authority",
          question: "Which process owns state?",
          category: "architecture",
          impact: "high",
          batchKey: "authority",
        }),
        question({
          id: "security.encryption",
          question: "Must stored records use application-level encryption?",
          category: "security_privacy",
          impact: "high",
          batchKey: "encryption",
        }),
      ],
    }),
  ).start("Build a records system.");

  const updated = await plannerFor(proposal()).answerBatch({
    snapshot: initial,
    batchId: initial.questionBatches[0].id,
    answers: [{ questionId: "architecture.authority", answer: "The local Core process." }],
  });

  assert.deepEqual(
    updated.questions.map(({ id }) => id),
    ["security.encryption"],
  );
  assert.equal(updated.readiness.readyForRoadmap, false);
});

test("answer ingestion rejects a snapshot whose questions no longer match the specification", async () => {
  const initial = await plannerFor(
    proposal({
      questions: [
        question({
          id: "architecture.authority",
          question: "Which process owns state?",
          category: "architecture",
          impact: "high",
          batchKey: "authority",
        }),
      ],
    }),
  ).start("Build a local stateful tool.");
  const tampered = {
    ...initial,
    specification: { ...initial.specification, unresolvedQuestions: [] },
  };

  await assert.rejects(
    plannerFor(proposal()).answerBatch({
      snapshot: tampered,
      batchId: initial.questionBatches[0].id,
      answers: [{ questionId: "architecture.authority", answer: "The local Core process." }],
    }),
    (error) => error instanceof AdaptiveInterviewError && error.code === "USER_CONFIGURATION_ERROR",
  );
});

test("Core rejects invented specification additions and presentation-wrapped agent output", async () => {
  const invented = plannerFor(
    proposal({
      additions: [
        {
          field: "integrations",
          value: "Stripe",
          source: { kind: "initial_idea" },
        },
      ],
    }),
  );
  await assert.rejects(
    invented.start("Build a small catalog."),
    (error) =>
      error instanceof AdaptiveInterviewError && error.code === "INTERNAL_INVARIANT_VIOLATION",
  );

  const fenced = plannerFor(`\`\`\`json\n${proposal()}\n\`\`\``);
  await assert.rejects(
    fenced.start("Build a small catalog."),
    (error) => error instanceof AdaptiveInterviewError && error.code === "PROCESS_FAILURE",
  );
});

test("Master interview preserves stable adapter failure classifications", async () => {
  const adapter = new FakeAgentAdapter({
    outcome: "failed",
    error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in with the official client" },
  });
  const planner = new AdaptiveInterviewPlanner(
    new AgentAdapterMasterInterviewAgent(adapter, { cwd: process.cwd() }),
  );

  await assert.rejects(
    planner.start("Build a local tool."),
    (error) => error instanceof AdaptiveInterviewError && error.code === "AUTHENTICATION_REQUIRED",
  );
});
