export const PROTOCOL_VERSION = '1.0.0' as const;
export const KNOWN_PROJECT_ID = '0198a000-0000-7000-8000-000000000002';
export const KNOWN_COMMAND_ID = '0198a000-0000-7000-8000-000000000001';

export const UUID_V7_LOWERCASE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SHA256_LOWERCASE = /^[0-9a-f]{64}$/;

export function assertUuidV7(value: string, field: string): void {
  if (!UUID_V7_LOWERCASE.test(value)) throw new Error(`INVALID_UUID_V7:${field}`);
}

export function assertSafeHash(value: string, field: string): void {
  if (!SHA256_LOWERCASE.test(value)) throw new Error(`INVALID_SHA256:${field}`);
}

export function createUuidV7(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type FixtureCommand = Readonly<{
  type: 'SetFixtureValue';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  safeValueHash: string;
}>;

export function createKnownFixtureCommand(input: {
  commandId?: string;
  projectId?: string;
  baseRevision: number;
  safeValueHash: string;
}): FixtureCommand {
  const commandId = input.commandId ?? KNOWN_COMMAND_ID;
  const projectId = input.projectId ?? KNOWN_PROJECT_ID;
  assertUuidV7(commandId, 'commandId');
  assertUuidV7(projectId, 'projectId');
  assertSafeHash(input.safeValueHash, 'safeValueHash');
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  return Object.freeze({
    type: 'SetFixtureValue',
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    projectId,
    baseRevision: input.baseRevision,
    expectedRevision: input.baseRevision + 1,
    safeValueHash: input.safeValueHash,
  });
}

export type CommandReceipt = Readonly<{
  commandId: string;
  projectId: string;
  appliedRevision: number;
  resultCode: 'VFS_COMMIT_ACCEPTED';
}>;

export type RepositoryResult = Readonly<{
  code: 'VFS_COMMIT_ACCEPTED';
  resultingRevision: number;
  safeValueHash: string;
}>;
