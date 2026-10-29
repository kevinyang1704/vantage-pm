type ParityState = Partial<Readonly<{
  resultHash: string;
  receiptHash: string;
  revision: number;
  semanticDbHash: string;
  quickCheck: string;
  migrationOutcome: string;
  updateOutcome: string;
  restartHash: string;
}>>;

export function adjudicateParity(input: {
  forwarding: ReadonlyArray<Readonly<{
    method: string;
    downstreamCalls: number;
    argumentsEqual: boolean;
    returnCodeEqual: boolean;
    order: number;
  }>>;
  production: ParityState;
  instrumented: ParityState;
}) {
  const differences: string[] = [];
  for (const call of input.forwarding) {
    if (call.downstreamCalls !== 1) differences.push(`${call.method}:downstreamCalls`);
    if (!call.argumentsEqual) differences.push(`${call.method}:arguments`);
    if (!call.returnCodeEqual) differences.push(`${call.method}:returnCode`);
  }
  const ordered = [...input.forwarding].every((call, index, calls) => index === 0 || calls[index - 1]!.order < call.order);
  if (!ordered) differences.push('callback-order');
  const keys = new Set([...Object.keys(input.production), ...Object.keys(input.instrumented)]);
  for (const key of keys) {
    if (input.production[key as keyof ParityState] !== input.instrumented[key as keyof ParityState]) {
      differences.push(key);
    }
  }
  return {
    status: differences.length ? 'FAIL' as const : 'PASS' as const,
    differences,
    ...(differences.length ? { logicalEvidenceAccepted: false } : {}),
  };
}
