import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// entry.mjs lives at <pkg>/src/tui/entry.mjs. The compiled module is shipped
// at <pkg>/dist/tui.js; dev source lives at <pkg>/src/tui.tsx.
const ENTRY_DIR = dirname(fileURLToPath(import.meta.url))
const CANDIDATES = [
  resolve(ENTRY_DIR, '../../dist/tui.js'),
  resolve(ENTRY_DIR, '../tui.js'),
  resolve(ENTRY_DIR, '../tui.tsx'),
]

let mod
let lastError
for (const file of CANDIDATES) {
  try {
    mod = await import(pathToFileURL(file).href)
    if (mod?.default) break
  } catch (e) {
    lastError = e
  }
}

if (!mod?.default) {
  console.error('[universal-auth-tui] Failed to load TUI plugin:', lastError)
  throw lastError
}

export default mod.default
