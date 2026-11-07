import { defineConfig, type Plugin, type ResolvedConfig } from 'vite'
import react from '@vitejs/plugin-react'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * The dev and preview servers must not follow `--host` onto a public address.
 * Undefined is Vite's own default, which it resolves to localhost.
 */
function loopbackOnly(): Plugin {
  const assertHost = (label: string, host: ResolvedConfig['server']['host']) => {
    if (host == null || (typeof host === 'string' && LOOPBACK_HOSTS.has(host))) return
    throw new Error(
      `JARVIS refuses to bind the ${label} to "${String(host)}". ` +
        'Use 127.0.0.1. Do not pass --host without that address.',
    )
  }
  return {
    name: 'jarvis-loopback-only',
    configResolved(config) {
      assertHost('dev server', config.server.host)
      assertHost('preview server', config.preview.host)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), loopbackOnly()],
  server: {
    // Literal loopback, not the hostname "localhost" and not 0.0.0.0. Honour
    // PORT so a second instance can run alongside the first. The bridge only
    // accepts sockets from localhost:5173-5199, so stay inside that range or
    // set JARVIS_ALLOWED_ORIGINS to match. strictPort avoids quietly moving
    // to a port the bridge will refuse.
    host: '127.0.0.1',
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
    allowedHosts: [],
    fs: { strict: true },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
})
