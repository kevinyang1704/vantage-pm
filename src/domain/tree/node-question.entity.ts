/**
 * NodeOpenQuestion domain entity (Story 16.1, E16-FR3, E16-AR1).
 *
 * Represents one ordered open question or ratified decision attached to a
 * node. Lives in its own SQLite table (`node_open_questions`) and is never
 * embedded in the `nodes` row — question commands stay orthogonal to
 * `SetNodeBodyText` (AC-COMMAND-GRANULARITY).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type NodeQuestionStatus = 'OPEN' | 'DECIDED';

export type NodeOpenQuestion = Readonly<{
  id: string; // lowercase UUIDv7
  projectId: string; // project scope; AD-7 forbids cross-project references
  nodeId: string; // owning node
  questionText: string; // non-empty authored question
  status: NodeQuestionStatus;
  decisionText: string | null; // null while OPEN; recorded on resolve
  position: bigint; // signed 64-bit gap position among the node's questions
  resolvedAtISO: string | null; // ISO instant stamped on resolve; null while OPEN
  createdAtISO: string; // ISO instant at creation
}>;

export function createNodeOpenQuestion(params: {
  id: string;
  projectId: string;
  nodeId: string;
  questionText: string;
  status?: NodeQuestionStatus;
  decisionText?: string | null;
  position: bigint;
  resolvedAtISO?: string | null;
  createdAtISO: string;
}): NodeOpenQuestion {
  assertUuidV7(params.id, 'NodeOpenQuestion.id must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'NodeOpenQuestion.projectId must be a valid UUIDv7');
  assertUuidV7(params.nodeId, 'NodeOpenQuestion.nodeId must be a valid UUIDv7');
  if (typeof params.questionText !== 'string' || params.questionText.trim().length === 0) {
    throw new Error('INVALID_QUESTION_TEXT');
  }
  if (params.status === 'DECIDED' && params.decisionText === null) {
    throw new Error('DECIDED_QUESTION_REQUIRES_DECISION_TEXT');
  }
  const resolvedAt = params.resolvedAtISO ?? null;
  if (params.status === 'OPEN' && resolvedAt !== null) {
    throw new Error('OPEN_QUESTION_CANNOT_BE_RESOLVED');
  }
  if (params.status === 'DECIDED' && resolvedAt === null) {
    throw new Error('DECIDED_QUESTION_REQUIRES_RESOLVED_AT');
  }

  return Object.freeze({
    id: params.id,
    projectId: params.projectId,
    nodeId: params.nodeId,
    questionText: params.questionText,
    status: params.status ?? 'OPEN',
    decisionText: params.decisionText ?? null,
    position: params.position,
    resolvedAtISO: resolvedAt,
    createdAtISO: params.createdAtISO,
  });
}
