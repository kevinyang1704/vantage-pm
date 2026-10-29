import { defineConfig, type PluginOption } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { computeNativeBuildIdentity, hashBuild } from './spikes/phase-0-durability/tauri-build-identity';
import { injectCollaborationCsp, parseCollaborationOrigin } from './src/app/collaboration-csp';

export default defineConfig(({ mode }) => {
  // Any `tauri*` mode is the native desktop composition (tauri, tauri-qualification,
  // tauri-collaboration, …). The collaboration suffix must NOT drop the native
  // bridge, identity or the sqlite-wasm exclusion (H09).
  const isTauri = mode === 'tauri' || mode.startsWith('tauri-');
  const isQualification = mode === 'tauri-qualification';
  const nativeIdentity = isTauri ? computeNativeBuildIdentity() : null;
  // Story 27.1/27.9 (AD-20, item 10): with the flag off no service origin is
  // compiled in and the CSP stays at baseline. With it on, an exact service
  // origin is required when one is configured and is added to connect-src.
  const collaborationEnabled = process.env.PMAPP_COLLABORATION === '1' || mode.endsWith('-collaboration');
  const collaborationEndpoint = collaborationEnabled && process.env.PMAPP_COLLABORATION_ORIGIN
    ? parseCollaborationOrigin(process.env.PMAPP_COLLABORATION_ORIGIN)
    : null;
  const collaborationCspPlugin: PluginOption[] = collaborationEndpoint
    ? [{ name: 'pmapp-collaboration-csp', transformIndexHtml: (html: string) => injectCollaborationCsp(html, collaborationEndpoint) }]
    : [];
  return {
    root: '.',
    base: './',
    // Optional override for the dependency pre-bundle cache. A git worktree
    // that links the main checkout's node_modules would otherwise share
    // node_modules/.vite with the main dev server and make its deps outdated.
    ...(process.env.PMAPP_VITE_CACHE_DIR ? { cacheDir: process.env.PMAPP_VITE_CACHE_DIR } : {}),
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      manifest: true,
      // Never inline fonts as data: URIs: the CSP allows `font-src 'self'`, so
      // inlined font subsets (the small Plus Jakarta Sans ones fall under the
      // default 4 KB limit) were blocked. Other assets keep the default rule.
      assetsInlineLimit: (filePath: string) => (/\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined),
      rollupOptions: {
        input: 'index.html',
      },
    },
    define: {
      __TAURI_NATIVE_BRIDGE__: JSON.stringify(isTauri),
      __PMAPP_QUALIFICATION_BUILD__: JSON.stringify(isQualification),
      // Story 27.1 (AD-20): the collaboration feature flag. OFF in production
      // builds until 27.10 certifies; a pre-release build can pass
      // `--mode tauri-collaboration` (or set PMAPP_COLLABORATION=1) to dogfood.
      __PMAPP_COLLABORATION__: JSON.stringify(collaborationEnabled),
      __PMAPP_COLLABORATION_ORIGIN__: JSON.stringify(collaborationEndpoint?.httpOrigin ?? ''),
      ...(nativeIdentity
        ? { __PMAPP_NATIVE_BUILD_IDENTITY__: JSON.stringify(nativeIdentity) }
        : {}),
    },
    resolve: isTauri
      ? {
          alias: [
            {
              find: '@sqlite.org/sqlite-wasm',
              replacement: '/src/adapters/persistence/sqlite-wasm-unavailable.ts',
            },
          ],
        }
      : undefined,
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      // Native build output and bundled runtimes are not frontend sources.
      // Watching these large local trees stalls cold browser-test startup.
      watch: { ignored: ['**/target/**', '**/.tools/**', '**/.stryker-tmp/**'] },
      fs: {
        allow: ['..', '.', 'C:/Projects/PMApp/node_modules'],
      },
      headers: isTauri
        ? {}
        : {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Service-Worker-Allowed': '/',
          },
    },
    worker: { format: 'es' },
    preview: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      headers: isTauri
        ? {}
        : {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Service-Worker-Allowed': '/',
          },
    },
    plugins: [...collaborationCspPlugin, ...(isTauri
      ? [<PluginOption>{
          name: 'pmapp-native-build-identity',
          generateBundle() {
            this.emitFile({
              type: 'asset',
              fileName: 'pmapp-native-build-identity.json',
              source: `${JSON.stringify({ mode, ...nativeIdentity }, null, 2)}\n`,
            });
          },
        }]
      : [
          VitePWA({
            registerType: 'autoUpdate',
            workbox: {
              globPatterns: ['**/*.{js,css,html,wasm,json,svg,png}'],
              // The main bundle (~3 MB minified) exceeds workbox's 2 MiB default
              // precache limit; the sqlite-wasm asset is larger still.
              maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
            },
            manifest: {
              name: 'Vantage',
              short_name: 'Vantage',
              description: 'Local-first product management platform',
              theme_color: '#0A0C10',
              background_color: '#0A0C10',
              display: 'standalone',
              start_url: './',
              icons: [
                {
                  src: 'icon-192.png',
                  sizes: '192x192',
                  type: 'image/png',
                },
                {
                  src: 'icon-512.png',
                  sizes: '512x512',
                  type: 'image/png',
                },
              ],
            },
          }),
        ])],
  };
});
