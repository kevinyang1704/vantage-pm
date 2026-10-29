import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { injectCollaborationCsp, parseCollaborationOrigin, withCollaborationConnectSrc } from './collaboration-csp';

const BASELINE = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' blob:; img-src 'self' data: blob:";

describe('flag-dependent collaboration CSP (item 10)', () => {
  it('accepts exact https origins and loopback development services only', () => {
    expect(parseCollaborationOrigin('https://sync-staging.example.com')).toEqual({
      httpOrigin: 'https://sync-staging.example.com', wsOrigin: 'wss://sync-staging.example.com',
    });
    expect(parseCollaborationOrigin('http://127.0.0.1:8787').wsOrigin).toBe('ws://127.0.0.1:8787');
    for (const bad of ['http://service.example', 'https://service.example/', 'https://service.example/path', 'https://u:p@service.example', 'https://service.example?x=1', '*', 'nonsense']) {
      expect(() => parseCollaborationOrigin(bad), bad).toThrow();
    }
  });

  it('adds exactly the service https and wss origins to connect-src', () => {
    const csp = withCollaborationConnectSrc(BASELINE, parseCollaborationOrigin('https://svc.example'));
    expect(csp).toContain("connect-src 'self' blob: https://svc.example wss://svc.example;");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(csp.match(/svc\.example/g)).toHaveLength(2);
    // Idempotent.
    expect(withCollaborationConnectSrc(csp, parseCollaborationOrigin('https://svc.example'))).toBe(csp);
    expect(() => withCollaborationConnectSrc("default-src 'self'", parseCollaborationOrigin('https://svc.example'))).toThrow();
  });

  it('rewrites the shipped index.html meta policy and nothing else', () => {
    const html = readFileSync('index.html', 'utf8');
    const rewritten = injectCollaborationCsp(html, parseCollaborationOrigin('https://svc.example'));
    expect(rewritten).toContain('https://svc.example wss://svc.example');
    expect(rewritten.replace(' https://svc.example wss://svc.example', '')).toBe(html);
  });
});
