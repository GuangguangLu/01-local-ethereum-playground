import { defineConfig } from 'vite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default defineConfig({
  root: './frontend',
  // Keep Vite's frequently renamed dependency cache outside Dropbox.
  // Dropbox can briefly lock node_modules/.vite and cause EBUSY on Windows.
  cacheDir: join(tmpdir(), 'vite-cache', 'lab1-local-ethereum-playground'),
  server: {
    open: true,
    port: 5173,
  },
})
