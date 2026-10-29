/**
 * 1-click starter brief templates (Story 16.2, E16-FR2).
 *
 * Optional scaffolding — inserting a template populates the markdown skeleton
 * without gating or forcing field completion (AC 3).
 */

import type { NodeType } from '../tree/node.entity';

export interface NodeBriefTemplate {
  readonly id: string;
  readonly label: string;
  readonly nodeType: NodeType;
  readonly description: string;
  readonly markdown: string;
}

export const FEATURE_BRIEF_TEMPLATE: NodeBriefTemplate = Object.freeze({
  id: 'feature-brief',
  label: 'Feature Brief',
  nodeType: 'Feature',
  description: 'Problem, Solution, Scope/Non-Goals',
  markdown: Object.freeze(
    [
      '## Problem',
      '',
      'What problem does this feature solve for the user?',
      '',
      '## Solution',
      '',
      'How does this feature solve it?',
      '',
      '## Scope / Non-Goals',
      '',
      '- In scope:',
      '- Out of scope:',
      '',
    ].join('\n'),
  ),
});

export const THEME_BRIEF_TEMPLATE: NodeBriefTemplate = Object.freeze({
  id: 'theme-brief',
  label: 'Theme Brief',
  nodeType: 'Theme',
  description: 'Strategic Objective, Persona, OKRs',
  markdown: Object.freeze(
    [
      '## Strategic Objective',
      '',
      'What strategic outcome does this theme advance?',
      '',
      '## Persona',
      '',
      'Who is the primary beneficiary?',
      '',
      '## OKRs',
      '',
      '- Objective 1:',
      '  - Key result 1:',
      '  - Key result 2:',
      '',
    ].join('\n'),
  ),
});

export const VISION_BRIEF_TEMPLATE: NodeBriefTemplate = Object.freeze({
  id: 'vision-brief',
  label: 'Vision Brief',
  nodeType: 'Vision',
  description: 'North Star, Pillars, Unfair Advantage',
  markdown: Object.freeze(
    [
      '## North Star',
      '',
      'What is the enduring north star for this product?',
      '',
      '## Pillars',
      '',
      '- Pillar 1:',
      '- Pillar 2:',
      '- Pillar 3:',
      '',
      '## Unfair Advantage',
      '',
      'What durable advantage makes this hard to copy?',
      '',
    ].join('\n'),
  ),
});

export const NODE_BRIEF_TEMPLATES: readonly NodeBriefTemplate[] = Object.freeze([
  FEATURE_BRIEF_TEMPLATE,
  THEME_BRIEF_TEMPLATE,
  VISION_BRIEF_TEMPLATE,
]);

export function templateForNodeType(nodeType: NodeType | null): NodeBriefTemplate | null {
  if (nodeType === null) return null;
  return NODE_BRIEF_TEMPLATES.find((t) => t.nodeType === nodeType) ?? null;
}
