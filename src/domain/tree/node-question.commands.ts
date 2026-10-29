/**
 * Node open-question domain commands (Story 16.1, E16-AR1, AD-4, AD-7).
 *
 * Granular commands only — never mutate `body_text` and `node_open_questions`
 * in the same command (AC-COMMAND-GRANULARITY).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type AddNodeQuestionCommand = Readonly<{
  type: 'AddNodeQuestion';
  commandId: string;
  projectId: string;
  baseRevision: number;
  questionId: string;
  nodeId: string;
  questionText: string;
  position: bigint;
  createdAtISO: string;
}>;

export type UpdateNodeQuestionCommand = Readonly<{
  type: 'UpdateNodeQuestion';
  commandId: string;
  projectId: string;
  baseRevision: number;
  questionId: string;
  questionText: string;
}>;

export type ResolveNodeQuestionCommand = Readonly<{
  type: 'ResolveNodeQuestion';
  commandId: string;
  projectId: string;
  baseRevision: number;
  questionId: string;
  decisionText: string;
  resolvedAtISO: string;
}>;

export type ReorderNodeQuestionsCommand = Readonly<{
  type: 'ReorderNodeQuestions';
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  questionIds: readonly string[]; // full ordered list of the node's question ids
}>;

export type DeleteNodeQuestionCommand = Readonly<{
  type: 'DeleteNodeQuestion';
  commandId: string;
  projectId: string;
  baseRevision: number;
  questionId: string;
}>;

/**
 * Move one node question among its siblings (Story 27.2, D8(c), R3). Carries
 * both intended neighbours ("after Y, before Z", either null at an end) and the
 * intended index. Replaces the whole-list `ReorderNodeQuestions` on the shared
 * path so a concurrent reorder keeps its meaning.
 */
export type MoveNodeQuestionCommand = Readonly<{
  type: 'MoveNodeQuestion';
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  questionId: string;
  afterId: string | null;
  beforeId: string | null;
  intendedIndex: number;
}>;

export function createMoveNodeQuestionCommand(input: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  questionId: string;
  afterId: string | null;
  beforeId: string | null;
  intendedIndex: number;
}): MoveNodeQuestionCommand {
  assertUuidV7(input.commandId, 'MoveNodeQuestionCommand.commandId');
  assertUuidV7(input.projectId, 'MoveNodeQuestionCommand.projectId');
  assertUuidV7(input.nodeId, 'MoveNodeQuestionCommand.nodeId');
  assertUuidV7(input.questionId, 'MoveNodeQuestionCommand.questionId');
  if (input.afterId !== null) assertUuidV7(input.afterId, 'MoveNodeQuestionCommand.afterId');
  if (input.beforeId !== null) assertUuidV7(input.beforeId, 'MoveNodeQuestionCommand.beforeId');
  assertBaseRevision(input.baseRevision);
  if (!Number.isSafeInteger(input.intendedIndex) || input.intendedIndex < 0) {
    throw new Error('INVALID_INTENDED_INDEX');
  }
  return Object.freeze({
    type: 'MoveNodeQuestion',
    commandId: input.commandId,
    projectId: input.projectId,
    baseRevision: input.baseRevision,
    nodeId: input.nodeId,
    questionId: input.questionId,
    afterId: input.afterId,
    beforeId: input.beforeId,
    intendedIndex: input.intendedIndex,
  });
}

export type NodeQuestionCommand =
  | AddNodeQuestionCommand
  | UpdateNodeQuestionCommand
  | ResolveNodeQuestionCommand
  | ReorderNodeQuestionsCommand
  | MoveNodeQuestionCommand
  | DeleteNodeQuestionCommand;

function assertBaseRevision(baseRevision: number): void {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
}

export function createAddNodeQuestionCommand(input: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  questionId: string;
  nodeId: string;
  questionText: string;
  position: bigint;
  createdAtISO: string;
}): AddNodeQuestionCommand {
  assertUuidV7(input.commandId, 'AddNodeQuestionCommand.commandId');
  assertUuidV7(input.projectId, 'AddNodeQuestionCommand.projectId');
  assertUuidV7(input.questionId, 'AddNodeQuestionCommand.questionId');
  assertUuidV7(input.nodeId, 'AddNodeQuestionCommand.nodeId');
  assertBaseRevision(input.baseRevision);
  if (typeof input.questionText !== 'string' || input.questionText.trim().length === 0) {
    throw new Error('INVALID_QUESTION_TEXT');
  }
  if (typeof input.createdAtISO !== 'string' || input.createdAtISO.length === 0) {
    throw new Error('INVALID_CREATED_AT');
  }
  return Object.freeze({
    type: 'AddNodeQuestion',
    commandId: input.commandId,
    projectId: input.projectId,
    baseRevision: input.baseRevision,
    questionId: input.questionId,
    nodeId: input.nodeId,
    questionText: input.questionText,
    position: input.position,
    createdAtISO: input.createdAtISO,
  });
}

export function createUpdateNodeQuestionCommand(input: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  questionId: string;
  questionText: string;
}): UpdateNodeQuestionCommand {
  assertUuidV7(input.commandId, 'UpdateNodeQuestionCommand.commandId');
  assertUuidV7(input.projectId, 'UpdateNodeQuestionCommand.projectId');
  assertUuidV7(input.questionId, 'UpdateNodeQuestionCommand.questionId');
  assertBaseRevision(input.baseRevision);
  if (typeof input.questionText !== 'string' || input.questionText.trim().length === 0) {
    throw new Error('INVALID_QUESTION_TEXT');
  }
  return Object.freeze({
    type: 'UpdateNodeQuestion',
    commandId: input.commandId,
    projectId: input.projectId,
    baseRevision: input.baseRevision,
    questionId: input.questionId,
    questionText: input.questionText,
  });
}

export function createResolveNodeQuestionCommand(input: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  questionId: string;
  decisionText: string;
  resolvedAtISO: string;
}): ResolveNodeQuestionCommand {
  assertUuidV7(input.commandId, 'ResolveNodeQuestionCommand.commandId');
  assertUuidV7(input.projectId, 'ResolveNodeQuestionCommand.projectId');
  assertUuidV7(input.questionId, 'ResolveNodeQuestionCommand.questionId');
  assertBaseRevision(input.baseRevision);
  if (typeof input.decisionText !== 'string' || input.decisionText.trim().length === 0) {
    throw new Error('INVALID_DECISION_TEXT');
  }
  if (typeof input.resolvedAtISO !== 'string' || input.resolvedAtISO.length === 0) {
    throw new Error('INVALID_RESOLVED_AT');
  }
  return Object.freeze({
    type: 'ResolveNodeQuestion',
    commandId: input.commandId,
    projectId: input.projectId,
    baseRevision: input.baseRevision,
    questionId: input.questionId,
    decisionText: input.decisionText,
    resolvedAtISO: input.resolvedAtISO,
  });
}

export function createReorderNodeQuestionsCommand(input: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  questionIds: readonly string[];
}): ReorderNodeQuestionsCommand {
  assertUuidV7(input.commandId, 'ReorderNodeQuestionsCommand.commandId');
  assertUuidV7(input.projectId, 'ReorderNodeQuestionsCommand.projectId');
  assertUuidV7(input.nodeId, 'ReorderNodeQuestionsCommand.nodeId');
  assertBaseRevision(input.baseRevision);
  if (!Array.isArray(input.questionIds) || input.questionIds.length === 0) {
    throw new Error('INVALID_QUESTION_IDS');
  }
  for (const id of input.questionIds) {
    assertUuidV7(id, 'ReorderNodeQuestionsCommand.questionIds[]');
  }
  return Object.freeze({
    type: 'ReorderNodeQuestions',
    commandId: input.commandId,
    projectId: input.projectId,
    baseRevision: input.baseRevision,
    nodeId: input.nodeId,
    questionIds: Object.freeze([...input.questionIds]),
  });
}

export function createDeleteNodeQuestionCommand(input: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  questionId: string;
}): DeleteNodeQuestionCommand {
  assertUuidV7(input.commandId, 'DeleteNodeQuestionCommand.commandId');
  assertUuidV7(input.projectId, 'DeleteNodeQuestionCommand.projectId');
  assertUuidV7(input.questionId, 'DeleteNodeQuestionCommand.questionId');
  assertBaseRevision(input.baseRevision);
  return Object.freeze({
    type: 'DeleteNodeQuestion',
    commandId: input.commandId,
    projectId: input.projectId,
    baseRevision: input.baseRevision,
    questionId: input.questionId,
  });
}
