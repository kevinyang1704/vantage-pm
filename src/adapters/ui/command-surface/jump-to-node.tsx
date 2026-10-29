/**
 * JumpToNode Search Surface (Story 2.8 Task 6, FR-12).
 *
 * Fast jump-to-node search with 4-stage fuzzy ranking and accessible keyboard navigation.
 */

import React, { useState, useEffect, useRef, useMemo, type ReactElement } from 'react';
import type { NodeTitleIndex } from '../../../application/search/node-title-index';
import { ITEM_NOUN, ITEM_NOUN_PLURAL } from '../vocabulary';
import './command-palette.css';

export interface JumpToNodeProps {
  readonly searchIndex: NodeTitleIndex;
  readonly onSelectNode: (nodeId: string) => void;
  readonly onCreateNodeFromSearch?: (title: string) => void;
  readonly onClose: () => void;
  /** When set, results are filtered to only these node IDs (e.g. Story 6.4's theme-scoped overflow jump). */
  readonly restrictToNodeIds?: ReadonlySet<string>;
  /** Placeholder/empty-state noun used when restrictToNodeIds is set (default 'items'). */
  readonly restrictedItemLabel?: string;
}

export function JumpToNode({
  searchIndex,
  onSelectNode,
  onCreateNodeFromSearch,
  onClose,
  restrictToNodeIds,
  restrictedItemLabel = ITEM_NOUN_PLURAL,
}: JumpToNodeProps): ReactElement {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  const results = useMemo(() => {
    const all = searchIndex.search(query);
    return restrictToNodeIds ? all.filter((r) => restrictToNodeIds.has(r.nodeId)) : all;
  }, [searchIndex, query, restrictToNodeIds]);

  useEffect(() => {
    previousActiveElement.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      previousActiveElement.current?.focus();
    };
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((idx) => (idx + 1 < results.length ? idx + 1 : idx));
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((idx) => (idx > 0 ? idx - 1 : 0));
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (results.length > 0 && results[selectedIndex]) {
        onClose();
        onSelectNode(results[selectedIndex].nodeId);
      } else if (!restrictToNodeIds && query.trim() && onCreateNodeFromSearch) {
        onClose();
        onCreateNodeFromSearch(query.trim());
      }
    }
  };

  return (
    <div
      className="pm-command-surface-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="pm-command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={restrictToNodeIds ? `Jump to ${restrictedItemLabel}` : 'Jump to item'}
        onKeyDown={handleKeyDown}
      >
        <div className="pm-command-palette__input-wrapper">
          <input
            ref={inputRef}
            type="text"
            className="pm-command-palette__input"
            placeholder={restrictToNodeIds ? `Search ${restrictedItemLabel}...` : `Jump to ${ITEM_NOUN}...`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-autocomplete="list"
            aria-controls="pm-jump-node-results"
          />
        </div>

        <ul id="pm-jump-node-results" className="pm-command-palette__results" role="listbox">
          {query.trim().length > 0 && results.length === 0 ? (
            <li className="pm-command-palette__empty" role="status">
              {restrictToNodeIds
                ? `No matching ${restrictedItemLabel} found.`
                : <>No matching {ITEM_NOUN_PLURAL} found. Press Enter to create &quot;{query.trim()}&quot;.</>}
            </li>
          ) : (
            results.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <li
                  key={item.nodeId}
                  role="option"
                  aria-selected={isSelected}
                  className={`pm-command-palette__item ${
                    isSelected ? 'pm-command-palette__item--selected' : ''
                  }`}
                  onClick={() => {
                    onClose();
                    onSelectNode(item.nodeId);
                  }}
                >
                  <div className="pm-command-palette__label-group">
                    <span className="pm-command-palette__label">{item.title}</span>
                  </div>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
