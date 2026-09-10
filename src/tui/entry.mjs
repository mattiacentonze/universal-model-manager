import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ENTRY_DIR = dirname(fileURLToPath(import.meta.url))
const RAW_ENTRY = pathToFileURL(resolve(ENTRY_DIR, '../tui.js')).href

let mod
try {
  mod = await import(RAW_ENTRY)
} catch (error) {
  try {
    mod = await import(pathToFileURL(resolve(ENTRY_DIR, '../tui.tsx')).href)
  } catch (err2) {
    console.error('[universal-auth-tui] Failed to load TUI plugin:', error, err2)
    throw error
  }
}

export default mod.default
