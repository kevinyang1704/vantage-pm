/**
 * CommandPalette Component (Story 2.7 Task 4).
 * Accessible fuzzy search and action execution.
 */

import React, { useState, useEffect, useRef, useMemo, type ReactElement } from 'react';
import type { ActionDeclaration } from '../../../application/actions/action';
import type { ActionContext } from '../../../application/actions/action-context';
import { rankActions } from '../../../domain/actions/action-ranking.policy';
import './command-palette.css';

export interface CommandPaletteProps {
  readonly actions: readonly ActionDeclaration[];
  readonly context: ActionContext;
  readonly onClose: () => void;
}

export function CommandPalette({
  actions,
  context,
  onClose,
}: CommandPaletteProps): ReactElement {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  const ranked = useMemo(() => {
    return rankActions(actions, query);
  }, [actions, query]);

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
      setSelectedIndex((idx) => (idx + 1 < ranked.length ? idx + 1 : idx));
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((idx) => (idx > 0 ? idx - 1 : 0));
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const selected = ranked[selectedIndex];
      if (selected) {
        const avail = selected.action.isAvailable(context);
        if (avail.kind === 'Available') {
          onClose();
          void selected.action.run(context);
        }
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
        aria-label="Command Palette"
        onKeyDown={handleKeyDown}
      >
        <div className="pm-command-palette__input-wrapper">
          <input
            ref={inputRef}
            type="text"
            className="pm-command-palette__input"
            placeholder="Type a command or search actions..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-autocomplete="list"
            aria-controls="pm-command-palette-results"
          />
        </div>

        <ul
          id="pm-command-palette-results"
          className="pm-command-palette__results"
          role="listbox"
        >
          {ranked.length === 0 ? (
            <li className="pm-command-palette__empty" role="status">
              No matching actions found.
            </li>
          ) : (
            ranked.map((item, idx) => {
              const action = item.action;
              const avail = action.isAvailable(context);
              const isSelected = idx === selectedIndex;
              const isAvailable = avail.kind === 'Available';

              return (
                <li
                  key={action.id}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={!isAvailable}
                  className={`pm-command-palette__item ${
                    isSelected ? 'pm-command-palette__item--selected' : ''
                  } ${!isAvailable ? 'pm-command-palette__item--disabled' : ''}`}
                  onClick={() => {
                    if (isAvailable) {
                      onClose();
                      void action.run(context);
                    }
                  }}
                >
                  <div className="pm-command-palette__label-group">
                    <span className="pm-command-palette__label">{action.label}</span>
                    {!isAvailable && (
                      <span className="pm-command-palette__reason">{avail.reason}</span>
                    )}
                  </div>
                  {action.binding && (
                    <span className="pm-command-palette__binding">
                      {action.binding.ctrlOrMeta ? 'Ctrl+' : ''}
                      {action.binding.shift ? 'Shift+' : ''}
                      {action.binding.key.toUpperCase()}
                    </span>
                  )}
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
