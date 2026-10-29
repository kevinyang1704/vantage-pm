/**
 * PPTX slide renderer (Story 8.3 Task 5, AD-12).
 *
 * Imperative shell: consumes a fully-positioned GanttPptxSlidePlan and draws
 * it with pptxgenjs at the already-computed inch coordinates. Contains ZERO
 * date arithmetic, ZERO membership logic, and ZERO graph-fact computation —
 * every number here was already produced by buildGanttPptxSlidePlan.
 */

import PptxGenJS from 'pptxgenjs';
import type { GanttPptxSlidePlan } from '../../application/gantt/gantt-pptx.projection';

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export { PPTX_MIME };

// Static hex tokens (CSS variables don't resolve inside pptxgenjs) —
// consistent with the --pm-* values used in GanttTimelineCanvas.
const COLOR_BG = '0A0C10';
const COLOR_HIERARCHY_BG = '12151C';
const COLOR_BORDER = '232936';
const COLOR_TEXT = 'E6EAF2';
const COLOR_MUTED = '79839A';
const COLOR_ACCENT = '2F6BFF';
const COLOR_DERIVED = '4C5E81';
const COLOR_VIOLATING = 'E5566D';

// Workstream ramp — dark-mode hexes, matching the --pm-workstream-N tokens the
// on-screen Gantt uses (see meridian.tokens.ts). Index 0 = hue 1.
const WORKSTREAM_HEX = ['4179FF', '2CA8E0', '4FC06A', 'A98BFF', 'F2739E', 'F0863F'];

function workstreamHex(hueIndex: number | null): string | null {
  if (hueIndex === null) return null;
  return WORKSTREAM_HEX[(hueIndex - 1) % WORKSTREAM_HEX.length] ?? null;
}

/**
 * Render a Gantt slide plan to PPTX bytes (ArrayBuffer).
 */
export async function renderGanttPptx(plan: GanttPptxSlidePlan): Promise<ArrayBuffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5

  const slide = pptx.addSlide();
  slide.background = { color: COLOR_BG };

  // Header columns
  for (const col of plan.headerColumns) {
    slide.addText(col.label, {
      x: col.xIn,
      y: 0.1,
      w: col.wIn,
      h: 0.34,
      fontSize: 10,
      color: COLOR_MUTED,
      bold: true,
      align: 'left',
      valign: 'middle',
      fill: { color: COLOR_HIERARCHY_BG },
    });
  }

  // Hierarchy labels (left column)
  for (const label of plan.hierarchyLabels) {
    slide.addText(label.text, {
      x: label.xIn,
      y: label.yIn,
      w: label.wIn,
      h: label.hIn,
      fontSize: 10,
      color: label.bold ? COLOR_TEXT : COLOR_MUTED,
      bold: label.bold,
      align: 'left',
      valign: 'middle',
      breakLine: false,
    });
  }

  // Bars — authored bars fill with their workstream hue (screen parity); derived
  // rollup spans take the same hue as their outline, else the neutral derived tone.
  for (const bar of plan.bars) {
    const wsHex = workstreamHex(bar.workstreamHueIndex);
    if (bar.kind === 'authored') {
      slide.addShape(pptx.ShapeType.rect, {
        x: bar.xIn,
        y: bar.yIn,
        w: Math.max(0.05, bar.wIn),
        h: bar.hIn,
        fill: { color: wsHex ?? COLOR_ACCENT },
        line: { color: COLOR_BG, width: 0.5 },
      });
    } else {
      // Derived span: bracket treatment — an outline-only shape
      slide.addShape(pptx.ShapeType.rect, {
        x: bar.xIn,
        y: bar.yIn + 0.02,
        w: Math.max(0.05, bar.wIn),
        h: bar.hIn - 0.04,
        fill: { color: COLOR_BG, transparency: 100 },
        line: { color: wsHex ?? COLOR_DERIVED, width: 1.5 },
      });
    }
  }

  // Dependency lines (per consecutive pair of vertices)
  for (const dep of plan.dependencyLines) {
    const color = dep.isViolating ? COLOR_VIOLATING : COLOR_DERIVED;
    for (let i = 1; i < dep.points.length; i++) {
      slide.addShape(pptx.ShapeType.line, {
        x: dep.points[i - 1].xIn,
        y: dep.points[i - 1].yIn,
        w: Math.abs(dep.points[i].xIn - dep.points[i - 1].xIn),
        h: Math.abs(dep.points[i].yIn - dep.points[i - 1].yIn),
        line: { color, width: dep.isViolating ? 1.5 : 1 },
        lineHead: 'none',
        lineTail: 'none',
      });
    }
  }

  // Phase bands (footer rail)
  for (const band of plan.phaseBands) {
    slide.addShape(pptx.ShapeType.rect, {
      x: band.xIn,
      y: band.yIn,
      w: Math.max(0.2, band.wIn),
      h: band.hIn,
      fill: { color: COLOR_ACCENT, transparency: 80 },
      line: { color: COLOR_ACCENT, width: 0.5 },
    });
    slide.addText(band.label, {
      x: band.xIn + 0.02,
      y: band.yIn,
      w: Math.max(0.2, band.wIn) - 0.04,
      h: band.hIn,
      fontSize: 8,
      color: COLOR_ACCENT,
      bold: true,
      valign: 'middle',
    });
  }

  // Footer stamp + exclusion summary
  slide.addText(plan.footerStamp, {
    x: 0.2,
    y: 7.05,
    w: 12.9,
    h: 0.25,
    fontSize: 9,
    color: COLOR_MUTED,
    align: 'left',
  });
  slide.addText(plan.exclusionSummary, {
    x: 0.2,
    y: 7.25,
    w: 12.9,
    h: 0.2,
    fontSize: 8,
    color: COLOR_MUTED,
    align: 'left',
    italic: true,
  });

  const out = await pptx.write({ outputType: 'arraybuffer' });
  if (typeof out === 'string') {
    // Should not happen with outputType arraybuffer, but guard anyway.
    throw new Error('Unexpected string output from pptxgenjs write()');
  }
  return out as ArrayBuffer;
}
