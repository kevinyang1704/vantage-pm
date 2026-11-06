import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), 'app'));
const port = 5173;
const origin = `http://127.0.0.1:${port}`;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8' };
const server = createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
  const fail = (status) => { res.writeHead(status); res.end(); };
  if (req.headers.host !== `127.0.0.1:${port}`) return fail(403);
  if (!['GET', 'HEAD'].includes(req.method)) return fail(405);
  try {
    const path = decodeURIComponent(new URL(req.url, origin).pathname);
    if (path.includes('\0') || path.includes('\\')) return fail(400);
    const candidate = resolve(root, `.${path === '/' ? '/index.html' : path}`);
    if (!candidate.startsWith(root + sep)) return fail(403);
    const file = await realpath(candidate);
    if (!file.startsWith(root + sep)) return fail(403);
    const info = await stat(file);
    if (!info.isFile()) return fail(404);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch { if (!res.headersSent) fail(404); else res.destroy(); }
});
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is already in use. Close the other Vantage window or local server, then try again. The address is fixed to preserve access to your saved projects.`
    : `Could not start Vantage: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Vantage is running at ${origin}\nKeep this window open. Press Ctrl+C to stop.\nUse the same browser profile each time. Export projects before clearing browser data.`);
  if (!process.argv.includes('--no-open') && process.platform === 'win32') {
    const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', origin], { stdio: 'ignore', windowsHide: true });
    browser.on('error', () => console.log(`Open ${origin} in your browser.`));
    browser.unref();
  }
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
