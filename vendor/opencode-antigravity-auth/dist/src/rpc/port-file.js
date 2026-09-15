import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile, } from 'node:fs/promises';
import { join } from 'node:path';
const PORT_FILE_PATTERN = /^port-(\d+)\.json$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
export async function writePortFile(dir, entry) {
    assertPortFileEntry({ ...entry, startedAt: 0 }, entry.pid);
    // mkdir recursive with the private mode on first creation; on a re-run the
    // directory already exists with the right mode. We still re-apply chmod so
    // an operator who widened the directory accidentally gets it repaired
    // back to 0o700 before we drop a token-bearing file inside.
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await chmod(dir, DIR_MODE);
    const full = { ...entry, startedAt: Date.now() };
    const target = join(dir, `port-${entry.pid}.json`);
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(full), {
            encoding: 'utf8',
            mode: FILE_MODE,
        });
        await chmod(temporary, FILE_MODE);
        await rename(temporary, target);
    }
    catch (error) {
        try {
            await unlink(temporary);
        }
        catch { }
        throw error;
    }
    return target;
}
export async function discoverPortFile(dir, expectedPid) {
    let names;
    try {
        names = await readdir(dir);
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT'))
            return null;
        throw error;
    }
    const live = [];
    for (const name of names) {
        const match = PORT_FILE_PATTERN.exec(name);
        if (!match)
            continue;
        const path = join(dir, name);
        const filenamePid = Number(match[1]);
        let parsed;
        try {
            const text = await readFile(path, 'utf8');
            const raw = JSON.parse(text);
            assertPortFileEntry(raw, filenamePid);
            parsed = raw;
        }
        catch {
            // Malformed or stale — keep the directory clean so future discovers
            // don't trip over the same debris.
            await unlink(path).catch(() => { });
            continue;
        }
        if (!isProcessAlive(parsed.pid)) {
            await unlink(path).catch(() => { });
            continue;
        }
        live.push(parsed);
    }
    if (expectedPid !== undefined) {
        // antigravity exact-PID safety: a missing expected PID must surface as
        // null so a stale but live entry can't impersonate the requester.
        return live.find(({ pid }) => pid === expectedPid) ?? null;
    }
    if (live.length === 0)
        return null;
    live.sort((left, right) => right.startedAt - left.startedAt);
    return live[0] ?? null;
}
function assertPortFileEntry(value, filenamePid) {
    if (typeof value !== 'object' ||
        value === null ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        value.pid !== filenamePid ||
        !Number.isSafeInteger(value.port) ||
        value.port <= 0 ||
        value.port > 65_535 ||
        typeof value.token !== 'string' ||
        value.token.length === 0) {
        throw new Error('Invalid RPC port file');
    }
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return isNodeError(error, 'EPERM');
    }
}
function isNodeError(error, code) {
    return (error instanceof Error &&
        'code' in error &&
        error.code === code);
}
//# sourceMappingURL=port-file.js.map