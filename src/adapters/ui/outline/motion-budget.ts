/**
 * Motion budget scanner (Story 2.2 Task 5).
 * Validates that only the sanctioned 110ms ease-out metadata reveal is present.
 */

export interface MotionViolation {
  file: string;
  line: number;
  property: string;
  value: string;
  reason: string;
}

export function scanMotionBudget(content: string, filename = 'inline'): MotionViolation[] {
  const violations: MotionViolation[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//')) {
      continue;
    }

    const transMatch = /transition(?:-property)?\s*:\s*([^;]+);/.exec(line);
    if (transMatch) {
      const val = transMatch[1].trim();
      const isAllowed =
        val === 'opacity 110ms ease-out' ||
        val === 'opacity 0ms' ||
        val === 'none' ||
        val === 'opacity';
      if (!isAllowed) {
        violations.push({
          file: filename,
          line: i + 1,
          property: 'transition',
          value: val,
          reason:
            'EXPERIENCE.md Open Item #11 — no motion system is defined; 110 ms ease-out metadata reveal is the only specified duration.',
        });
      }
    }

    if (/\banimation(?:-name)?\s*:/.test(line) && !trimmed.includes('animation: none')) {
      violations.push({
        file: filename,
        line: i + 1,
        property: 'animation',
        value: trimmed,
        reason: 'EXPERIENCE.md Open Item #11 — animations are not permitted.',
      });
    }

    if (/@keyframes\b/.test(line)) {
      violations.push({
        file: filename,
        line: i + 1,
        property: '@keyframes',
        value: trimmed,
        reason: 'EXPERIENCE.md Open Item #11 — keyframe animations are not permitted.',
      });
    }
  }

  return violations;
}
