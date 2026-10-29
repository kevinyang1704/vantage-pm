/**
 * ExportPreviewModal — one-sentence export scope preview with confirm/cancel
 * (Story 8.1 Task 7, AC3/AC4; UAT #5 format picker).
 *
 * Shows exactly the resolved scope sentence before the user can confirm
 * generation, plus a PPTX/DOCX format selector. The default format follows the
 * invoking view (Gantt → PowerPoint, Outline/Visual → Word); the user may
 * switch it before confirming.
 */

import React, { useState } from 'react';
import type { ViewScope } from '../../../contracts/view-scope';
import type { ExportFormat } from '../../../contracts/export-protocol';
import './export-preview-modal.css';

export interface ExportPreviewModalProps {
  readonly sentence: string;
  readonly scope: ViewScope;
  readonly defaultFormat: ExportFormat;
  readonly onClose: () => void;
  readonly onConfirm: (format: ExportFormat) => void;
}

export function defaultExportFormatForScope(scope: ViewScope): ExportFormat {
  return scope.kind === 'GanttVisible' ? 'pptx' : 'docx';
}

export const ExportPreviewModal: React.FC<ExportPreviewModalProps> = ({
  sentence,
  scope,
  defaultFormat,
  onClose,
  onConfirm,
}) => {
  const [format, setFormat] = useState<ExportFormat>(defaultFormat);

  return (
    <div className="pm-export-preview__backdrop" role="dialog" aria-modal="true" aria-labelledby="export-preview-title">
      <div className="pm-export-preview">
        <div className="pm-export-preview__header">
          <h2 id="export-preview-title" className="pm-export-preview__title">
            Export Preview
          </h2>
          <button
            type="button"
            className="pm-export-preview__close-btn"
            onClick={onClose}
            aria-label="Close export preview"
          >
            ✕
          </button>
        </div>
        <p className="pm-export-preview__sentence" data-testid="export-preview-sentence">
          {sentence}
        </p>
        <div className="pm-export-preview__format" role="radiogroup" aria-label="Export format">
          <button
            type="button"
            role="radio"
            aria-checked={format === 'pptx'}
            data-testid="export-format-pptx"
            className={`pm-export-preview__format-btn ${format === 'pptx' ? 'pm-export-preview__format-btn--selected' : ''}`}
            onClick={() => setFormat('pptx')}
          >
            PowerPoint (.pptx)
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={format === 'docx'}
            data-testid="export-format-docx"
            className={`pm-export-preview__format-btn ${format === 'docx' ? 'pm-export-preview__format-btn--selected' : ''}`}
            onClick={() => setFormat('docx')}
          >
            Word (.docx)
          </button>
        </div>
        <div className="pm-export-preview__actions">
          <button
            type="button"
            className="pm-export-preview__btn pm-export-preview__btn--secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="pm-export-preview__btn pm-export-preview__btn--primary"
            data-testid="export-confirm"
            onClick={() => onConfirm(format)}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
};
