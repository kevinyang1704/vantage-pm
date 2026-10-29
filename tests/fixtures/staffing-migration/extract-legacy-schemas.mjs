#!/usr/bin/env node
/**
 * Regenerates `legacy-schemas.json` (Story 22.13): the product DDL that real
 * predecessor builds created, extracted VERBATIM from git history for both
 * runtimes, plus the synthetic populated data each version is seeded with.
 *
 * Browser and native tests load the same file, so both upgrade paths are
 * exercised from the same historical shapes and the same facts. Re-run only
 * when adding a source version:
 *
 *   node tests/fixtures/staffing-migration/extract-legacy-schemas.mjs
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Supported predecessor schemas (QUALITY-CONTRACT §2: every shipped version stays migratable). */
const SOURCES = [
  { version: 9, commit: '75fd2bd', why: 'last schema before forecasting (outline delivery status)' },
  { version: 12, commit: '2ab8182^', why: 'forecast plans, blockers and scenarios; before planning_level' },
  { version: 13, commit: '9af96a2', why: 'immediate pre-staffing schema (planning_level, no roster/assignments)' },
];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

function between(text, start, end) {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`marker not found: ${start}`);
  const to = text.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`end marker not found: ${end}`);
  return text.slice(from + start.length, to);
}

/** Drop whole-line `//` comments, which can themselves contain backticks. */
const withoutLineComments = (text) =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

function browserDdl(commit) {
  const body = withoutLineComments(
    between(git('show', `${commit}:src/adapters/persistence/schema.ts`), 'export const PRODUCT_SCHEMA_DDL = [', '] as const;'),
  );
  return [...body.matchAll(/`([\s\S]*?)`/g)].map((m) => m[1].trim());
}

function nativeDdl(commit) {
  const source = git('show', `${commit}:src-tauri/src/db/schema.rs`);
  const start = source.indexOf('pub const PRODUCT_SCHEMA_DDL');
  const body = withoutLineComments(between(source.slice(start), '= [', '];'));
  return [...body.matchAll(/r#"([\s\S]*?)"#|"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? m[2]).trim());
}

// ── Synthetic populated facts (no real user data) ─────────────────────────

const ID = {
  workspace: '019ffe30-0000-7000-8000-000000000001',
  project: '019ffe30-0000-7000-8000-000000000002',
  theme: '019ffe30-0000-7000-8000-0000000000a1',
  featureA: '019ffe30-0000-7000-8000-0000000000a2',
  featureB: '019ffe30-0000-7000-8000-0000000000a3',
  phase: '019ffe30-0000-7000-8000-0000000000b1',
  edge: '019ffe30-0000-7000-8000-0000000000c1',
  receipt1: '019ffe30-0000-7000-8000-0000000000d1',
  receipt2: '019ffe30-0000-7000-8000-0000000000d2',
  scenario: '019ffe30-0000-7000-8000-0000000000e1',
};

function dataFor(version) {
  const statements = [
    `INSERT INTO workspaces(id, name, position) VALUES ('${ID.workspace}', 'Synthetic workspace', 0)`,
    `INSERT INTO app_settings(key, value) VALUES ('active_workspace_id', '${ID.workspace}')`,
    `INSERT INTO projects(id, name, revision, workspace_id) VALUES ('${ID.project}', 'Synthetic migration project', 7, '${ID.workspace}')`,
    `INSERT INTO product_command_receipt(command_id, project_id, command_type, base_revision, target_revision, result_json) VALUES ('${ID.receipt1}', '${ID.project}', 'CreateProject', 0, 1, '{"ok":true}')`,
    `INSERT INTO product_command_receipt(command_id, project_id, command_type, base_revision, target_revision, result_json) VALUES ('${ID.receipt2}', '${ID.project}', 'SetNodeEffort', 6, 7, '{"ok":true}')`,
    `INSERT INTO phases(id, project_id, name, position) VALUES ('${ID.phase}', '${ID.project}', 'Discovery', 0)`,
    `INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points, phase_id, delivery_status) VALUES ('${ID.theme}', '${ID.project}', NULL, 'Synthetic theme', 4294967296, 'Theme', NULL, '${ID.phase}', 'in_progress')`,
    `INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points, delivery_status) VALUES ('${ID.featureA}', '${ID.project}', '${ID.theme}', 'Synthetic feature A', 4294967296, 'Feature', 5, 'not_started')`,
    `INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points, delivery_status) VALUES ('${ID.featureB}', '${ID.project}', '${ID.theme}', 'Synthetic feature B', 8589934592, 'Feature', 8, 'done')`,
    `INSERT INTO unlock_edges(id, project_id, source_node_id, target_node_id) VALUES ('${ID.edge}', '${ID.project}', '${ID.featureA}', '${ID.featureB}')`,
  ];
  if (version >= 12) {
    const plan = version >= 13
      ? `INSERT INTO forecast_plans(project_id, selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint, sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version, planning_level) VALUES ('${ID.project}', '["${ID.featureA}","${ID.featureB}"]', '[]', '["${ID.featureB}"]', 10, 14, 'fixed-contiguous', 3, '2026-09-07', 'shared-capacity-v1', 'Feature')`
      : `INSERT INTO forecast_plans(project_id, selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint, sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version) VALUES ('${ID.project}', '["${ID.featureA}","${ID.featureB}"]', '[]', '["${ID.featureB}"]', 10, 14, 'fixed-contiguous', 3, '2026-09-07', 'shared-capacity-v1')`;
    statements.push(plan);
    statements.push(
      `INSERT INTO forecast_scenarios(scenario_id, project_id, label, baseline_revision, baseline_fingerprint, policy_version, created_at_iso, baseline_json, patch_json) VALUES ('${ID.scenario}', '${ID.project}', 'Synthetic shared scenario', 6, '${'a'.repeat(64)}', 'shared-capacity-v1', '2026-09-06T00:00:00.000Z', '{"synthetic":true}', '{"pointsPerSprint":12}')`,
    );
  }
  return statements;
}

const output = {
  $comment: 'Generated by extract-legacy-schemas.mjs from git history. Do not edit by hand.',
  ids: ID,
  sources: SOURCES.map(({ version, commit, why }) => ({
    version,
    commit,
    resolvedCommit: git('rev-parse', commit).trim(),
    why,
    browserDdl: browserDdl(commit),
    nativeDdl: nativeDdl(commit),
    data: dataFor(version),
  })),
};

writeFileSync(path.join(here, 'legacy-schemas.json'), `${JSON.stringify(output, null, 2)}\n`);
for (const s of output.sources) {
  console.log(`v${s.version} @ ${s.resolvedCommit.slice(0, 10)}: ${s.browserDdl.length} browser / ${s.nativeDdl.length} native DDL, ${s.data.length} data statements`);
}
