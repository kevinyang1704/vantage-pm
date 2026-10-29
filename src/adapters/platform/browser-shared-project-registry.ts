/**
 * IndexedDB shared-project registry (H08). Used by both the browser build and
 * the desktop webview: the mapping holds no secret (the desktop bearer lives
 * in the OS keychain, the browser key is non-exportable). Writes acknowledge
 * only after their transaction completes; malformed rows read as absent.
 */

import { collaborationTx, openCollaborationDb, SHARED_PROJECTS_STORE } from './browser-credential.adapter';
import { parseSharedProjectRecord, type SharedProjectRecord, type SharedProjectRegistry } from '../../application/collaboration/shared-project-registry';

export function createBrowserSharedProjectRegistry(): SharedProjectRegistry {
  return {
    async get(projectId) {
      const db = await openCollaborationDb();
      try { return parseSharedProjectRecord(await collaborationTx<unknown>(db, SHARED_PROJECTS_STORE, 'readonly', (s) => s.get(projectId))); }
      finally { db.close(); }
    },
    async put(record: SharedProjectRecord) {
      const valid = parseSharedProjectRecord(record);
      if (!valid) throw new Error('SHARED_PROJECT_RECORD_INVALID');
      const db = await openCollaborationDb();
      try { await collaborationTx(db, SHARED_PROJECTS_STORE, 'readwrite', (s) => s.put(valid, valid.projectId)); }
      finally { db.close(); }
    },
    async remove(projectId) {
      const db = await openCollaborationDb();
      try { await collaborationTx(db, SHARED_PROJECTS_STORE, 'readwrite', (s) => s.delete(projectId)); }
      finally { db.close(); }
    },
  };
}
