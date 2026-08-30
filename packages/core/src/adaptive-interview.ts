import { randomUUID } from "node:crypto";

import { isTerminalAgentEvent, type AgentAdapter } from "@densa-ade/agent-sdk";
import {
  interviewAgentProposalOutputSchema,
  interviewAgentProposalSchema,
  interviewAnswerSchema,
  interviewQuestionSchema,
  projectSpecificationSchema,
  type InterviewAgentProposal,
  type InterviewAnswer,
  type InterviewQuestion,
  type DensaAdeErrorCode,
  type ProjectSpecification,
  type SpecificationListField,
} from "@densa-ade/protocol";

import {
  detectSpecificationContradictions,
  renderProjectSpecificationMarkdown,
  type SpecificationContradiction,
} from "./project-specification.js";

const SPECIFICATION_LIST_FIELDS = [
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
] as const satisfies readonly SpecificationListField[];

const IMPACT_PRIORITY = { high: 0, medium: 1, low: 2 } as const;
const CATEGORY_PRIORITY = {
  architecture: 0,
  security_privacy: 1,
  data_storage: 2,
  integration: 3,
  platform_runtime: 4,
  deployment: 5,
  user_journey: 6,
  feature_scope: 7,
  other: 8,
  ux: 9,
} as const;

export interface InitialInterviewRequest {
  readonly stage: "initial";
  readonly initialIdea: string;
}

export interface AnswerInterviewRequest {
  readonly stage: "answers";
  readonly initialIdea: string;
  readonly specification: ProjectSpecification;
  readonly answers: readonly InterviewAnswer[];
}

export type MasterInterviewRequest = InitialInterviewRequest | AnswerInterviewRequest;

/** Model-neutral Master-role boundary. Implementations return proposals; Core owns validation. */
export interface MasterInterviewAgent {
  propose(request: MasterInterviewRequest): Promise<InterviewAgentProposal>;
}

export class AdaptiveInterviewError extends Error {
  readonly code: DensaAdeErrorCode;

  constructor(code: DensaAdeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdaptiveInterviewError";
    this.code = code;
  }
}

export interface AgentAdapterMasterInterviewOptions {
  readonly cwd: string;
  readonly runIdFactory?: () => string;
}

/**
 * Converts the provider-neutral AgentAdapter stream into the Master interview contract.
 * The agent's final message must be one exact JSON document; prose and fenced JSON fail closed.
 */
export class AgentAdapterMasterInterviewAgent implements MasterInterviewAgent {
  private readonly cwd: string;
  private readonly runIdFactory: () => string;

  constructor(
    private readonly adapter: AgentAdapter,
    options: AgentAdapterMasterInterviewOptions,
  ) {
    if (options.cwd.trim().length === 0) {
      throw new AdaptiveInterviewError(
        "USER_CONFIGURATION_ERROR",
        "Master interview working directory must not be empty",
      );
    }
    this.cwd = options.cwd;
    this.runIdFactory = options.runIdFactory ?? (() => `master-interview-${randomUUID()}`);
  }

  async propose(request: MasterInterviewRequest): Promise<InterviewAgentProposal> {
    let terminalCount = 0;
    let finalMessage: string | undefined;
    let failureMessage: string | undefined;
    let failureCode: DensaAdeErrorCode = "PROCESS_FAILURE";

    for await (const event of this.adapter.execute({
      runId: this.runIdFactory(),
      cwd: this.cwd,
      prompt: buildMasterInterviewPrompt(request),
      outputSchema: interviewAgentProposalOutputSchema,
    })) {
      if (!isTerminalAgentEvent(event)) continue;
      terminalCount += 1;
      if (event.outcome === "succeeded") finalMessage = event.finalMessage;
      else {
        failureCode = event.error?.code ?? "PROCESS_FAILURE";
        failureMessage = event.error?.message ?? `Master interview run ended ${event.outcome}`;
      }
    }

    if (terminalCount !== 1) {
      throw new AdaptiveInterviewError(
        "PROCESS_FAILURE",
        `Master interview run produced ${terminalCount} terminal events; expected exactly one`,
      );
    }
    if (failureMessage !== undefined) {
      throw new AdaptiveInterviewError(failureCode, failureMessage);
    }
    if (finalMessage === undefined) {
      throw new AdaptiveInterviewError(
        "PROCESS_FAILURE",
        "Master interview run succeeded without a structured final response",
      );
    }

    try {
      return interviewAgentProposalSchema.parse(JSON.parse(finalMessage));
    } catch (error) {
      throw new AdaptiveInterviewError(
        "PROCESS_FAILURE",
        "Master interview final response is not a valid version 1 proposal",
        { cause: error },
      );
    }
  }
}

export interface InterviewQuestionBatch {
  readonly id: string;
  readonly topic: string;
  readonly questions: readonly InterviewQuestion[];
}

export interface InterviewReadiness {
  readonly readyForRoadmap: boolean;
  readonly blockingQuestionIds: readonly string[];
  readonly contradictions: readonly SpecificationContradiction[];
}

export interface InterviewSnapshot {
  readonly initialIdea: string;
  readonly specification: ProjectSpecification;
  readonly specificationMarkdown: string;
  readonly questions: readonly InterviewQuestion[];
  readonly questionBatches: readonly InterviewQuestionBatch[];
  readonly readiness: InterviewReadiness;
}

export interface AnswerInterviewBatchInput {
  readonly snapshot: InterviewSnapshot;
  readonly batchId: string;
  readonly answers: readonly InterviewAnswer[];
}

function assertText(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new AdaptiveInterviewError("USER_CONFIGURATION_ERROR", `${name} must not be empty`);
  }
  return value;
}

function buildMasterInterviewPrompt(request: MasterInterviewRequest): string {
  const sourceRules =
    request.stage === "initial"
      ? [
          'Every addition source must be {"kind":"initial_idea"}.',
          "Every addition value must be an exact, contiguous substring of the initial idea.",
        ]
      : [
          'Every addition source must be {"kind":"answer","questionId":"..."} for one supplied answer.',
          "Every addition value must be an exact, contiguous substring of that answer.",
          "Return only newly discovered questions; Core retains every unanswered prior question.",
        ];
  const payload =
    request.stage === "initial"
      ? { stage: request.stage, initialIdea: request.initialIdea }
      : {
          stage: request.stage,
          initialIdea: request.initialIdea,
          currentSpecification: request.specification,
          answers: request.answers,
        };

  return [
    "You are the Master-role adaptive interview analyst for Densa ADE.",
    "Analyze only the supplied project idea and answers. Do not use a fixed questionnaire.",
    "Ask only questions that materially change scope, architecture, security/privacy, data, integrations, runtime, deployment, or core journeys.",
    "Give high-impact architecture, security/privacy, data, and integration ambiguity priority over cosmetic UX choices.",
    "Use the same batchKey for closely related questions. Propose a clear default when reasonable and explain it.",
    "Never add a major requirement, constraint, integration, or user decision that the user did not state.",
    ...sourceRules,
    "Return exactly one JSON object and no Markdown or commentary.",
    "The object shape is:",
    '{"formatVersion":1,"additions":[{"field":"targetUsers|coreUserJourneys|requiredFeatures|nonGoals|architectureConstraints|platformRuntimeConstraints|integrations|dataStorageNeeds|securityPrivacyRequirements|uxConstraints|deploymentIntent","value":"verbatim source substring","source":{"kind":"initial_idea"} OR {"kind":"answer","questionId":"id"}}],"questions":[{"id":"stable.id","question":"text","category":"architecture|security_privacy|data_storage|integration|platform_runtime|deployment|user_journey|feature_scope|ux|other","impact":"high|medium|low","context":"text or null","proposedDefault":"text or null","defaultRationale":"text or null","defaultCanBeUsedWithoutAnswer":"boolean or null","batchKey":"related topic"}]}',
    "Use null for optional question fields when no context or reasonable default exists. High-impact questions must never set defaultCanBeUsedWithoutAnswer to true.",
    "Input:",
    JSON.stringify(payload),
  ].join("\n");
}

function compareQuestions(
  left: { readonly question: InterviewQuestion; readonly index: number },
  right: { readonly question: InterviewQuestion; readonly index: number },
): number {
  return (
    IMPACT_PRIORITY[left.question.impact] - IMPACT_PRIORITY[right.question.impact] ||
    CATEGORY_PRIORITY[left.question.category] - CATEGORY_PRIORITY[right.question.category] ||
    left.index - right.index ||
    left.question.id.localeCompare(right.question.id)
  );
}

function rankQuestions(questions: readonly InterviewQuestion[]): readonly InterviewQuestion[] {
  return Object.freeze(
    questions
      .map((question, index) => ({ question: interviewQuestionSchema.parse(question), index }))
      .toSorted(compareQuestions)
      .map(({ question }) => question),
  );
}

function batchQuestions(
  questions: readonly InterviewQuestion[],
): readonly InterviewQuestionBatch[] {
  const grouped = new Map<string, InterviewQuestion[]>();
  for (const question of questions) {
    const group = grouped.get(question.batchKey) ?? [];
    group.push(question);
    grouped.set(question.batchKey, group);
  }
  return Object.freeze(
    [...grouped.entries()].map(([topic, groupedQuestions]) =>
      Object.freeze({
        id: `batch.${groupedQuestions[0]?.id ?? "empty"}`,
        topic,
        questions: Object.freeze(groupedQuestions),
      }),
    ),
  );
}

function unresolvedQuestion(
  question: InterviewQuestion,
): ProjectSpecification["unresolvedQuestions"][number] {
  return {
    id: question.id,
    question: question.question,
    category: question.category,
    impact: question.impact,
    ...(question.context === undefined ? {} : { context: question.context }),
    ...(question.proposedDefault === undefined
      ? {}
      : { proposedDefault: question.proposedDefault }),
    ...(question.defaultRationale === undefined
      ? {}
      : { defaultRationale: question.defaultRationale }),
    ...(question.defaultCanBeUsedWithoutAnswer === undefined
      ? {}
      : { defaultCanBeUsedWithoutAnswer: question.defaultCanBeUsedWithoutAnswer }),
    batchKey: question.batchKey,
  };
}

function evaluateReadiness(specification: ProjectSpecification): InterviewReadiness {
  const blockingQuestionIds = specification.unresolvedQuestions
    .filter(
      (question) =>
        question.impact === "high" ||
        (question.impact === "medium" && question.defaultCanBeUsedWithoutAnswer !== true),
    )
    .map(({ id }) => id);
  const contradictions = detectSpecificationContradictions(specification);
  return Object.freeze({
    readyForRoadmap: blockingQuestionIds.length === 0 && contradictions.length === 0,
    blockingQuestionIds: Object.freeze(blockingQuestionIds),
    contradictions,
  });
}

function snapshot(
  initialIdea: string,
  base: Omit<ProjectSpecification, "unresolvedQuestions">,
  inputQuestions: readonly InterviewQuestion[],
): InterviewSnapshot {
  const questions = rankQuestions(inputQuestions);
  const specification = projectSpecificationSchema.parse({
    ...base,
    unresolvedQuestions: questions.map(unresolvedQuestion),
  });
  return Object.freeze({
    initialIdea,
    specification,
    specificationMarkdown: renderProjectSpecificationMarkdown(specification),
    questions,
    questionBatches: batchQuestions(questions),
    readiness: evaluateReadiness(specification),
  });
}

function emptySpecification(
  initialIdea: string,
): Omit<ProjectSpecification, "unresolvedQuestions"> {
  return {
    formatVersion: 1,
    projectGoal: initialIdea,
    targetUsers: [],
    coreUserJourneys: [],
    requiredFeatures: [],
    nonGoals: [],
    architectureConstraints: [],
    platformRuntimeConstraints: [],
    integrations: [],
    dataStorageNeeds: [],
    securityPrivacyRequirements: [],
    uxConstraints: [],
    deploymentIntent: [],
    explicitUserDecisions: [],
  };
}

function addUnique(
  specification: Omit<ProjectSpecification, "unresolvedQuestions">,
  field: SpecificationListField,
  value: string,
): void {
  const values = specification[field] as string[];
  if (!values.includes(value)) values.push(value);
}

function mutableSpecification(
  specification: ProjectSpecification,
): Omit<ProjectSpecification, "unresolvedQuestions"> {
  const result = emptySpecification(specification.projectGoal);
  for (const field of SPECIFICATION_LIST_FIELDS) {
    (result[field] as string[]).push(...specification[field]);
  }
  result.explicitUserDecisions.push(...specification.explicitUserDecisions);
  return result;
}

function validateSnapshot(input: InterviewSnapshot): InterviewSnapshot {
  const initialIdea = assertText(input.initialIdea, "Interview snapshot initial idea");
  const specification = projectSpecificationSchema.parse(input.specification);
  const questions = input.questions.map((question) => interviewQuestionSchema.parse(question));
  const expectedQuestions = questions.map(unresolvedQuestion);
  const questionFields = [
    "id",
    "question",
    "category",
    "impact",
    "context",
    "proposedDefault",
    "defaultRationale",
    "defaultCanBeUsedWithoutAnswer",
    "batchKey",
  ] as const;
  const questionsMatch =
    specification.unresolvedQuestions.length === expectedQuestions.length &&
    specification.unresolvedQuestions.every((question, index) => {
      const expected = expectedQuestions[index];
      return (
        expected !== undefined &&
        questionFields.every((field) => question[field] === expected[field])
      );
    });
  if (specification.projectGoal !== initialIdea || !questionsMatch) {
    throw new AdaptiveInterviewError(
      "USER_CONFIGURATION_ERROR",
      "Interview snapshot does not match its authoritative specification questions",
    );
  }
  return snapshot(initialIdea, mutableSpecification(specification), questions);
}

export class AdaptiveInterviewPlanner {
  constructor(private readonly masterAgent: MasterInterviewAgent) {}

  /** Rebuild an ordered interview after Core restart from the persisted specification alone. */
  resume(input: ProjectSpecification): InterviewSnapshot {
    const specification = projectSpecificationSchema.parse(input);
    const questions = specification.unresolvedQuestions.map((question) =>
      interviewQuestionSchema.parse({
        ...question,
        batchKey: question.batchKey ?? question.id,
      }),
    );
    return snapshot(specification.projectGoal, mutableSpecification(specification), questions);
  }

  async start(initialIdeaInput: string): Promise<InterviewSnapshot> {
    const initialIdea = assertText(initialIdeaInput, "Initial project idea");
    const proposal = interviewAgentProposalSchema.parse(
      await this.masterAgent.propose({ stage: "initial", initialIdea }),
    );
    const specification = emptySpecification(initialIdea);
    for (const addition of proposal.additions) {
      if (addition.source.kind !== "initial_idea" || !initialIdea.includes(addition.value)) {
        throw new AdaptiveInterviewError(
          "INTERNAL_INVARIANT_VIOLATION",
          `Initial interview addition for ${addition.field} is not verbatim source text`,
        );
      }
      addUnique(specification, addition.field, addition.value);
    }
    return snapshot(initialIdea, specification, proposal.questions);
  }

  async answerBatch(input: AnswerInterviewBatchInput): Promise<InterviewSnapshot> {
    const currentSnapshot = validateSnapshot(input.snapshot);
    const nextBatch = currentSnapshot.questionBatches[0];
    if (nextBatch === undefined || nextBatch.id !== input.batchId) {
      throw new AdaptiveInterviewError(
        "USER_CONFIGURATION_ERROR",
        "Answers must target the current highest-priority interview batch",
      );
    }

    const answers = input.answers.map((answer) => interviewAnswerSchema.parse(answer));
    const answersById = new Map<string, InterviewAnswer>();
    for (const answer of answers) {
      if (answersById.has(answer.questionId)) {
        throw new AdaptiveInterviewError(
          "USER_CONFIGURATION_ERROR",
          `Question ${answer.questionId} was answered more than once`,
        );
      }
      answersById.set(answer.questionId, answer);
    }
    const expectedIds = new Set(nextBatch.questions.map(({ id }) => id));
    if (
      answersById.size !== expectedIds.size ||
      [...answersById.keys()].some((id) => !expectedIds.has(id))
    ) {
      throw new AdaptiveInterviewError(
        "USER_CONFIGURATION_ERROR",
        "Every question in the current batch must have exactly one answer",
      );
    }

    const proposal = interviewAgentProposalSchema.parse(
      await this.masterAgent.propose({
        stage: "answers",
        initialIdea: currentSnapshot.initialIdea,
        specification: currentSnapshot.specification,
        answers,
      }),
    );
    const specification = mutableSpecification(currentSnapshot.specification);

    for (const question of nextBatch.questions) {
      const answer = answersById.get(question.id);
      if (answer === undefined) {
        throw new AdaptiveInterviewError(
          "INTERNAL_INVARIANT_VIOLATION",
          `Validated answer for ${question.id} disappeared`,
        );
      }
      specification.explicitUserDecisions.push({
        topic: question.question,
        decision: answer.answer,
      });
    }

    for (const addition of proposal.additions) {
      if (addition.source.kind !== "answer") {
        throw new AdaptiveInterviewError(
          "INTERNAL_INVARIANT_VIOLATION",
          `Answer interview addition for ${addition.field} has the wrong source`,
        );
      }
      const answer = answersById.get(addition.source.questionId);
      if (answer === undefined || !answer.answer.includes(addition.value)) {
        throw new AdaptiveInterviewError(
          "INTERNAL_INVARIANT_VIOLATION",
          `Answer interview addition for ${addition.field} is not verbatim source text`,
        );
      }
      addUnique(specification, addition.field, addition.value);
    }

    const answeredIds = new Set(answersById.keys());
    const survivingQuestions = currentSnapshot.questions.filter(
      (question) => !answeredIds.has(question.id),
    );
    const knownIds = new Set(currentSnapshot.questions.map(({ id }) => id));
    for (const question of proposal.questions) {
      if (knownIds.has(question.id)) {
        throw new AdaptiveInterviewError(
          "INTERNAL_INVARIANT_VIOLATION",
          `Master interview attempted to replace or resurrect question ${question.id}`,
        );
      }
    }

    return snapshot(currentSnapshot.initialIdea, specification, [
      ...survivingQuestions,
      ...proposal.questions,
    ]);
  }
}
