/**
 * In-memory node title search index (Story 2.8 Task 3, AD-6).
 *
 * Owned and updated incrementally from revisioned ChangeSets.
 */

import type { ChangeSet } from '../../contracts/change-set';
import type { OutlineNodeReadModel } from '../outline/outline-read-model';
import {
  rankSearchCandidates,
  type SearchCandidate,
  type RankedSearchResult,
} from '../../domain/search/search-ranking.policy';

export class NodeTitleIndex {
  private candidates: SearchCandidate[] = [];

  rebuildFromNodes(nodes: readonly OutlineNodeReadModel[]): void {
    this.candidates = nodes.map((n, idx) => ({
      nodeId: n.id,
      title: n.title,
      authoredOrdinal: idx,
    }));
  }

  applyChangeSet(changeSet: ChangeSet): void {
    for (const change of changeSet.changes) {
      switch (change.type) {
        case 'NodeCreated': {
          this.candidates.push({
            nodeId: change.nodeId,
            title: change.title,
            authoredOrdinal: this.candidates.length,
          });
          break;
        }

        case 'NodeTitleSet': {
          const idx = this.candidates.findIndex((c) => c.nodeId === change.nodeId);
          if (idx !== -1) {
            this.candidates[idx] = { ...this.candidates[idx], title: change.title };
          }
          break;
        }

        case 'SubtreeDeleted': {
          const deletedIds = new Set(change.nodes.map((n) => n.nodeId));
          deletedIds.add(change.rootNodeId);
          this.candidates = this.candidates.filter((c) => !deletedIds.has(c.nodeId));
          break;
        }

        case 'SubtreeRestored': {
          for (const node of change.nodes) {
            this.candidates.push({
              nodeId: node.nodeId,
              title: node.title,
              authoredOrdinal: this.candidates.length,
            });
          }
          break;
        }

        case 'SubtreeDuplicated': {
          for (const node of change.nodes) {
            this.candidates.push({
              nodeId: node.nodeId,
              title: node.title,
              authoredOrdinal: this.candidates.length,
            });
          }
          break;
        }
      }
    }
  }

  search(query: string): readonly RankedSearchResult[] {
    return rankSearchCandidates(this.candidates, query);
  }
}
