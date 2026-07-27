import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Second build target, for the Codex / ChatGPT desktop-app PANE only.
//
// Produces ONE self-contained HTML file with every asset inlined. That matters:
// the pane is served to a sandboxed iframe as an MCP resource, so any external
// asset URL would be a request the sandbox refuses. One file, no fetches, no CSP
// surprises.
//
// This does not touch the normal build (vite.config.js -> src/vibefoundry/static/)
// that the standalone app serves. Both builds compile the same App.jsx; only the
// entry point differs — pane-main.jsx wraps it in the host bridge shims.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: './',
  build: {
    outDir: '../src/vibefoundry/pane',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000, // inline everything, no external asset URLs
    rollupOptions: {
      input: 'index.pane.html',
    },
  },
})
