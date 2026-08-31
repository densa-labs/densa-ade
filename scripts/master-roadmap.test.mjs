import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentAdapterMasterRoadmapAgent,
  MasterRoadmapError,
  MasterRoadmapGenerator,
  parseMasterRoadmapMarkdown,
  renderMasterRoadmapMarkdown,
  topologicallyScheduleRoadmap,
} from "@densa-ade/core";
import {
  masterRoadmapSchema,
  masterRoadmapOutputSchema,
  interviewAgentProposalOutputSchema,
  projectSpecificationSchema,
} from "@densa-ade/protocol";
import { FakeAgentAdapter } from "@densa-ade/testing";

function specification(overrides = {}) {
  return projectSpecificationSchema.parse({
    formatVersion: 1,
    projectGoal: "Build a local inventory application for small workshops.",
    targetUsers: ["Workshop operators"],
    coreUserJourneys: ["Record stock and find low inventory"],
    requiredFeatures: ["Local stock management", "Low-stock report"],
    nonGoals: ["Multi-tenant cloud hosting"],
    architectureConstraints: ["A local Core process owns authoritative state"],
    platformRuntimeConstraints: ["macOS and Node.js"],
    integrations: [],
    dataStorageNeeds: ["SQLite persistence"],
    securityPrivacyRequirements: ["Inventory data remains local"],
    uxConstraints: ["Reports expose their source records"],
    deploymentIntent: ["Local application bundle"],
    explicitUserDecisions: [],
    unresolvedQuestions: [],
    ...overrides,
  });
}

function task(id, overrides = {}) {
  return {
    id,
    title: `Deliver ${id}`,
    goal: `Complete the ${id} capability.`,
    executable: true,
    dependencyIds: [],
    acceptanceCriteria: [`${id} has deterministic acceptance evidence.`],
    riskLevel: "medium",
    expectedValidators: ["unit_test", "acceptance"],
    ...overrides,
  };
}

function roadmap(overrides = {}) {
  return {
    formatVersion: 1,
    projectGoal: "Build a local inventory application for small workshops.",
    phases: [
      {
        id: "phase.foundation",
        title: "Foundation",
        goal: "Establish local storage and the domain model.",
        required: true,
        completionCriteria: ["Stock records persist and round-trip locally."],
        tasks: [task("storage.schema")],
      },
      {
        id: "phase.product",
        title: "Product workflows",
        goal: "Deliver stock management and reporting.",
        required: true,
        completionCriteria: ["The complete inventory journey passes end-to-end."],
        tasks: [
          task("inventory.crud", { dependencyIds: ["storage.schema"] }),
          task("report.low-stock", { dependencyIds: ["storage.schema"] }),
          task("product.e2e", {
            dependencyIds: ["inventory.crud", "report.low-stock"],
            expectedValidators: ["end_to_end", "acceptance"],
            riskLevel: "high",
          }),
        ],
      },
    ],
    ...overrides,
  };
}

function issueMessages(value) {
  const result = masterRoadmapSchema.safeParse(value);
  assert.equal(result.success, false);
  return result.error.issues.map(({ message }) => message);
}

test("planning response schemas require every object property for provider structured output", () => {
  function visit(schema) {
    if (schema === null || typeof schema !== "object") return;
    if (schema.type === "object") {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    }
    for (const value of Object.values(schema)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  }
  visit(masterRoadmapOutputSchema);
  visit(interviewAgentProposalOutputSchema);
});

test("ROADMAP.md round-trips literal canonical delimiters in roadmap text", () => {
  const value = roadmap({
    projectGoal:
      "Document syntax:\n<!-- densa:master-roadmap:canonical -->\n```json\n{}\n```\n<!-- /densa:master-roadmap:canonical -->",
  });
  assert.deepEqual(parseMasterRoadmapMarkdown(renderMasterRoadmapMarkdown(value)), value);
});

test("roadmaps reject phase ordering deadlocks and non-executable dependencies", () => {
  const backward = roadmap();
  backward.phases[0].tasks[0].dependencyIds = ["later.independent"];
  backward.phases[1].tasks.push(task("later.independent"));
  assert.match(issueMessages(backward).join("; "), /later phase/u);
  const nonExecutable = roadmap();
  nonExecutable.phases[0].tasks[0].executable = false;
  assert.match(issueMessages(nonExecutable).join("; "), /non-executable/u);
  const optional = roadmap();
  optional.phases[1].required = false;
  optional.phases[1].completionCriteria = [];
  assert.match(issueMessages(optional).join("; "), /completion criteria/u);
});

test("FakeAgentAdapter roadmap output is strictly parsed and produces a complete snapshot", async () => {
  const requests = [];
  const adapter = new FakeAgentAdapter({
    finalMessage: JSON.stringify(roadmap()),
    exitCode: 0,
    onExecute: (request) => requests.push(request),
  });
  const generator = new MasterRoadmapGenerator(
    new AgentAdapterMasterRoadmapAgent(adapter, {
      cwd: process.cwd(),
      runIdFactory: () => "master-roadmap-test",
    }),
  );

  const generated = await generator.generate(specification());

  assert.equal(generated.roadmap.phases.length, 2);
  assert.deepEqual(
    generated.schedule.map(({ taskId }) => taskId),
    ["storage.schema", "inventory.crud", "report.low-stock", "product.e2e"],
  );
  assert.deepEqual(parseMasterRoadmapMarkdown(generated.roadmapMarkdown), generated.roadmap);
  assert.match(requests[0].prompt, /complete intended project arc before execution begins/u);
  assert.match(requests[0].prompt, /Build a local inventory application/u);
  assert.equal(requests[0].outputSchema.additionalProperties, false);
  assert.equal(requests[0].accessMode, "read-only");
  assert.equal(requests[0].outputSchema.properties.phases.minItems, 1);
});

test("roadmap validation rejects every required structural failure with actionable errors", () => {
  const duplicate = roadmap({
    phases: [
      roadmap().phases[0],
      {
        ...roadmap().phases[1],
        id: "phase.foundation",
        tasks: [task("storage.schema")],
      },
    ],
  });
  assert.ok(
    issueMessages(duplicate).some((message) => /ID phase\.foundation is duplicated/u.test(message)),
  );
  assert.ok(
    issueMessages(duplicate).some((message) => /ID storage\.schema is duplicated/u.test(message)),
  );

  const missingDependency = roadmap({
    phases: [
      {
        ...roadmap().phases[0],
        tasks: [task("storage.schema", { dependencyIds: ["missing.task"] })],
      },
    ],
  });
  assert.ok(
    issueMessages(missingDependency).some((message) =>
      /storage\.schema depends on missing task missing\.task/u.test(message),
    ),
  );

  const cycle = roadmap({
    phases: [
      {
        ...roadmap().phases[0],
        tasks: [
          task("cycle.a", { dependencyIds: ["cycle.b"] }),
          task("cycle.b", { dependencyIds: ["cycle.a"] }),
        ],
      },
    ],
  });
  assert.ok(
    issueMessages(cycle).some((message) =>
      /dependency cycle includes: cycle\.a, cycle\.b/u.test(message),
    ),
  );

  const noAcceptance = roadmap({
    phases: [
      {
        ...roadmap().phases[0],
        tasks: [task("unsafe.task", { acceptanceCriteria: [], expectedValidators: [] })],
      },
    ],
  });
  assert.ok(
    issueMessages(noAcceptance).some((message) =>
      /must define at least one concrete acceptance/u.test(message),
    ),
  );
  assert.ok(
    issueMessages(noAcceptance).some((message) =>
      /must name at least one expected validator/u.test(message),
    ),
  );

  const emptyRequired = roadmap({
    phases: [
      {
        id: "phase.empty",
        title: "Empty",
        goal: "This invalid required phase has no work.",
        required: true,
        completionCriteria: [],
        tasks: [],
      },
    ],
  });
  assert.ok(
    issueMessages(emptyRequired).some((message) => /must contain at least one task/u.test(message)),
  );
  assert.ok(
    issueMessages(emptyRequired).some((message) =>
      /must define explicit completion criteria/u.test(message),
    ),
  );
});

test("strict roadmap schema rejects unknown fields, unsupported versions, and unstable IDs", () => {
  assert.equal(
    masterRoadmapSchema.safeParse({ ...roadmap(), providerPrompt: "hidden" }).success,
    false,
  );
  assert.equal(masterRoadmapSchema.safeParse({ ...roadmap(), formatVersion: 2 }).success, false);
  const unstable = roadmap({
    phases: [{ ...roadmap().phases[0], id: "phase with spaces" }],
  });
  assert.equal(masterRoadmapSchema.safeParse(unstable).success, false);
});

test("ROADMAP.md clearly renders phases, dependencies, risks, validators, and criteria", () => {
  const parsed = masterRoadmapSchema.parse(roadmap());
  const markdown = renderMasterRoadmapMarkdown(parsed);

  assert.match(markdown, /^# Master Roadmap\n/u);
  assert.match(markdown, /## Phase 1: Foundation/u);
  assert.match(markdown, /### product\.e2e — Deliver product\.e2e/u);
  assert.match(markdown, /Dependencies: `inventory\.crud`, `report\.low-stock`/u);
  assert.match(markdown, /Risk: \*\*HIGH\*\*/u);
  assert.match(markdown, /Expected validators: `end_to_end`, `acceptance`/u);
  assert.match(markdown, /#### Phase completion criteria/u);
  assert.deepEqual(parseMasterRoadmapMarkdown(markdown), parsed);
  assert.equal(renderMasterRoadmapMarkdown(parsed), markdown);
});

test("a sample project is deterministically topologically scheduled from dependency edges", () => {
  const parsed = masterRoadmapSchema.parse(roadmap());
  const schedule = topologicallyScheduleRoadmap(parsed);
  const positions = new Map(schedule.map(({ taskId }, index) => [taskId, index]));

  for (const phase of parsed.phases) {
    for (const scheduledTask of phase.tasks) {
      for (const dependencyId of scheduledTask.dependencyIds) {
        assert.ok(positions.get(dependencyId) < positions.get(scheduledTask.id));
      }
    }
  }
  assert.deepEqual(
    schedule.map(({ phaseId, taskId }) => `${phaseId}:${taskId}`),
    [
      "phase.foundation:storage.schema",
      "phase.product:inventory.crud",
      "phase.product:report.low-stock",
      "phase.product:product.e2e",
    ],
  );
});

test("roadmap generation refuses unresolved critical ambiguity and contradictions", async () => {
  let calls = 0;
  const generator = new MasterRoadmapGenerator({
    propose: async () => {
      calls += 1;
      return roadmap();
    },
  });
  const unresolved = specification({
    unresolvedQuestions: [
      {
        id: "security.boundary",
        question: "May inventory data leave the device?",
        category: "security_privacy",
        impact: "high",
      },
    ],
  });
  await assert.rejects(
    generator.generate(unresolved),
    (error) =>
      error instanceof MasterRoadmapError &&
      error.code === "USER_CONFIGURATION_ERROR" &&
      /security\.boundary/u.test(error.message),
  );

  const contradictory = specification({
    requiredFeatures: ["Offline operation"],
    nonGoals: [" offline operation "],
  });
  await assert.rejects(generator.generate(contradictory), /REQUIRED_FEATURE_IS_NON_GOAL/u);
  assert.equal(calls, 0);
});

test("Core rejects malformed agent roadmaps and any changed project goal", async () => {
  const malformedAdapter = new FakeAgentAdapter({
    finalMessage: JSON.stringify({
      ...roadmap(),
      phases: [
        {
          ...roadmap().phases[0],
          tasks: [task("broken.task", { dependencyIds: ["missing.task"] })],
        },
      ],
    }),
  });
  const malformedGenerator = new MasterRoadmapGenerator(
    new AgentAdapterMasterRoadmapAgent(malformedAdapter, { cwd: process.cwd() }),
  );
  await assert.rejects(
    malformedGenerator.generate(specification()),
    (error) =>
      error instanceof MasterRoadmapError &&
      error.code === "PROCESS_FAILURE" &&
      /broken\.task depends on missing task missing\.task/u.test(error.message),
  );

  const changedGoal = new MasterRoadmapGenerator({
    propose: async () => ({ ...roadmap(), projectGoal: "A weaker, different project." }),
  });
  await assert.rejects(
    changedGoal.generate(specification()),
    (error) => error instanceof MasterRoadmapError && error.code === "INTERNAL_INVARIANT_VIOLATION",
  );

  const fenced = new MasterRoadmapGenerator(
    new AgentAdapterMasterRoadmapAgent(
      new FakeAgentAdapter({ finalMessage: `\`\`\`json\n${JSON.stringify(roadmap())}\n\`\`\`` }),
      { cwd: process.cwd() },
    ),
  );
  await assert.rejects(
    fenced.generate(specification()),
    (error) => error instanceof MasterRoadmapError && error.code === "PROCESS_FAILURE",
  );
});

test("Master roadmap adapter preserves stable failure classifications", async () => {
  const generator = new MasterRoadmapGenerator(
    new AgentAdapterMasterRoadmapAgent(
      new FakeAgentAdapter({
        outcome: "failed",
        error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in with the official client" },
      }),
      { cwd: process.cwd() },
    ),
  );

  await assert.rejects(
    generator.generate(specification()),
    (error) => error instanceof MasterRoadmapError && error.code === "AUTHENTICATION_REQUIRED",
  );
});
