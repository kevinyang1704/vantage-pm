/**
 * DOCX document formatter (Story 8.4 Task 3, Story 16.4, AD-12, AD-16).
 *
 * Pure DOCX-construction formatter: maps a DocumentProjection into a `docx`
 * library `Document` object. No I/O, no Packer call, no clock read — the clock
 * value arrives already-resolved via `meta.generatedAtISO`.
 *
 * Every figure (dates, phase, acceptance ratio) is carried through from the
 * projection verbatim — never recomputed here (AC2). Computed figures render
 * with a dedicated `ComputedFigure` style AND bracket-delimited text, so the
 * "system computed this" vs "user wrote this" distinction is provable two
 * independent ways (style ID and literal bracket text).
 *
 * Story 16.4 (E16-FR6, E16-FR7, E16-AR3): the renderer also formats the
 * Markdown AST into native Word paragraphs/headings/bold runs/bullet items,
 * renders the amber Open Questions callout as a shaded 1x1 table (suppressed
 * cleanly when 0 questions exist), and formats the 2-column executive
 * metadata table for Feature 1-Pagers.
 */

import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  TableOfContents,
} from 'docx';
import type { DocumentProjection, DocumentSectionNode } from '../../contracts/document';
import { parseMarkdown, parseInline } from '../../domain/markdown/markdown-ast';

export interface DocxDocumentMeta {
  readonly generatedAtISO: string; // injected clock value, never read here
}

export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const COMPUTED_STYLE_ID = 'ComputedFigure';
const CALLOUT_STYLE_ID = 'OpenQuestionsCallout';

/** Map a headingLevel (1..6) to a docx HeadingLevel. */
function toHeadingLevel(level: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (level) {
    case 1: return HeadingLevel.HEADING_1;
    case 2: return HeadingLevel.HEADING_2;
    case 3: return HeadingLevel.HEADING_3;
    case 4: return HeadingLevel.HEADING_4;
    case 5: return HeadingLevel.HEADING_5;
    default: return HeadingLevel.HEADING_6;
  }
}

/** Format ISO YYYY-MM-DD as "Mon D, YYYY" (deterministic, no system clock). */
function formatDate(iso: string): string {
  const parts = iso.split('-');
  if (parts.length < 3) return iso;
  const [y, m, d] = parts.map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

/** Render a Markdown block AST into native Word paragraphs (Story 16.4 AC1). */
function markdownBlocksToParagraphs(section: DocumentSectionNode): Paragraph[] {
  const out: Paragraph[] = [];
  const blocks = parseMarkdown(section.bodyText ?? '');

  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        const level = Math.min(block.level + 1, 6);
        out.push(
          new Paragraph({
            heading: toHeadingLevel(level),
            children: [new TextRun({ text: block.text })],
            spacing: { before: 180, after: 60 },
          }),
        );
        break;
      }
      case 'bullet': {
        const inlines = parseInline(block.text);
        out.push(
          new Paragraph({
            bullet: { level: 0 },
            children: inlines.map((node) => {
              switch (node.kind) {
                case 'bold':
                  return new TextRun({ text: node.text, bold: true });
                case 'italic':
                  return new TextRun({ text: node.text, italics: true });
                case 'code':
                  return new TextRun({ text: node.text, font: 'Consolas' });
                default:
                  return new TextRun({ text: node.text });
              }
            }),
            spacing: { before: 40, after: 40 },
          }),
        );
        break;
      }
      case 'code':
        out.push(
          new Paragraph({
            children: [new TextRun({ text: block.text, font: 'Consolas' })],
            spacing: { before: 80, after: 80 },
          }),
        );
        break;
      default: {
        const inlines = parseInline(block.text);
        out.push(
          new Paragraph({
            children: inlines.map((node) => {
              switch (node.kind) {
                case 'bold':
                  return new TextRun({ text: node.text, bold: true });
                case 'italic':
                  return new TextRun({ text: node.text, italics: true });
                case 'code':
                  return new TextRun({ text: node.text, font: 'Consolas' });
                default:
                  return new TextRun({ text: node.text });
              }
            }),
            spacing: { before: 60, after: 60 },
          }),
        );
      }
    }
  }
  return out;
}

/** Amber Open Questions callout as a shaded 1x1 table (Story 16.4 AC1). */
function openQuestionsCallout(section: DocumentSectionNode): Table | null {
  if (section.openQuestionsCount === 0) return null;
  const lines: string[] = [];
  for (const q of section.openQuestions) {
    if (q.status === 'OPEN') {
      lines.push(`❓ ${q.questionText}`);
    } else {
      lines.push(`✅ ${q.questionText} — ${q.decisionText ?? 'Decided'}`);
    }
  }
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, fill: 'FFF3D6' },
            children: [
              new Paragraph({
                children: [new TextRun({ text: 'Open Questions & Decisions', bold: true, color: '8A5A00' })],
                spacing: { before: 60, after: 60 },
              }),
              ...lines.map((line) => new Paragraph({ children: [new TextRun({ text: line })], spacing: { before: 30, after: 30 } })),
            ],
          }),
        ],
      }),
    ],
  });
}

/** 2-column executive metadata table for Feature 1-Pagers (Story 16.4 AC1). */
export function metadataTable(rows: readonly Readonly<{ label: string; value: string | null }>[]): Table | null {
  const present = rows.filter((r) => r.value !== null && r.value.trim().length > 0);
  if (present.length === 0) return null;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: present.map(
      (r) =>
        new TableRow({
          children: [
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: r.label, bold: true })] })],
            }),
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: r.value ?? '' })] })],
            }),
          ],
        }),
    ),
  });
}

export function buildDocxDocument(
  projection: DocumentProjection,
  meta: DocxDocumentMeta,
): Document {
  const children: (Paragraph | Table | TableOfContents)[] = [];

  // 1. Document Header / Title Banner
  if (projection.projectName) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text: projection.projectName, bold: true, color: '0F172A' })],
        spacing: { before: 0, after: 80 },
      }),
    );

    const dateStr = meta.generatedAtISO.length >= 10 ? formatDate(meta.generatedAtISO.slice(0, 10)) : meta.generatedAtISO;
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: 'Project Outline & Specification', bold: true, color: '475569' }),
          new TextRun({
            text: `  ·  Generated ${dateStr}  ·  Revision ${projection.projectRevision}  ·  ${projection.sections.length} Sections`,
            color: '64748B',
            italics: true,
          }),
        ],
        spacing: { before: 0, after: 200 },
      }),
    );
  }

  // 2. Interactive Table of Contents (for multi-section outlines)
  if (projection.sections.length > 1) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: 'Table of Contents', bold: true, color: '1E293B' })],
        spacing: { before: 120, after: 80 },
      }),
      new TableOfContents('Table of Contents', {
        hyperlink: true,
        headingStyleRange: '1-3',
      }),
      new Paragraph({
        children: [],
        spacing: { before: 0, after: 240 },
      }),
    );
  }

  // 3. Hierarchical Sections
  for (const section of projection.sections) {
    // Heading with Type Tag Badge (native Word HeadingLevel 1..6 for collapsible navigation)
    const headingRuns: TextRun[] = [
      new TextRun({ text: section.title }),
    ];
    if (section.typeTag && section.typeTag !== 'NO TYPE') {
      headingRuns.push(
        new TextRun({
          text: `  [${section.typeTag}]`,
          size: 18,
          bold: true,
          color: '64748B',
        }),
      );
    }

    children.push(
      new Paragraph({
        heading: toHeadingLevel(section.headingLevel),
        children: headingRuns,
        spacing: { before: 240, after: 60 },
      }),
    );

    // Date/phase/schedule metadata sub-bar (muted + italic).
    const metaParts: string[] = [];
    if (section.effectivePhaseName) {
      metaParts.push(`Phase: ${section.effectivePhaseName}`);
    }
    if (section.startDate && section.endDate) {
      const durText = section.durationDays !== null ? ` (${section.durationDays} days)` : '';
      metaParts.push(`${formatDate(section.startDate)} – ${formatDate(section.endDate)}${durText}`);
    }
    if (section.acceptanceRatioText) {
      metaParts.push(`Progress: ${section.acceptanceRatioText}`);
    }
    if (metaParts.length > 0) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: metaParts.join(' · '), italics: true, color: '64748B' })],
          spacing: { before: 0, after: 100 },
        }),
      );
    }

    // Amber Open Questions callout (suppressed when 0 questions).
    const callout = openQuestionsCallout(section);
    if (callout) {
      children.push(callout);
    }

    // Body text (Brief / Narrative from Markdown AST)
    if (section.bodyText !== null) {
      children.push(...markdownBlocksToParagraphs(section));
    }

    // Acceptance Criteria (rendered as styled checkboxes)
    if (section.acceptanceCriteria.length > 0) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: 'Acceptance Criteria:', bold: true, color: '334155' })],
          spacing: { before: 120, after: 60 },
        }),
      );
      for (const ac of section.acceptanceCriteria) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            children: [
              new TextRun({
                text: ac.completed ? '☑ ' : '☐ ',
                bold: true,
                color: ac.completed ? '166534' : '64748B',
              }),
              new TextRun({
                text: ac.title,
                bold: ac.completed,
                color: ac.completed ? '166534' : '1E293B',
              }),
              ...(ac.bodyText ? [new TextRun({ text: ` — ${ac.bodyText}`, italics: true, color: '64748B' })] : []),
            ],
            spacing: { before: 30, after: 30 },
          }),
        );
      }
    }

    // Standalone Computed Figure (if separate ratio text provided)
    if (section.acceptanceRatioText && metaParts.length === 0) {
      children.push(
        new Paragraph({
          style: COMPUTED_STYLE_ID,
          children: [new TextRun({ text: `[${section.acceptanceRatioText}]` })],
          spacing: { before: 60, after: 60 },
        }),
      );
    }
  }

  // 4. Document Footer Stamp
  const stamp = `Generated ${meta.generatedAtISO} from ${projection.projectName}`;
  children.push(
    new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [new TextRun({ text: stamp, italics: true, color: '79839A' })],
      spacing: { before: 240, after: 0 },
    }),
  );

  return new Document({
    styles: {
      default: {
        document: { run: { font: projection.style.bodyFontFamily, size: projection.style.baseFontSizePt * 2, color: '1E293B' } },
        heading1: {
          run: { font: projection.style.headingFontFamily, size: 32, bold: true, color: '0F172A' },
          paragraph: { spacing: { before: 360, after: 120 } },
        },
        heading2: {
          run: { font: projection.style.headingFontFamily, size: 26, bold: true, color: '1E293B' },
          paragraph: { spacing: { before: 280, after: 100 } },
        },
        heading3: {
          run: { font: projection.style.headingFontFamily, size: 22, bold: true, color: '334155' },
          paragraph: { spacing: { before: 200, after: 80 } },
        },
        title: {
          run: { font: projection.style.headingFontFamily, size: 48, bold: true, color: '0F172A' },
          paragraph: { spacing: { before: 0, after: 100 } },
        },
      },
      paragraphStyles: [
        {
          id: COMPUTED_STYLE_ID,
          name: 'Computed Figure',
          basedOn: 'Normal',
          run: { italics: true, color: '79839A' },
        },
        {
          id: CALLOUT_STYLE_ID,
          name: 'Open Questions Callout',
          basedOn: 'Normal',
          run: { color: '8A5A00' },
        },
      ],
    },
    sections: [{ children }],
  });
}

/**
 * Render a DocumentProjection to DOCX bytes (ArrayBuffer) via the docx library.
 *
 * Uses Packer.toBlob (not toBuffer): toBuffer requires Node's Buffer, but this
 * renderer runs in the browser export worker (and under Vitest's Node env,
 * where global Blob is available in Node 24+).
 */
export async function renderDocx(
  projection: DocumentProjection,
  meta: DocxDocumentMeta,
): Promise<ArrayBuffer> {
  const document = buildDocxDocument(projection, meta);
  const blob = await Packer.toBlob(document);
  return blob.arrayBuffer();
}
