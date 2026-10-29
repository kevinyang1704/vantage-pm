/**
 * Flag-dependent collaboration reachability (Story 27.5/27.9, item 10).
 *
 * With the collaboration flag OFF, the CSP `connect-src` stays at the 26.8
 * baseline and no service origin is compiled in, so a local build can make no
 * collaboration request. With it ON, exactly one configured service origin is
 * added for HTTPS and its WSS stream (plain http/ws only for a loopback
 * development service). Pure so the build and tests share one definition.
 */

export interface CollaborationEndpoint {
  readonly httpOrigin: string;
  readonly wsOrigin: string;
}

/** Validate and normalize the configured service origin; throws on anything else. */
export function parseCollaborationOrigin(raw: string): CollaborationEndpoint {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PMAPP_COLLABORATION_ORIGIN must be an exact https origin');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  const secure = url.protocol === 'https:';
  if ((!secure && !(url.protocol === 'http:' && loopback)) || url.username || url.password
    || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || raw.endsWith('/')) {
    throw new Error('PMAPP_COLLABORATION_ORIGIN must be an exact https origin');
  }
  const httpOrigin = url.origin;
  return Object.freeze({ httpOrigin, wsOrigin: httpOrigin.replace(/^http/, 'ws') });
}

/** Add the service to `connect-src` in a CSP string; other directives untouched. */
export function withCollaborationConnectSrc(csp: string, endpoint: CollaborationEndpoint): string {
  let found = false;
  const directives = csp.split(';').map((directive) => {
    const trimmed = directive.trim();
    if (!trimmed.startsWith('connect-src ')) return directive;
    found = true;
    const sources = new Set(trimmed.slice('connect-src '.length).split(/\s+/).filter(Boolean));
    sources.add(endpoint.httpOrigin);
    sources.add(endpoint.wsOrigin);
    return `${directive.match(/^\s*/)?.[0] ?? ''}connect-src ${[...sources].join(' ')}`;
  });
  if (!found) throw new Error('CSP has no connect-src directive');
  return directives.join(';');
}

/** Rewrite the `<meta http-equiv="Content-Security-Policy">` in an HTML page. */
export function injectCollaborationCsp(html: string, endpoint: CollaborationEndpoint): string {
  const pattern = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/i;
  const match = pattern.exec(html);
  if (!match) throw new Error('index.html has no Content-Security-Policy meta tag');
  return html.replace(pattern, `${match[1]}${withCollaborationConnectSrc(match[2], endpoint)}${match[3]}`);
}
