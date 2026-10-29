/**
 * Native storage-status platform adapter (E9-FR14, E9-UX4).
 *
 * Re-exports the native runtime status from the Tauri client and derives the
 * storage-health category without browser storage signals. Kept as its own
 * module so the main.tsx startup path can import it lazily only in the
 * native composition.
 */

import { getNativeStorageRuntimeStatus } from '../persistence/tauri-repository.client';
import {
  deriveNativeStorageHealth,
  type NativeStorageStatus,
  type StorageHealthCategory,
} from './storage-health';

export type { NativeStorageStatus, StorageHealthCategory };

/** Resolves native storage health from the runtime command (E9-FR14). */
export async function detectNativeStorageHealth(): Promise<StorageHealthCategory> {
  const status = await getNativeStorageRuntimeStatus();
  return deriveNativeStorageHealth(status);
}

export { deriveNativeStorageHealth };
