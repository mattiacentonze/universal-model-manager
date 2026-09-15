import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Host-aware loader for Universal Model Manager TUI.
//
// In OpenCode hosts, plugin source compiles through @opentui/solid/scripts/solid-transform
// and resolves module imports through virtual runtime modules:
//   opentui:runtime-module:<encodeURIComponent('@opentui/solid')>
//
// When the host has installed that virtual resolver, importing via it shares the host's
// single Solid/OpenTUI runtime instance, enabling reactive state and mouse click handlers.
const RUNTIME_MODULE_ID = `opentui:runtime-module:${encodeURIComponent('@opentui/solid')}`
const ENTRY_DIR = dirname(fileURLToPath(import.meta.url))
const COMPILED_ENTRY = pathToFileURL(
  resolve(ENTRY_DIR, '../tui-compiled/tui.tsx'),
).href
const RAW_ENTRY = pathToFileURL(resolve(ENTRY_DIR, '../tui.tsx')).href
const DIST_ENTRY = pathToFileURL(resolve(ENTRY_DIR, '../../dist/tui.js')).href

function isMissingModuleError(error) {
  if (!error) return false
  const code =
    typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND')
    return true
  const message = typeof error.message === 'string' ? error.message : ''
  return /cannot find module|module not found|unable to resolve|ENOENT/i.test(message)
}

async function probeVirtualRuntime() {
  try {
    await import(RUNTIME_MODULE_ID)
    return true
  } catch (error) {
    if (isMissingModuleError(error)) return false
    throw error
  }
}

async function importWithFallback() {
  const compiledAvailable = await probeVirtualRuntime()
  if (compiledAvailable) {
    try {
      return await import(COMPILED_ENTRY)
    } catch (error) {
      console.error('[universal-model-manager-tui] Failed to load compiled TUI:', error)
    }
  }

  try {
    return await import(RAW_ENTRY)
  } catch {
    return await import(DIST_ENTRY)
  }
}

const mod = await importWithFallback()

export default mod?.default ?? mod?.tui ?? mod
