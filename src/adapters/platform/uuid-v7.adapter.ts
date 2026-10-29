/**
 * UUIDv7 ID generator adapter (Story 2.3 Task 6, AD-8).
 */

import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import type { IdGeneratorPort } from '../../application/ports/id-generator.port';

export class UuidV7IdGeneratorAdapter implements IdGeneratorPort {
  nextId(): string {
    return createUuidV7();
  }
}
