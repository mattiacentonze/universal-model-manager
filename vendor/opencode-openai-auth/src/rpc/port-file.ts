import type { Dirent } from 'node:fs'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createLogger } from '../logger'

const log = createLogger('rpc')

export interface PortFileEntry {
  port: number
  token: string
  pid: number
  startedAt: number
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isManagedRpcStateDir(name: string): boolean {
  return /^(?:openai-auth-)?[0-9a-f]{16}$/.test(name)
}

function isUsablePortFileEntry(value: unknown): value is PortFileEntry {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { pid?: unknown }).pid === 'number' &&
    Number.isFinite((value as { pid: number }).pid) &&
    typeof (value as { port?: unknown }).port === 'number' &&
    Number.isFinite((value as { port: number }).port)
  )
}

async function removeCorruptPortFile(portFile: string): Promise<void> {
  log.debug('rpc corrupt port file', { pid: process.pid, portFile })
  await unlink(portFile).catch(() => {})
}

export async function writePortFile(
  dir: string,
  entry: { port: number; token: string; pid: number },
  options: {
    secureDir?: boolean
    beforeWrite?: () => void | Promise<void>
  } = {},
): Promise<string> {
  // The directory can be removed by another project's sweep between our
  // mkdir and the first writeFile/rename, so the whole create-then-rename
  // unit is retried once on ENOENT. The retry recreates the directory; a
  // persistent ENOENT (e.g. permission, read-only parent) will surface on
  // the second attempt — failing fast beats an unbounded loop.
  const writeOnce = async (): Promise<string> => {
    await mkdir(dir, {
      recursive: true,
      mode: options.secureDir ? 0o700 : undefined,
    })
    if (options.secureDir) await chmod(dir, 0o700)
    await options.beforeWrite?.()
    const full: PortFileEntry = { ...entry, startedAt: Date.now() }
    const target = join(dir, `port-${entry.pid}.json`)
    const tmp = `${target}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(full), {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(tmp, target)
    return target
  }
  try {
    return await writeOnce()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return await writeOnce()
    }
    throw error
  }
}

export async function sweepRpcState(
  root: string,
  activeDir: string,
): Promise<void> {
  let projectDirs: Dirent<string>[]
  try {
    projectDirs = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  const active = resolve(activeDir)
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory() || !isManagedRpcStateDir(projectDir.name)) {
      continue
    }
    const dir = join(root, projectDir.name)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const name of names) {
      if (!name.startsWith('port-') || !name.endsWith('.json')) continue
      const portFile = join(dir, name)
      let raw: string | undefined
      try {
        raw = await readFile(portFile, 'utf8')
      } catch {
        continue
      }
      if (raw === undefined) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        await removeCorruptPortFile(portFile)
        continue
      }
      if (!isUsablePortFileEntry(parsed)) {
        await removeCorruptPortFile(portFile)
        continue
      }
      const entry = parsed
      if (!pidAlive(entry.pid)) await unlink(portFile).catch(() => {})
    }
    if (resolve(dir) !== active) await rmdir(dir).catch(() => {})
  }
}

export async function discoverPortFile(
  dir: string,
  expectedPid?: number,
): Promise<PortFileEntry | null> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  const live: PortFileEntry[] = []
  for (const name of names) {
    if (!name.startsWith('port-') || !name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(
        await readFile(join(dir, name), 'utf8'),
      ) as PortFileEntry
      if (Number.isFinite(parsed.port)) {
        if (pidAlive(parsed.pid)) live.push(parsed)
        else unlink(join(dir, name)).catch(() => {})
      }
    } catch {}
  }
  if (live.length === 0) return null
  const candidates =
    expectedPid !== undefined && expectedPid >= 1
      ? live.filter((entry) => entry.pid === expectedPid)
      : []
  const entries = candidates.length > 0 ? candidates : live
  return entries.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
}
