#!/usr/bin/env node
/**
 * Production-bundle inspection check (Story 1.5 Task 7, AC5).
 * Scans the built output for AI/model dependency references, backend/API client
 * code, telemetry SDKs, hardcoded runtime secrets, or remote-configuration fetch
 * calls.
 *
 * Usage: node scripts/check-production-bundle.mjs [dist-dir]
 * Exit code: 0 = clean, 1 = violations found
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const DIST = process.argv[2] || 'dist';

const FORBIDDEN_PATTERNS = [
  // AI/model dependencies
  { pattern: /openai/i, label: 'OpenAI SDK reference' },
  { pattern: /anthropic/i, label: 'Anthropic SDK reference' },
  { pattern: /langchain/i, label: 'LangChain reference' },
  { pattern: /@?tensorflow/i, label: 'TensorFlow reference' },
  { pattern: /transformers\.js/i, label: 'Transformers.js reference' },
  // Backend/API clients
  { pattern: /axios/i, label: 'Axios HTTP client' },
  { pattern: /graphql-request/i, label: 'GraphQL client' },
  { pattern: /@?apollo\/client/i, label: 'Apollo client' },
  { pattern: /@?supabase/i, label: 'Supabase client' },
  { pattern: /firebase/i, label: 'Firebase SDK' },
  // Telemetry SDKs
  { pattern: /@?sentry/i, label: 'Sentry SDK' },
  { pattern: /@?datadog/i, label: 'Datadog SDK' },
  { pattern: /@?logrocket/i, label: 'LogRocket SDK' },
  { pattern: /@?posthog/i, label: 'PostHog SDK' },
  { pattern: /@?mixpanel/i, label: 'Mixpanel SDK' },
  { pattern: /google-analytics|gtag/i, label: 'Google Analytics' },
  // Remote configuration
  { pattern: /launchdarkly/i, label: 'LaunchDarkly SDK' },
  { pattern: /@?optimizely/i, label: 'Optimizely SDK' },
  // Hardcoded secrets (heuristic)
  { pattern: /api[_-]?key\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}['"]/, label: 'Hardcoded API key' },
  { pattern: /secret\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}['"]/, label: 'Hardcoded secret' },
  { pattern: /token\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}['"]/, label: 'Hardcoded token' },
  // Test surface leaks (Story 2.2 Task 6)
  { pattern: /__PMAPP_OUTLINE_FIXTURE__/i, label: 'Test fixture control surface leak' },
  { pattern: /\.test-only/i, label: 'Test-only module reference leak' },
];

function collectFiles(dir) {
  const files = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        files.push(...collectFiles(full));
      } else if (extname(entry) === '.js' || extname(entry) === '.mjs' || extname(entry) === '.html') {
        files.push(full);
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return files;
}

function main() {
  const files = collectFiles(DIST);
  if (files.length === 0) {
    console.log('check-production-bundle: No dist files found — nothing to check.');
    process.exit(0);
  }

  let violations = 0;

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    for (const { pattern, label } of FORBIDDEN_PATTERNS) {
      if (pattern.test(content)) {
        console.error(`VIOLATION: ${file} contains ${label}`);
        violations++;
      }
    }
  }

  if (violations > 0) {
    console.error(`\ncheck-production-bundle: ${violations} violation(s) found.`);
    console.error('Production bundle must contain no AI/model, backend, telemetry, secret, or remote-configuration references (AD-15).');
    process.exit(1);
  }

  console.log(`check-production-bundle: ${files.length} file(s) checked — clean.`);
  process.exit(0);
}

main();
