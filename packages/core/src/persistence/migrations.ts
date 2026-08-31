import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface SchemaMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const initialSchema = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  name TEXT NOT NULL CHECK (length(name) > 0),
  state TEXT NOT NULL CHECK (state IN (
    'DRAFT', 'PLANNING', 'READY', 'RUNNING', 'PAUSED', 'WAITING_FOR_USER',
    'WAITING_FOR_USAGE', 'BLOCKED', 'COMPLETED', 'FAILED'
  )),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('guided', 'phase', 'continuous')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20)
) STRICT;

CREATE TABLE specifications (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20)
) STRICT;

CREATE TABLE phases (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) > 0),
  state TEXT NOT NULL CHECK (state IN (
    'PENDING', 'READY', 'RUNNING', 'VALIDATING', 'AWAITING_APPROVAL', 'COMPLETED', 'BLOCKED'
  )),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  UNIQUE (project_id, position),
  UNIQUE (project_id, id)
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) > 0),
  state TEXT NOT NULL CHECK (state IN (
    'PENDING', 'READY', 'RUNNING', 'VALIDATING', 'RETRYING', 'WAITING_FOR_USER',
    'WAITING_FOR_USAGE', 'BLOCKED', 'INTERRUPTED', 'COMPLETED', 'CANCELLED'
  )),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  FOREIGN KEY (project_id, phase_id) REFERENCES phases(project_id, id) ON DELETE CASCADE,
  UNIQUE (phase_id, position),
  UNIQUE (project_id, id),
  UNIQUE (project_id, phase_id, id)
) STRICT;

CREATE TABLE task_dependencies (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  dependency_task_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (task_id, dependency_task_id),
  UNIQUE (task_id, position),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, dependency_task_id) REFERENCES tasks(project_id, id) ON DELETE RESTRICT,
  CHECK (task_id <> dependency_task_id)
) STRICT;

CREATE TABLE acceptance_criteria (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  description TEXT NOT NULL CHECK (length(description) > 0),
  PRIMARY KEY (task_id, position),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number > 0),
  started_at TEXT NOT NULL CHECK (length(started_at) >= 20),
  completed_at TEXT CHECK (completed_at IS NULL OR length(completed_at) >= 20),
  UNIQUE (task_id, number),
  UNIQUE (task_id, id)
) STRICT;

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
  adapter_id TEXT NOT NULL CHECK (length(adapter_id) > 0),
  started_at TEXT NOT NULL CHECK (length(started_at) >= 20),
  completed_at TEXT CHECK (completed_at IS NULL OR length(completed_at) >= 20),
  adapter_run_id TEXT CHECK (adapter_run_id IS NULL OR length(adapter_run_id) > 0)
) STRICT;

CREATE TABLE validation_runs (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT,
  validator_id TEXT NOT NULL CHECK (length(validator_id) > 0),
  started_at TEXT NOT NULL CHECK (length(started_at) >= 20),
  completed_at TEXT CHECK (completed_at IS NULL OR length(completed_at) >= 20),
  passed INTEGER CHECK (passed IS NULL OR passed IN (0, 1)),
  FOREIGN KEY (task_id, attempt_id) REFERENCES attempts(task_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE decisions (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) > 0),
  rationale TEXT NOT NULL CHECK (length(rationale) > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20)
) STRICT;

CREATE TABLE roadmap_revisions (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  classification TEXT NOT NULL CHECK (classification IN ('minor', 'significant', 'scope')),
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  actor TEXT NOT NULL CHECK (length(actor) > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  affected_phase_ids_json TEXT NOT NULL CHECK (json_valid(affected_phase_ids_json)),
  affected_task_ids_json TEXT NOT NULL CHECK (json_valid(affected_task_ids_json)),
  old_value_json TEXT NOT NULL CHECK (json_valid(old_value_json)),
  new_value_json TEXT NOT NULL CHECK (json_valid(new_value_json))
) STRICT;

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  description TEXT CHECK (description IS NULL OR length(description) > 0)
) STRICT;

CREATE TABLE events (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id TEXT,
  task_id TEXT,
  type TEXT NOT NULL CHECK (type GLOB '[A-Z]*'),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) >= 20),
  actor TEXT NOT NULL CHECK (length(actor) > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  FOREIGN KEY (project_id, phase_id) REFERENCES phases(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, phase_id, task_id)
    REFERENCES tasks(project_id, phase_id, id) ON DELETE CASCADE,
  CHECK (task_id IS NULL OR phase_id IS NOT NULL)
) STRICT;

CREATE TRIGGER events_are_append_only_on_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_are_append_only_on_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE project_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  values_json TEXT NOT NULL CHECK (json_valid(values_json)),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20)
) STRICT;
`;

const orderedEventJournal = `
DROP TRIGGER events_are_append_only_on_update;
DROP TRIGGER events_are_append_only_on_delete;

CREATE TABLE events_v2 (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  phase_id TEXT,
  task_id TEXT,
  type TEXT NOT NULL CHECK (type GLOB '[A-Z]*'),
  event_version INTEGER NOT NULL CHECK (event_version > 0),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) >= 20),
  actor TEXT NOT NULL CHECK (length(actor) > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  FOREIGN KEY (project_id, phase_id) REFERENCES phases(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, phase_id, task_id)
    REFERENCES tasks(project_id, phase_id, id) ON DELETE CASCADE,
  UNIQUE (project_id, sequence_number),
  CHECK (task_id IS NULL OR phase_id IS NOT NULL)
) STRICT;

INSERT INTO events_v2 (
  id, project_id, sequence_number, phase_id, task_id, type, event_version,
  occurred_at, actor, payload_json
)
SELECT
  event.id,
  event.project_id,
  (
    SELECT COUNT(*)
    FROM events AS preceding
    WHERE preceding.project_id = event.project_id
      AND (
        preceding.occurred_at < event.occurred_at
        OR (preceding.occurred_at = event.occurred_at AND preceding.id <= event.id)
      )
  ),
  event.phase_id,
  event.task_id,
  event.type,
  event.schema_version,
  event.occurred_at,
  event.actor,
  event.payload_json
FROM events AS event;

DROP TABLE events;
ALTER TABLE events_v2 RENAME TO events;

CREATE INDEX events_project_phase_sequence
  ON events (project_id, phase_id, sequence_number);
CREATE INDEX events_project_task_sequence
  ON events (project_id, task_id, sequence_number);
CREATE INDEX events_project_type_sequence
  ON events (project_id, type, sequence_number);

CREATE TRIGGER events_are_append_only_on_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_are_append_only_on_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
`;

const recoveryMetadata = `
ALTER TABLE agent_runs ADD COLUMN process_id INTEGER
  CHECK (process_id IS NULL OR (process_id > 0 AND process_id <= 2147483647));
ALTER TABLE agent_runs ADD COLUMN process_identity TEXT
  CHECK (process_identity IS NULL OR length(process_identity) > 0);
ALTER TABLE checkpoints ADD COLUMN git_head TEXT
  CHECK (git_head IS NULL OR length(git_head) > 0);
ALTER TABLE checkpoints ADD COLUMN git_status TEXT;
ALTER TABLE checkpoints ADD COLUMN workspace_fingerprint TEXT
  CHECK (workspace_fingerprint IS NULL OR length(workspace_fingerprint) > 0);
`;

const runBranchesAndTaskCheckpoints = `
CREATE TABLE densa_run_branches (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  workspace_path TEXT NOT NULL CHECK (length(workspace_path) > 0),
  branch_name TEXT NOT NULL UNIQUE CHECK (branch_name GLOB 'densa/run/*'),
  source_branch TEXT NOT NULL CHECK (length(source_branch) > 0),
  starting_commit TEXT NOT NULL CHECK (length(starting_commit) > 0),
  status TEXT NOT NULL CHECK (status IN ('CREATING', 'ACTIVE', 'FAILED')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  activated_at TEXT CHECK (activated_at IS NULL OR length(activated_at) >= 20),
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) > 0),
  CHECK ((status = 'ACTIVE') = (activated_at IS NOT NULL)),
  CHECK ((status = 'FAILED') = (failure_reason IS NOT NULL))
) STRICT;

CREATE TABLE checkpoints_v4 (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT,
  attempt_id TEXT UNIQUE,
  run_branch TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  description TEXT CHECK (description IS NULL OR length(description) > 0),
  git_head TEXT CHECK (git_head IS NULL OR length(git_head) > 0),
  git_status TEXT,
  workspace_fingerprint TEXT CHECK (
    workspace_fingerprint IS NULL OR length(workspace_fingerprint) > 0
  ),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (task_id, attempt_id) REFERENCES attempts(task_id, id) ON DELETE CASCADE,
  FOREIGN KEY (run_branch) REFERENCES densa_run_branches(branch_name) ON DELETE RESTRICT,
  CHECK (
    (task_id IS NULL AND attempt_id IS NULL AND run_branch IS NULL)
    OR
    (task_id IS NOT NULL AND attempt_id IS NOT NULL AND run_branch IS NOT NULL AND git_head IS NOT NULL)
  )
) STRICT;

INSERT INTO checkpoints_v4
  (id, project_id, created_at, description, git_head, git_status, workspace_fingerprint)
SELECT id, project_id, created_at, description, git_head, git_status, workspace_fingerprint
FROM checkpoints;

DROP TABLE checkpoints;
ALTER TABLE checkpoints_v4 RENAME TO checkpoints;

CREATE INDEX checkpoints_project_created ON checkpoints (project_id, created_at, id);
CREATE INDEX checkpoints_task_created ON checkpoints (task_id, created_at, id);
`;

const atomicTaskCommits = `
ALTER TABLE attempts ADD COLUMN commit_sha TEXT
  CHECK (commit_sha IS NULL OR length(commit_sha) > 0);

CREATE TABLE task_commit_intents (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL CHECK (length(workspace_path) > 0),
  branch_name TEXT NOT NULL REFERENCES densa_run_branches(branch_name) ON DELETE RESTRICT,
  expected_head TEXT NOT NULL CHECK (length(expected_head) > 0),
  commit_message TEXT NOT NULL CHECK (length(commit_message) > 0),
  intended_paths_json TEXT NOT NULL CHECK (json_valid(intended_paths_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  commit_sha TEXT CHECK (commit_sha IS NULL OR length(commit_sha) > 0),
  committed_at TEXT CHECK (committed_at IS NULL OR length(committed_at) >= 20),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (task_id, attempt_id) REFERENCES attempts(task_id, id) ON DELETE CASCADE,
  CHECK ((commit_sha IS NULL) = (committed_at IS NULL))
) STRICT;

CREATE INDEX task_commit_intents_project_created
  ON task_commit_intents (project_id, created_at, attempt_id);
`;

const boundedAttemptRollbacks = `
CREATE TABLE attempt_rollback_plans (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
  agent_run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL CHECK (length(workspace_path) > 0),
  branch_name TEXT NOT NULL REFERENCES densa_run_branches(branch_name) ON DELETE RESTRICT,
  checkpoint_head TEXT NOT NULL CHECK (length(checkpoint_head) > 0),
  owned_paths_json TEXT NOT NULL CHECK (json_valid(owned_paths_json)),
  diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json)),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) >= 20),
  failure_recorded_at TEXT CHECK (
    failure_recorded_at IS NULL OR length(failure_recorded_at) >= 20
  ),
  applied_at TEXT CHECK (applied_at IS NULL OR length(applied_at) >= 20),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (task_id, attempt_id) REFERENCES attempts(task_id, id) ON DELETE CASCADE,
  CHECK (
    (failure_recorded_at IS NULL AND diagnostics_json = '{}')
    OR failure_recorded_at IS NOT NULL
  ),
  CHECK (applied_at IS NULL OR failure_recorded_at IS NOT NULL)
) STRICT;

CREATE INDEX attempt_rollback_plans_project_recorded
  ON attempt_rollback_plans (project_id, recorded_at, attempt_id);
`;

const structuredProjectSpecifications = `
CREATE TABLE specifications_v2 (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  specification_json TEXT NOT NULL CHECK (
    json_valid(specification_json)
    AND json_extract(specification_json, '$.formatVersion') = 1
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20)
) STRICT;

INSERT INTO specifications_v2 (project_id, specification_json, created_at, updated_at)
SELECT
  project_id,
  json_object(
    'formatVersion', 1,
    'projectGoal', CASE
      WHEN length(trim(content)) > 0 THEN content
      ELSE 'No project goal was recorded in the legacy specification.'
    END,
    'targetUsers', json('[]'),
    'coreUserJourneys', json('[]'),
    'requiredFeatures', json('[]'),
    'nonGoals', json('[]'),
    'architectureConstraints', json('[]'),
    'platformRuntimeConstraints', json('[]'),
    'integrations', json('[]'),
    'dataStorageNeeds', json('[]'),
    'securityPrivacyRequirements', json('[]'),
    'uxConstraints', json('[]'),
    'deploymentIntent', json('[]'),
    'explicitUserDecisions', json('[]'),
    'unresolvedQuestions', json('[]')
  ),
  created_at,
  updated_at
FROM specifications;

DROP TABLE specifications;
ALTER TABLE specifications_v2 RENAME TO specifications;
`;

const auditedRoadmapMutations = `
CREATE TABLE master_roadmaps (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  roadmap_json TEXT NOT NULL CHECK (
    json_valid(roadmap_json)
    AND json_extract(roadmap_json, '$.formatVersion') = 1
  ),
  revision_number INTEGER NOT NULL CHECK (revision_number >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20)
) STRICT;

ALTER TABLE roadmap_revisions ADD COLUMN session_id TEXT
  CHECK (session_id IS NULL OR length(session_id) > 0);
ALTER TABLE roadmap_revisions ADD COLUMN operation_json TEXT
  CHECK (operation_json IS NULL OR json_valid(operation_json));
ALTER TABLE roadmap_revisions ADD COLUMN approval_json TEXT
  CHECK (approval_json IS NULL OR json_valid(approval_json));

CREATE INDEX roadmap_revisions_project_created
  ON roadmap_revisions (project_id, created_at, id);
`;

const durablePhaseReports = `
CREATE TABLE phase_reports (
  phase_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('blocked', 'awaiting_approval', 'completed')),
  report_path TEXT NOT NULL CHECK (report_path GLOB '.densa/reports/*.md'),
  report_json TEXT NOT NULL CHECK (
    json_valid(report_json)
    AND json_extract(report_json, '$.formatVersion') = 1
  ),
  generated_at TEXT NOT NULL CHECK (length(generated_at) >= 20),
  FOREIGN KEY (project_id, phase_id) REFERENCES phases(project_id, id) ON DELETE CASCADE,
  UNIQUE (project_id, report_path)
) STRICT;

CREATE INDEX phase_reports_project_generated
  ON phase_reports (project_id, generated_at, phase_id);
`;

const validatorPluginFramework = `
ALTER TABLE validation_runs ADD COLUMN plan_id TEXT
  CHECK (plan_id IS NULL OR length(plan_id) > 0);
ALTER TABLE validation_runs ADD COLUMN plan_version TEXT
  CHECK (plan_version IS NULL OR length(plan_version) > 0);

CREATE TABLE validation_results (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  validation_run_id TEXT NOT NULL REFERENCES validation_runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  validator_id TEXT NOT NULL CHECK (length(validator_id) > 0),
  validator_version TEXT NOT NULL CHECK (length(validator_version) > 0),
  policy TEXT NOT NULL CHECK (policy IN ('required', 'advisory')),
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'error', 'skipped')),
  started_at TEXT NOT NULL CHECK (length(started_at) >= 20),
  completed_at TEXT NOT NULL CHECK (length(completed_at) >= 20),
  command_json TEXT CHECK (command_json IS NULL OR json_valid(command_json)),
  config_json TEXT CHECK (config_json IS NULL OR json_valid(config_json)),
  exit_code INTEGER,
  diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json)),
  related_acceptance_criteria_json TEXT NOT NULL CHECK (
    json_valid(related_acceptance_criteria_json)
  ),
  retry_relevant INTEGER NOT NULL CHECK (retry_relevant IN (0, 1)),
  UNIQUE (validation_run_id, position),
  CHECK (completed_at >= started_at)
) STRICT;

CREATE INDEX validation_results_run_position
  ON validation_results (validation_run_id, position);
`;

const acceptanceCriteriaEvidence = `
ALTER TABLE validation_runs ADD COLUMN manual_review_criteria_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(manual_review_criteria_json));

ALTER TABLE validation_results ADD COLUMN evidence_source TEXT NOT NULL
  DEFAULT 'legacy_unspecified'
  CHECK (evidence_source IN (
    'legacy_unspecified', 'deterministic_validator', 'targeted_check', 'browser_test',
    'independent_review'
  ));

CREATE TABLE manual_acceptance_reviews (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  validation_run_id TEXT NOT NULL REFERENCES validation_runs(id) ON DELETE CASCADE,
  criterion_position INTEGER NOT NULL CHECK (criterion_position >= 0),
  criterion TEXT NOT NULL CHECK (length(criterion) > 0),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  actor TEXT NOT NULL CHECK (length(actor) > 0),
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) >= 20),
  UNIQUE (validation_run_id, criterion_position)
) STRICT;

CREATE INDEX manual_acceptance_reviews_run_position
  ON manual_acceptance_reviews (validation_run_id, criterion_position);
`;

const freshContextIndependentReview = `
CREATE TABLE independent_reviews (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT,
  phase_id TEXT,
  validation_run_id TEXT,
  validation_event_id TEXT,
  adapter_id TEXT NOT NULL CHECK (length(adapter_id) > 0),
  reviewer_run_id TEXT NOT NULL UNIQUE CHECK (length(reviewer_run_id) > 0),
  context_hash TEXT NOT NULL CHECK (length(context_hash) = 64),
  requested_at TEXT NOT NULL CHECK (length(requested_at) >= 20),
  completed_at TEXT CHECK (completed_at IS NULL OR length(completed_at) >= 20),
  output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, phase_id) REFERENCES phases(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (validation_run_id) REFERENCES validation_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (validation_event_id) REFERENCES events(id) ON DELETE CASCADE,
  CHECK ((task_id IS NOT NULL) <> (phase_id IS NOT NULL)),
  CHECK (
    (task_id IS NOT NULL AND validation_run_id IS NOT NULL AND validation_event_id IS NULL) OR
    (phase_id IS NOT NULL AND validation_event_id IS NOT NULL AND validation_run_id IS NULL)
  ),
  CHECK ((completed_at IS NULL) = (output_json IS NULL)),
  CHECK (completed_at IS NULL OR julianday(completed_at) >= julianday(requested_at))
) STRICT;

CREATE INDEX independent_reviews_project_requested
  ON independent_reviews (project_id, requested_at, id);
CREATE INDEX independent_reviews_task_requested
  ON independent_reviews (task_id, requested_at, id);
CREATE INDEX independent_reviews_phase_requested
  ON independent_reviews (phase_id, requested_at, id);
CREATE INDEX independent_reviews_validation_run
  ON independent_reviews (validation_run_id, requested_at, id);
CREATE INDEX independent_reviews_validation_event
  ON independent_reviews (validation_event_id, requested_at, id);
`;

const durableProjectDecisions = `
CREATE TABLE decisions_v13 (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'constraint')),
  statement TEXT NOT NULL CHECK (length(trim(statement)) > 0),
  title TEXT NOT NULL CHECK (length(title) > 0),
  rationale TEXT NOT NULL CHECK (length(rationale) > 0),
  category TEXT NOT NULL CHECK (length(trim(category)) > 0),
  source TEXT NOT NULL CHECK (source IN ('user', 'master', 'system')),
  scope TEXT NOT NULL CHECK (scope IN ('project', 'phase', 'task')),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  supersedes_id TEXT,
  affected_phase_ids_json TEXT NOT NULL CHECK (json_valid(affected_phase_ids_json)),
  affected_task_ids_json TEXT NOT NULL CHECK (json_valid(affected_task_ids_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  superseded_at TEXT CHECK (superseded_at IS NULL OR length(superseded_at) >= 20),
  UNIQUE (project_id, id),
  UNIQUE (supersedes_id),
  FOREIGN KEY (project_id, supersedes_id) REFERENCES decisions_v13(project_id, id) ON DELETE RESTRICT,
  CHECK (id <> supersedes_id),
  CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
  CHECK (scope <> 'phase' OR json_array_length(affected_phase_ids_json) > 0),
  CHECK (scope <> 'task' OR json_array_length(affected_task_ids_json) > 0)
) STRICT;

INSERT INTO decisions_v13 (
  id, project_id, kind, statement, title, rationale, category, source, scope, status,
  supersedes_id, affected_phase_ids_json, affected_task_ids_json, created_at, superseded_at
)
SELECT
  id, project_id, 'decision', title, title, rationale, 'legacy', 'system', 'project', 'active',
  NULL, '[]', '[]', created_at, NULL
FROM decisions;

DROP TABLE decisions;
ALTER TABLE decisions_v13 RENAME TO decisions;

CREATE INDEX decisions_project_status_created
  ON decisions (project_id, status, created_at, id);
CREATE INDEX decisions_project_kind_category
  ON decisions (project_id, kind, category, status, created_at, id);
`;

const masterRoadmapRevisionWorkflow = `
CREATE TABLE roadmap_revision_proposals (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  proposal_event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  base_revision_number INTEGER NOT NULL CHECK (base_revision_number >= 0),
  classification TEXT NOT NULL CHECK (classification IN ('minor', 'significant', 'scope')),
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) > 0),
  actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  session_id TEXT NOT NULL CHECK (length(trim(session_id)) > 0),
  operations_json TEXT NOT NULL CHECK (
    json_valid(operations_json) AND json_array_length(operations_json) BETWEEN 1 AND 32
  ),
  before_value_json TEXT NOT NULL CHECK (json_valid(before_value_json)),
  after_value_json TEXT NOT NULL CHECK (json_valid(after_value_json)),
  affected_phase_ids_json TEXT NOT NULL CHECK (json_valid(affected_phase_ids_json)),
  affected_task_ids_json TEXT NOT NULL CHECK (json_valid(affected_task_ids_json)),
  active_task_ids_json TEXT NOT NULL CHECK (json_valid(active_task_ids_json)),
  approval_required INTEGER NOT NULL CHECK (approval_required IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN (
    'awaiting_approval', 'waiting_for_safe_boundary', 'ready_to_apply',
    'applied', 'rejected', 'stale'
  )),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  resolved_at TEXT CHECK (resolved_at IS NULL OR length(resolved_at) >= 20),
  approval_decision_id TEXT REFERENCES decisions(id) ON DELETE RESTRICT,
  applied_revision_id TEXT UNIQUE REFERENCES roadmap_revisions(id) ON DELETE RESTRICT,
  UNIQUE (project_id, id),
  CHECK ((status IN ('applied', 'rejected', 'stale')) = (resolved_at IS NOT NULL)),
  CHECK ((status = 'applied') = (applied_revision_id IS NOT NULL)),
  CHECK (approval_decision_id IS NULL OR approval_required = 1),
  CHECK (status <> 'applied' OR approval_required = 0 OR approval_decision_id IS NOT NULL)
) STRICT;

CREATE INDEX roadmap_revision_proposals_project_created
  ON roadmap_revision_proposals (project_id, created_at, id);
CREATE INDEX roadmap_revision_proposals_project_status
  ON roadmap_revision_proposals (project_id, status, updated_at, id);
`;

const densaAdeMachineNamespaces = `
ALTER TABLE densa_run_branches RENAME TO densa_run_branches_legacy;

CREATE TABLE densa_run_branches (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  workspace_path TEXT NOT NULL CHECK (length(workspace_path) > 0),
  branch_name TEXT NOT NULL UNIQUE CHECK (
    branch_name GLOB 'densa-ade/run/*'
    OR branch_name GLOB 'densa/run/*'
  ),
  source_branch TEXT NOT NULL CHECK (length(source_branch) > 0),
  starting_commit TEXT NOT NULL CHECK (length(starting_commit) > 0),
  status TEXT NOT NULL CHECK (status IN ('CREATING', 'ACTIVE', 'FAILED')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  activated_at TEXT CHECK (activated_at IS NULL OR length(activated_at) >= 20),
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) > 0),
  CHECK ((status = 'ACTIVE') = (activated_at IS NOT NULL)),
  CHECK ((status = 'FAILED') = (failure_reason IS NOT NULL))
) STRICT;

INSERT INTO densa_run_branches
SELECT * FROM densa_run_branches_legacy;

CREATE TABLE checkpoints_v15 (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT,
  attempt_id TEXT UNIQUE,
  run_branch TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  description TEXT CHECK (description IS NULL OR length(description) > 0),
  git_head TEXT CHECK (git_head IS NULL OR length(git_head) > 0),
  git_status TEXT,
  workspace_fingerprint TEXT CHECK (
    workspace_fingerprint IS NULL OR length(workspace_fingerprint) > 0
  ),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (task_id, attempt_id) REFERENCES attempts(task_id, id) ON DELETE CASCADE,
  FOREIGN KEY (run_branch) REFERENCES densa_run_branches(branch_name) ON DELETE RESTRICT,
  CHECK (
    (task_id IS NULL AND attempt_id IS NULL AND run_branch IS NULL)
    OR
    (task_id IS NOT NULL AND attempt_id IS NOT NULL AND run_branch IS NOT NULL AND git_head IS NOT NULL)
  )
) STRICT;

INSERT INTO checkpoints_v15 SELECT * FROM checkpoints;
DROP TABLE checkpoints;
ALTER TABLE checkpoints_v15 RENAME TO checkpoints;
CREATE INDEX checkpoints_project_created ON checkpoints (project_id, created_at, id);
CREATE INDEX checkpoints_task_created ON checkpoints (task_id, created_at, id);

CREATE TABLE task_commit_intents_v15 (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL CHECK (length(workspace_path) > 0),
  branch_name TEXT NOT NULL REFERENCES densa_run_branches(branch_name) ON DELETE RESTRICT,
  expected_head TEXT NOT NULL CHECK (length(expected_head) > 0),
  commit_message TEXT NOT NULL CHECK (length(commit_message) > 0),
  intended_paths_json TEXT NOT NULL CHECK (json_valid(intended_paths_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  commit_sha TEXT CHECK (commit_sha IS NULL OR length(commit_sha) > 0),
  committed_at TEXT CHECK (committed_at IS NULL OR length(committed_at) >= 20),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (task_id, attempt_id) REFERENCES attempts(task_id, id) ON DELETE CASCADE,
  CHECK ((commit_sha IS NULL) = (committed_at IS NULL))
) STRICT;

INSERT INTO task_commit_intents_v15 SELECT * FROM task_commit_intents;
DROP TABLE task_commit_intents;
ALTER TABLE task_commit_intents_v15 RENAME TO task_commit_intents;
CREATE INDEX task_commit_intents_project_created
  ON task_commit_intents (project_id, created_at, attempt_id);

CREATE TABLE attempt_rollback_plans_v15 (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
  agent_run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL CHECK (length(workspace_path) > 0),
  branch_name TEXT NOT NULL REFERENCES densa_run_branches(branch_name) ON DELETE RESTRICT,
  checkpoint_head TEXT NOT NULL CHECK (length(checkpoint_head) > 0),
  owned_paths_json TEXT NOT NULL CHECK (json_valid(owned_paths_json)),
  diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json)),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) >= 20),
  failure_recorded_at TEXT CHECK (
    failure_recorded_at IS NULL OR length(failure_recorded_at) >= 20
  ),
  applied_at TEXT CHECK (applied_at IS NULL OR length(applied_at) >= 20),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (task_id, attempt_id) REFERENCES attempts(task_id, id) ON DELETE CASCADE,
  CHECK (
    (failure_recorded_at IS NULL AND diagnostics_json = '{}')
    OR failure_recorded_at IS NOT NULL
  ),
  CHECK (applied_at IS NULL OR failure_recorded_at IS NOT NULL)
) STRICT;

INSERT INTO attempt_rollback_plans_v15 SELECT * FROM attempt_rollback_plans;
DROP TABLE attempt_rollback_plans;
ALTER TABLE attempt_rollback_plans_v15 RENAME TO attempt_rollback_plans;
CREATE INDEX attempt_rollback_plans_project_recorded
  ON attempt_rollback_plans (project_id, recorded_at, attempt_id);

DROP TABLE densa_run_branches_legacy;

CREATE TABLE phase_reports_v15 (
  phase_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('blocked', 'awaiting_approval', 'completed')),
  report_path TEXT NOT NULL CHECK (
    report_path GLOB '.densa-ade/reports/*.md'
    OR report_path GLOB '.densa/reports/*.md'
  ),
  report_json TEXT NOT NULL CHECK (
    json_valid(report_json)
    AND json_extract(report_json, '$.formatVersion') = 1
  ),
  generated_at TEXT NOT NULL CHECK (length(generated_at) >= 20),
  FOREIGN KEY (project_id, phase_id) REFERENCES phases(project_id, id) ON DELETE CASCADE,
  UNIQUE (project_id, report_path)
) STRICT;

INSERT INTO phase_reports_v15 SELECT * FROM phase_reports;
DROP TABLE phase_reports;
ALTER TABLE phase_reports_v15 RENAME TO phase_reports;
CREATE INDEX phase_reports_project_generated
  ON phase_reports (project_id, generated_at, phase_id);
`;

const isolatedExecutionWorkspaces = `
ALTER TABLE densa_run_branches ADD COLUMN source_workspace_path TEXT
  CHECK (source_workspace_path IS NULL OR (length(source_workspace_path) > 0 AND source_workspace_path <> workspace_path));
CREATE TABLE task_publication_intents (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE RESTRICT,
  source_workspace_path TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  expected_head TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT
) STRICT;
`;

export const schemaMigrations: readonly SchemaMigration[] = Object.freeze([
  Object.freeze({ version: 1, name: "authoritative_runtime_schema", sql: initialSchema }),
  Object.freeze({ version: 2, name: "ordered_event_journal", sql: orderedEventJournal }),
  Object.freeze({ version: 3, name: "recovery_metadata", sql: recoveryMetadata }),
  Object.freeze({
    version: 4,
    name: "run_branches_and_task_checkpoints",
    sql: runBranchesAndTaskCheckpoints,
  }),
  Object.freeze({ version: 5, name: "atomic_task_commits", sql: atomicTaskCommits }),
  Object.freeze({
    version: 6,
    name: "bounded_attempt_rollbacks",
    sql: boundedAttemptRollbacks,
  }),
  Object.freeze({
    version: 7,
    name: "structured_project_specifications",
    sql: structuredProjectSpecifications,
  }),
  Object.freeze({
    version: 8,
    name: "audited_roadmap_mutations",
    sql: auditedRoadmapMutations,
  }),
  Object.freeze({ version: 9, name: "durable_phase_reports", sql: durablePhaseReports }),
  Object.freeze({
    version: 10,
    name: "validator_plugin_framework",
    sql: validatorPluginFramework,
  }),
  Object.freeze({
    version: 11,
    name: "acceptance_criteria_evidence",
    sql: acceptanceCriteriaEvidence,
  }),
  Object.freeze({
    version: 12,
    name: "fresh_context_independent_review",
    sql: freshContextIndependentReview,
  }),
  Object.freeze({
    version: 13,
    name: "durable_project_decisions",
    sql: durableProjectDecisions,
  }),
  Object.freeze({
    version: 14,
    name: "master_roadmap_revision_workflow",
    sql: masterRoadmapRevisionWorkflow,
  }),
  Object.freeze({
    version: 15,
    name: "densa_ade_machine_namespaces",
    sql: densaAdeMachineNamespaces,
  }),
  Object.freeze({
    version: 16,
    name: "isolated_execution_workspaces",
    sql: isolatedExecutionWorkspaces,
  }),
]);

export const latestSchemaVersion = schemaMigrations.at(-1)?.version ?? 0;

function checksum(migration: SchemaMigration): string {
  return createHash("sha256").update(migration.sql).digest("hex");
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original migration failure when SQLite already rolled back.
  }
}

export function migrate(database: DatabaseSync, now: () => string): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _densa_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TEXT NOT NULL CHECK (length(applied_at) >= 20)
    ) STRICT;
  `);

  const applied = database
    .prepare("SELECT version, name, checksum FROM _densa_migrations ORDER BY version")
    .all();

  for (const row of applied) {
    const version = row["version"];
    const migration =
      typeof version === "number"
        ? schemaMigrations.find((candidate) => candidate.version === version)
        : undefined;
    if (
      migration === undefined ||
      row["name"] !== migration.name ||
      row["checksum"] !== checksum(migration)
    ) {
      throw new Error(`Applied SQLite migration ${String(version)} does not match this build`);
    }
  }

  let nextVersion = applied.length + 1;
  for (const migration of schemaMigrations.slice(applied.length)) {
    if (migration.version !== nextVersion) {
      throw new Error(`SQLite migrations must be contiguous at version ${migration.version}`);
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO _densa_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(migration.version, migration.name, checksum(migration), now());
      database.exec("COMMIT");
      nextVersion += 1;
    } catch (error) {
      rollback(database);
      throw error;
    }
  }
}
