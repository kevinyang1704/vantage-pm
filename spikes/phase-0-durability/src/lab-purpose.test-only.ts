import { sha256Hex } from './restart-inspector';

const LAB_PRIVATE_MATERIAL = 'pmapp-phase0-story-1-1-lab-only-2026-08-13';

export type LabPurposeToken = Readonly<{
  purpose: 'lab';
  runId: string;
  commandId: string;
  signature: string;
}>;

export async function issueLabPurposeToken(runId: string, commandId: string): Promise<LabPurposeToken> {
  return Object.freeze({
    purpose: 'lab',
    runId,
    commandId,
    signature: await sha256Hex(`${LAB_PRIVATE_MATERIAL}\u0000${runId}\u0000${commandId}`),
  });
}

export async function verifyLabPurposeToken(token: LabPurposeToken): Promise<boolean> {
  return token.purpose === 'lab' &&
    token.signature === await sha256Hex(`${LAB_PRIVATE_MATERIAL}\u0000${token.runId}\u0000${token.commandId}`);
}
