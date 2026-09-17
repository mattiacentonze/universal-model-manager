// src/plugin/index.ts
import { createHash as createHash11 } from "node:crypto";
import { join as join19 } from "node:path";

// ../core/dist/account-manager.js
import { createHash } from "node:crypto";

// ../core/dist/account-storage.js
import { chmod, copyFile, mkdir as mkdir3, readFile as readFile2, unlink as unlink2 } from "node:fs/promises";

// ../core/dist/atomic-write.js
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
async function writeJsonAtomic(path5, value) {
  const serialized = `${JSON.stringify(value, null, 2)}
`;
  const tempPath = `${path5}.${randomUUID()}.tmp`;
  await mkdir(dirname(path5), { recursive: true });
  let renamed = false;
  try {
    await writeFile(tempPath, serialized, {
      encoding: "utf8",
      mode: 384
    });
    await rename(tempPath, path5);
    renamed = true;
  } finally {
    if (!renamed) {
      await rm(tempPath, { force: true }).catch(() => {
      });
    }
  }
}

// ../core/dist/file-lock.js
import { randomUUID as randomUUID2 } from "node:crypto";
import { mkdir as mkdir2, readFile, rename as rename2, rm as rm2, stat, unlink, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2, join } from "node:path";
var RENEW_MIN_INTERVAL_MS = 1e3;
var MARKER_CLAIM_MAX_ATTEMPTS = 8;
var MARKER_CLAIM_BACKOFF_MS = 25;
var FileLockOwnershipError = class extends Error {
  details;
  constructor(message, details) {
    super(message);
    this.name = "FileLockOwnershipError";
    this.details = details;
  }
};
var MARKER_TTL_MS = 3e4;
async function readLockPayload(path5) {
  try {
    const text = await readFile(path5, "utf8");
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.ownerId === "string" && typeof parsed.expiresAt === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
async function readMarkerPayload(path5) {
  try {
    const text = await readFile(path5, "utf8");
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.ownerId === "string" && typeof parsed.pid === "number" && typeof parsed.createdAt === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err.code;
    if (code === "ESRCH")
      return false;
    return true;
  }
}
async function rmEvictingDir(evictingPath) {
  await rm2(evictingPath, { force: true }).catch(() => {
  });
  await rm2(dirname2(evictingPath), { recursive: true, force: true }).catch(() => {
  });
}
async function sleep(ms) {
  await new Promise((resolve3) => setTimeout(resolve3, ms));
}
async function acquireFencedFileLock(options) {
  const lockPath = `${options.path}.${options.name}.lock`;
  const evictingDir = `${lockPath}.evicting`;
  const evictingPath = join(evictingDir, "owner.json");
  const ownerId = randomUUID2();
  const now = options.now ?? Date.now;
  const tryAcquire = async (expiresAt) => {
    const payload = JSON.stringify({ ownerId, expiresAt });
    try {
      await mkdir2(dirname2(lockPath), { recursive: true });
      await writeFile2(lockPath, payload, {
        flag: "wx",
        encoding: "utf8",
        mode: 384
      });
      return buildLock(lockPath, evictingPath, ownerId, options, now);
    } catch (err) {
      if (err.code === "EEXIST") {
        return null;
      }
      throw err;
    }
  };
  for (; ; ) {
    const firstTry = await tryAcquire(now() + options.ttlMs);
    if (firstTry)
      return firstTry;
    const observed = await readLockPayload(lockPath);
    const lockStats = await stat(lockPath).catch(() => null);
    if (!lockStats)
      continue;
    const currentTime = now();
    const looksLive = observed !== null && typeof observed.ownerId === "string" && observed.expiresAt > currentTime;
    if (looksLive) {
      return null;
    }
    const looksValid = observed !== null;
    if (!looksValid) {
      const ageMs = currentTime - lockStats.mtimeMs;
      if (ageMs < options.ttlMs)
        return null;
    }
    await options.onStep?.("stale-marker-stat");
    let markerClaimed = false;
    for (let attempt = 0; attempt < MARKER_CLAIM_MAX_ATTEMPTS; attempt++) {
      try {
        await mkdir2(evictingDir, { recursive: true, mode: 448 });
        await writeFile2(evictingPath, JSON.stringify({
          ownerId,
          pid: process.pid,
          createdAt: now()
        }), {
          flag: "wx",
          encoding: "utf8",
          mode: 384
        });
        markerClaimed = true;
        break;
      } catch (err) {
        if (err.code !== "EEXIST")
          throw err;
        const existing = await readMarkerPayload(evictingPath);
        if (existing) {
          const ageMs = now() - existing.createdAt;
          const deadPid = !isProcessAlive(existing.pid);
          if (deadPid || ageMs > MARKER_TTL_MS) {
            await rmEvictingDir(evictingPath);
            continue;
          }
        }
        await sleep(MARKER_CLAIM_BACKOFF_MS);
      }
    }
    if (!markerClaimed) {
      return null;
    }
    await options.onStep?.("stale-marker-claimed");
    let markerPayload = await readMarkerPayload(evictingPath);
    if (markerPayload?.ownerId !== ownerId)
      continue;
    const observedAgain = await readLockPayload(lockPath);
    const refreshed = observedAgain !== null && observedAgain.ownerId !== ownerId && observedAgain.expiresAt > now();
    if (refreshed) {
      await rmEvictingDir(evictingPath);
      return null;
    }
    await options.onStep?.("stale-lock-confirmed");
    markerPayload = await readMarkerPayload(evictingPath);
    if (markerPayload?.ownerId !== ownerId)
      continue;
    try {
      await unlink(lockPath);
    } catch (err) {
      const code = err.code;
      if (code !== "ENOENT") {
        await rmEvictingDir(evictingPath);
        continue;
      }
    }
    await options.onStep?.("eviction-marker-acquired");
    const reentry = await tryAcquire(now() + options.ttlMs);
    if (reentry) {
      await rmEvictingDir(evictingPath);
      return reentry;
    }
    await rmEvictingDir(evictingPath);
  }
}
function buildLock(lockPath, evictingPath, ownerId, options, now) {
  let renewTimer = null;
  let inFlightRenew = null;
  let released = false;
  let lost = false;
  let lostResolve = null;
  let lostPromise = new Promise((resolve3) => {
    lostResolve = resolve3;
  });
  const markLost = () => {
    if (lost)
      return;
    lost = true;
    if (renewTimer !== null) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
    const resolve3 = lostResolve;
    lostResolve = null;
    resolve3?.();
  };
  const setupRenew = () => {
    if (options.renew === false)
      return;
    const interval = options.renewIntervalMs ?? Math.max(RENEW_MIN_INTERVAL_MS, Math.floor(options.ttlMs / 3));
    const renew = async () => {
      if (released || lost)
        return;
      try {
        const observed = await readLockPayload(lockPath);
        if (released || lost)
          return;
        await options.onStep?.("renew-read");
        if (released || lost)
          return;
        if (observed === null) {
          markLost();
          return;
        }
        if (observed.ownerId !== ownerId) {
          markLost();
          return;
        }
        if (observed.expiresAt > now()) {
          if (released || lost)
            return;
          const tempPath = `${lockPath}.${ownerId}.tmp`;
          let shouldCommit = false;
          try {
            await writeFile2(tempPath, JSON.stringify({
              ownerId,
              expiresAt: now() + options.ttlMs
            }), { encoding: "utf8", mode: 384 });
            if (released || lost) {
              await unlink(tempPath).catch(() => {
              });
              return;
            }
            const currentObserved = await readLockPayload(lockPath);
            if (released || lost) {
              await unlink(tempPath).catch(() => {
              });
              return;
            }
            if (!currentObserved || currentObserved.ownerId !== ownerId) {
              markLost();
              await unlink(tempPath).catch(() => {
              });
              return;
            }
            shouldCommit = true;
            await rename2(tempPath, lockPath);
            await options.onStep?.("renew-committed");
            if (released || lost)
              return;
            const committed = await readLockPayload(lockPath);
            if (released || lost)
              return;
            if (!committed || committed.ownerId !== ownerId) {
              markLost();
              return;
            }
          } catch {
            markLost();
            if (!shouldCommit) {
              await unlink(tempPath).catch(() => {
              });
            }
          }
        }
      } catch {
      }
    };
    const tick = () => {
      if (released)
        return;
      if (inFlightRenew)
        return;
      inFlightRenew = renew().finally(() => {
        inFlightRenew = null;
      });
    };
    renewTimer = setInterval(tick, interval);
    if (renewTimer && typeof renewTimer.unref === "function") {
      ;
      renewTimer.unref();
    }
  };
  const release = async () => {
    if (released)
      return;
    released = true;
    if (renewTimer !== null) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
    const pendingRenew = inFlightRenew;
    inFlightRenew = null;
    if (pendingRenew) {
      try {
        await pendingRenew;
      } catch {
      }
    }
    try {
      const observed = await readLockPayload(lockPath);
      if (!observed || observed.ownerId !== ownerId) {
        await rmEvictingDir(evictingPath).catch(() => {
        });
        return;
      }
      try {
        await unlink(lockPath);
      } catch (err) {
        if (err.code !== "ENOENT")
          throw err;
      }
      await rmEvictingDir(evictingPath).catch(() => {
      });
    } finally {
      markLost();
      renewTimer = null;
      inFlightRenew = null;
      lostResolve = null;
      lostPromise = null;
    }
  };
  const assertOwned = async () => {
    const observed = await readLockPayload(lockPath);
    if (!observed || observed.ownerId !== ownerId) {
      throw new FileLockOwnershipError(`file lock ${lockPath} is not owned by ${ownerId}`, {
        path: lockPath,
        expectedOwner: ownerId,
        observedOwner: observed?.ownerId,
        observedExpiresAt: observed?.expiresAt
      });
    }
    if (observed.expiresAt <= now()) {
      throw new FileLockOwnershipError(`file lock ${lockPath} has expired`, {
        path: lockPath,
        expectedOwner: ownerId,
        observedOwner: observed.ownerId,
        observedExpiresAt: observed.expiresAt
      });
    }
  };
  setupRenew();
  return {
    ownerId,
    assertOwned,
    release,
    whenLost: () => lostPromise ?? Promise.resolve(),
    hasLost: () => lost
  };
}

// ../core/dist/logger.js
var ENV_CONSOLE_LOG = "ANTIGRAVITY_CORE_CONSOLE_LOG";
var _sink = null;
function setLogSink(sink) {
  _sink = sink;
}
function isTruthyFlag(flag) {
  return flag === "1" || flag?.toLowerCase() === "true";
}
function isConsoleLogEnabled() {
  return isTruthyFlag(process.env[ENV_CONSOLE_LOG]);
}
function writeConsoleLog(level, ...args) {
  switch (level) {
    case "debug":
      console.debug(...args);
      break;
    case "info":
      console.info(...args);
      break;
    case "warn":
      console.warn(...args);
      break;
    case "error":
      console.error(...args);
      break;
  }
}
function createLogger(module) {
  const service = `antigravity.${module}`;
  const log18 = (level, message, extra) => {
    if (_sink) {
      try {
        _sink({ service, level, message, extra });
      } catch {
      }
    }
    if (isConsoleLogEnabled()) {
      const prefix = `[${service}]`;
      const args = extra ? [prefix, message, extra] : [prefix, message];
      writeConsoleLog(level, ...args);
    }
  };
  return {
    debug: (message, extra) => log18("debug", message, extra),
    info: (message, extra) => log18("info", message, extra),
    warn: (message, extra) => log18("warn", message, extra),
    error: (message, extra) => log18("error", message, extra)
  };
}

// ../core/dist/account-storage.js
var log = createLogger("account-storage");
var AccountStorageLockContentionError = class extends Error {
  details;
  constructor(message, details) {
    super(message);
    this.name = "AccountStorageLockContentionError";
    this.details = details;
  }
};
var AccountStorageUnreadableError = class extends Error {
  details;
  constructor(message, details) {
    super(message);
    this.name = "AccountStorageUnreadableError";
    this.details = details;
  }
};
var RETRY_DELAYS_MS = [100, 200, 400, 800, 1e3];
var DEFAULT_SLEEP = (ms) => new Promise((resolve3) => setTimeout(resolve3, ms));
var DEFAULT_BUILD_BACKUP_PATH = (path5, now) => `${path5}.corrupt-${now.toISOString().replace(/[:.]/g, "-")}`;
async function ensureSecurePermissions(path5) {
  try {
    await chmod(path5, 384);
  } catch {
  }
}
async function backupCorruptFile(sourcePath, buildBackupPath, now) {
  const backupPath = buildBackupPath(sourcePath, now);
  if (!backupPath)
    return null;
  try {
    await copyFile(sourcePath, backupPath);
    await ensureSecurePermissions(backupPath);
    return backupPath;
  } catch (backupError) {
    log.warn("Failed to back up corrupt account storage file", {
      sourcePath,
      backupPath,
      error: String(backupError)
    });
    return null;
  }
}
function deduplicateAccountsByEmail(accounts) {
  const emailToNewestIndex = /* @__PURE__ */ new Map();
  const indicesToKeep = /* @__PURE__ */ new Set();
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    if (!acc)
      continue;
    if (!acc.email) {
      indicesToKeep.add(i);
      continue;
    }
    const existingIndex = emailToNewestIndex.get(acc.email);
    if (existingIndex === void 0) {
      emailToNewestIndex.set(acc.email, i);
      continue;
    }
    const existing = accounts[existingIndex];
    if (!existing) {
      emailToNewestIndex.set(acc.email, i);
      continue;
    }
    const currLastUsed = acc.lastUsed || 0;
    const existLastUsed = existing.lastUsed || 0;
    const currAddedAt = acc.addedAt || 0;
    const existAddedAt = existing.addedAt || 0;
    const isNewer = currLastUsed > existLastUsed || currLastUsed === existLastUsed && currAddedAt > existAddedAt;
    if (isNewer) {
      emailToNewestIndex.set(acc.email, i);
    }
  }
  for (const idx of emailToNewestIndex.values()) {
    indicesToKeep.add(idx);
  }
  const result = [];
  for (let i = 0; i < accounts.length; i++) {
    if (indicesToKeep.has(i)) {
      const acc = accounts[i];
      if (acc) {
        result.push(acc);
      }
    }
  }
  return result;
}
function migrateV1ToV2(v1) {
  return {
    version: 2,
    accounts: v1.accounts.map((acc) => {
      const rateLimitResetTimes = {};
      if (acc.isRateLimited && acc.rateLimitResetTime && acc.rateLimitResetTime > Date.now()) {
        rateLimitResetTimes.claude = acc.rateLimitResetTime;
        rateLimitResetTimes.gemini = acc.rateLimitResetTime;
      }
      return {
        email: acc.email,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        managedProjectId: acc.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes: Object.keys(rateLimitResetTimes).length > 0 ? rateLimitResetTimes : void 0
      };
    }),
    activeIndex: v1.activeIndex
  };
}
function migrateV2ToV3(v2) {
  return {
    version: 3,
    accounts: v2.accounts.map((acc) => {
      const rateLimitResetTimes = {};
      if (acc.rateLimitResetTimes?.claude && acc.rateLimitResetTimes.claude > Date.now()) {
        rateLimitResetTimes.claude = acc.rateLimitResetTimes.claude;
      }
      if (acc.rateLimitResetTimes?.gemini && acc.rateLimitResetTimes.gemini > Date.now()) {
        rateLimitResetTimes["gemini-antigravity"] = acc.rateLimitResetTimes.gemini;
      }
      return {
        email: acc.email,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        managedProjectId: acc.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes: Object.keys(rateLimitResetTimes).length > 0 ? rateLimitResetTimes : void 0
      };
    }),
    activeIndex: v2.activeIndex
  };
}
function migrateV3ToV4(v3) {
  return {
    version: 4,
    accounts: v3.accounts.map((acc) => ({
      ...acc,
      fingerprint: void 0,
      fingerprintHistory: void 0
    })),
    activeIndex: v3.activeIndex,
    activeIndexByFamily: v3.activeIndexByFamily
  };
}
function mergeAccountStorage(existing, incoming) {
  const accountMap = /* @__PURE__ */ new Map();
  for (const acc of existing.accounts) {
    if (acc.refreshToken) {
      accountMap.set(acc.refreshToken, acc);
    }
  }
  for (const acc of incoming.accounts) {
    if (!acc.refreshToken)
      continue;
    const existingAcc = accountMap.get(acc.refreshToken);
    if (existingAcc) {
      const eligibilitySource = (acc.eligibilityStateUpdatedAt ?? 0) >= (existingAcc.eligibilityStateUpdatedAt ?? 0) ? acc : existingAcc;
      const merged = {
        ...existingAcc,
        ...acc,
        projectId: acc.projectId ?? existingAcc.projectId,
        managedProjectId: acc.managedProjectId ?? existingAcc.managedProjectId,
        rateLimitResetTimes: {
          ...existingAcc.rateLimitResetTimes,
          ...acc.rateLimitResetTimes
        },
        lastUsed: Math.max(existingAcc.lastUsed || 0, acc.lastUsed || 0),
        accountIneligible: eligibilitySource.accountIneligible,
        accountIneligibleAt: eligibilitySource.accountIneligibleAt,
        accountIneligibleReason: eligibilitySource.accountIneligibleReason,
        eligibilityStateUpdatedAt: eligibilitySource.eligibilityStateUpdatedAt
      };
      if (merged.accountIneligible) {
        merged.enabled = false;
      }
      accountMap.set(acc.refreshToken, merged);
    } else {
      accountMap.set(acc.refreshToken, acc);
    }
  }
  return {
    version: 4,
    accounts: Array.from(accountMap.values()),
    activeIndex: incoming.activeIndex,
    activeIndexByFamily: incoming.activeIndexByFamily
  };
}
async function readAndNormalizeV4(path5) {
  let raw;
  try {
    raw = await readFile2(path5, "utf-8");
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT") {
      return { state: "missing" };
    }
    return {
      state: "unreadable",
      reason: "io-error",
      detail: `${code ?? "UNKNOWN"}: ${error.message ?? String(error)}`
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseError) {
    return {
      state: "unreadable",
      reason: "malformed-json",
      detail: parseError.message ?? String(parseError)
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      state: "unreadable",
      reason: "invalid-shape",
      detail: "top-level value is not an object"
    };
  }
  const candidate = parsed;
  if (!Array.isArray(candidate.accounts)) {
    return {
      state: "unreadable",
      reason: "invalid-shape",
      detail: "`accounts` is missing or not an array"
    };
  }
  const parsedVersion = candidate.version;
  if (parsedVersion !== 1 && parsedVersion !== 2 && parsedVersion !== 3 && parsedVersion !== 4) {
    return {
      state: "unreadable",
      reason: "unsupported-version",
      detail: `unsupported version: ${String(parsedVersion)}`
    };
  }
  let storage = null;
  switch (parsedVersion) {
    case 1:
      storage = migrateV3ToV4(migrateV2ToV3(migrateV1ToV2(parsed)));
      break;
    case 2:
      storage = migrateV3ToV4(migrateV2ToV3(parsed));
      break;
    case 3:
      storage = migrateV3ToV4(parsed);
      break;
    case 4:
      storage = parsed;
      break;
  }
  if (!storage) {
    return {
      state: "unreadable",
      reason: "unsupported-version",
      detail: `unhandled version after switch: ${String(parsedVersion)}`
    };
  }
  for (let i = 0; i < storage.accounts.length; i++) {
    const detail = validateV4AccountRecord(storage.accounts[i], i);
    if (detail !== null) {
      return {
        state: "unreadable",
        reason: "invalid-shape",
        detail
      };
    }
  }
  const deduplicatedAccounts = deduplicateAccountsByEmail(storage.accounts);
  let activeIndex = typeof storage.activeIndex === "number" && Number.isFinite(storage.activeIndex) ? storage.activeIndex : 0;
  if (deduplicatedAccounts.length > 0) {
    activeIndex = Math.min(activeIndex, deduplicatedAccounts.length - 1);
    activeIndex = Math.max(activeIndex, 0);
  } else {
    activeIndex = 0;
  }
  return {
    state: "ok",
    storage: {
      version: 4,
      accounts: deduplicatedAccounts,
      activeIndex,
      activeIndexByFamily: storage.activeIndexByFamily
    }
  };
}
function validateV4AccountRecord(record, index) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return `accounts[${index}] is not an object`;
  }
  const acc = record;
  if (typeof acc.refreshToken !== "string" || acc.refreshToken.length === 0) {
    return `accounts[${index}].refreshToken is missing or not a non-empty string`;
  }
  if (typeof acc.addedAt !== "number" || !Number.isFinite(acc.addedAt)) {
    return `accounts[${index}].addedAt is missing or not a finite number`;
  }
  if (typeof acc.lastUsed !== "number" || !Number.isFinite(acc.lastUsed)) {
    return `accounts[${index}].lastUsed is missing or not a finite number`;
  }
  return null;
}
async function loadAccountStorage(path5) {
  const buildBackupPath = DEFAULT_BUILD_BACKUP_PATH;
  const now = () => /* @__PURE__ */ new Date();
  await ensureSecurePermissions(path5);
  const outcome = await readAndNormalizeV4(path5);
  if (outcome.state === "missing") {
    return null;
  }
  if (outcome.state === "unreadable") {
    const backupPath = await backupCorruptFile(path5, buildBackupPath, now());
    throw new AccountStorageUnreadableError(`Account storage at ${path5} is unreadable (${outcome.reason}: ${outcome.detail}).` + (backupPath ? ` A backup was written to ${backupPath}. The plugin will refuse to write until the file is removed or repaired.` : " A backup could not be written; the file has been left in place. The plugin will refuse to write until the file is removed or repaired."), {
      path: path5,
      reason: outcome.reason,
      detail: outcome.detail,
      backupPath
    });
  }
  if (outcome.storage.version === 4) {
    const onDiskVersion = await readVersionOnly(path5);
    if (onDiskVersion !== null && onDiskVersion !== 4) {
      try {
        await saveAccountStorage(path5, outcome.storage);
        log.info("Migration to v4 complete");
      } catch (saveError) {
        log.warn("Failed to persist migrated storage", {
          error: String(saveError)
        });
      }
    }
  }
  return outcome.storage;
}
async function readVersionOnly(path5) {
  try {
    const raw = await readFile2(path5, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "number" ? parsed.version : null;
  } catch {
    return null;
  }
}
async function acquireWithRetry(path5, sleep4) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const lock = await acquireFencedFileLock({
      path: path5,
      name: "accounts",
      ttlMs: 1e4,
      renew: true
    });
    if (lock) {
      return lock;
    }
    if (attempt < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay !== void 0) {
        await sleep4(delay);
      }
    }
  }
  throw new AccountStorageLockContentionError(`account storage lock contention at ${path5} after ${RETRY_DELAYS_MS.length + 1} attempts`, {
    path: path5,
    attempts: RETRY_DELAYS_MS.length + 1
  });
}
async function mutateAccountStorage(path5, mutate, options = {}) {
  const sleep4 = options.sleep ?? DEFAULT_SLEEP;
  const buildBackupPath = options.buildBackupPath ?? DEFAULT_BUILD_BACKUP_PATH;
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  const lock = await acquireWithRetry(path5, sleep4);
  try {
    const outcome = await readAndNormalizeV4(path5);
    if (outcome.state === "unreadable") {
      const backupPath = await backupCorruptFile(path5, buildBackupPath, now());
      throw new AccountStorageUnreadableError(`Refusing to write: account storage at ${path5} is unreadable (${outcome.reason}: ${outcome.detail}).` + (backupPath ? ` A backup of the existing file was written to ${backupPath} and the on-disk file has been left untouched. Repair or remove the existing file before retrying.` : " A backup could not be written; the on-disk file has been left untouched. Repair or remove the existing file before retrying."), {
        path: path5,
        reason: outcome.reason,
        detail: outcome.detail,
        backupPath
      });
    }
    const existing = outcome.state === "ok" ? outcome.storage : { version: 4, accounts: [], activeIndex: 0 };
    const next = await mutate(existing);
    const finalStorage = next ?? existing;
    await lock.assertOwned();
    await writeJsonAtomic(path5, finalStorage);
    return finalStorage;
  } finally {
    try {
      await lock.release();
    } catch (releaseError) {
      log.warn("Failed to release account storage lock", {
        error: String(releaseError)
      });
    }
  }
}
async function saveAccountStorage(path5, incoming) {
  return mutateAccountStorage(path5, (current) => mergeAccountStorage(current, incoming));
}
async function saveAccountStorageReplace(path5, incoming) {
  return mutateAccountStorage(path5, () => incoming);
}
async function clearAccountStorage(path5) {
  const sleep4 = (ms) => new Promise((resolve3) => setTimeout(resolve3, ms));
  const lock = await acquireWithRetry(path5, sleep4);
  try {
    await unlink2(path5);
  } catch (error) {
    const code = error.code;
    if (code !== "ENOENT") {
      log.error("Failed to clear account storage", { error: String(error) });
      throw error;
    }
  } finally {
    try {
      await lock.release();
    } catch (releaseError) {
      log.warn("Failed to release account storage lock", {
        error: String(releaseError)
      });
    }
  }
}

// ../core/dist/auth.js
var ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1e3;
function isOAuthAuth(auth) {
  return typeof auth === "object" && auth !== null && "type" in auth && auth.type === "oauth";
}
function parseRefreshParts(refresh) {
  const [refreshToken = "", projectId = "", managedProjectId = ""] = (refresh ?? "").split("|");
  return {
    refreshToken,
    projectId: projectId || void 0,
    managedProjectId: managedProjectId || void 0
  };
}
function formatRefreshParts(parts) {
  const projectSegment = parts.projectId ?? "";
  const base = `${parts.refreshToken}|${projectSegment}`;
  return parts.managedProjectId ? `${base}|${parts.managedProjectId}` : base;
}
function accessTokenExpired(auth) {
  if (!auth.access || typeof auth.expires !== "number") {
    return true;
  }
  return auth.expires <= Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
}
function calculateTokenExpiry(requestTimeMs, expiresInSeconds) {
  const seconds = typeof expiresInSeconds === "number" ? expiresInSeconds : 3600;
  if (Number.isNaN(seconds) || seconds <= 0) {
    return requestTimeMs;
  }
  return requestTimeMs + seconds * 1e3;
}

// ../core/dist/fingerprint.js
import * as crypto from "node:crypto";
var AGY_CLI_VERSION = "1.1.24";
var AGY_CLI_CHANGE_LIST = "974782877";
var ANTIGRAVITY_API_CLIENT = "antigravity-cli";
var MAX_FINGERPRINT_HISTORY = 5;
function normalizeHarnessPlatform(platform = process.platform) {
  return platform === "win32" ? "windows" : platform || "unknown";
}
function normalizeHarnessArch(arch = process.arch) {
  switch (arch) {
    case "x64":
      return "amd64";
    case "ia32":
      return "386";
    default:
      return arch || "unknown";
  }
}
function buildAntigravityHarnessUserAgent(version = AGY_CLI_VERSION, platform = process.platform, arch = process.arch, authMethod = "consumer") {
  const osType = normalizeHarnessPlatform(platform);
  const normalizedArch = normalizeHarnessArch(arch);
  const changeList = version === AGY_CLI_VERSION ? `; cl=${AGY_CLI_CHANGE_LIST}` : "";
  return `antigravity/cli/${version} (aidev_client; os_type=${osType}; arch=${normalizedArch}${changeList}; auth_method=${authMethod})`;
}
function buildAntigravityHarnessLoadCodeAssistUserAgent(version = AGY_CLI_VERSION) {
  return buildAntigravityHarnessUserAgent(version);
}
function platformToMetadataPlatform(platform = process.platform) {
  return platform === "win32" ? "WINDOWS" : "MACOS";
}
function buildAntigravityLoadCodeAssistMetadata() {
  return { ideType: "ANTIGRAVITY" };
}
function buildAntigravityHarnessBootstrapHeaders(accessToken) {
  return {
    "User-Agent": buildAntigravityHarnessLoadCodeAssistUserAgent(),
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip"
  };
}
function generateDeviceId() {
  return crypto.randomUUID();
}
function generateSessionToken() {
  return crypto.randomBytes(16).toString("hex");
}
function generateFingerprint() {
  return {
    deviceId: generateDeviceId(),
    sessionToken: generateSessionToken(),
    userAgent: buildAntigravityHarnessUserAgent(),
    apiClient: ANTIGRAVITY_API_CLIENT,
    clientMetadata: {
      ideType: "ANTIGRAVITY",
      platform: platformToMetadataPlatform(),
      pluginType: "GEMINI"
    },
    createdAt: Date.now()
  };
}
function updateFingerprintVersion(fingerprint) {
  const userAgent = buildAntigravityHarnessUserAgent();
  if (fingerprint.userAgent === userAgent) {
    return false;
  }
  fingerprint.userAgent = userAgent;
  return true;
}
function buildFingerprintHeaders(fingerprint) {
  if (!fingerprint) {
    return {};
  }
  return {
    "User-Agent": fingerprint.userAgent
  };
}
var sessionFingerprint = null;
function getSessionFingerprint() {
  if (!sessionFingerprint) {
    sessionFingerprint = generateFingerprint();
  }
  return sessionFingerprint;
}

// ../core/dist/model-registry.js
var DEFAULT_MODALITIES = {
  input: ["text", "image", "pdf"],
  output: ["text"]
};
var MODEL_RELEASE_DATE = "";
var DEFAULT_COST = { input: 0, output: 0 };
var DEFAULT_OPTIONS = {};
function defineModel(id, model) {
  return {
    id,
    release_date: MODEL_RELEASE_DATE,
    attachment: model.modalities.input.some((modality) => modality !== "text"),
    temperature: true,
    tool_call: true,
    cost: { ...DEFAULT_COST },
    options: { ...DEFAULT_OPTIONS },
    ...model
  };
}
var ALL_MODEL_DEFINITIONS = {
  "antigravity-gemini-3.1-pro": defineModel("antigravity-gemini-3.1-pro", {
    name: "Gemini 3.1 Pro (Antigravity)",
    reasoning: true,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" }
    }
  }),
  "antigravity-gemini-3.8-flash": defineModel("antigravity-gemini-3.8-flash", {
    name: "Gemini 3.8 Flash (Antigravity)",
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" }
    }
  }),
  "antigravity-gemini-3.7-flash": defineModel("antigravity-gemini-3.7-flash", {
    name: "Gemini 3.7 Flash (Antigravity)",
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" }
    }
  }),
  "antigravity-gemini-3.6-flash": defineModel("antigravity-gemini-3.6-flash", {
    name: "Gemini 3.6 Flash (Antigravity)",
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" }
    }
  }),
  "antigravity-gemini-3.5-flash": defineModel("antigravity-gemini-3.5-flash", {
    name: "Gemini 3.5 Flash (Antigravity)",
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" }
    }
  }),
  "antigravity-claude-sonnet-4-6-thinking": defineModel("antigravity-claude-sonnet-4-6-thinking", {
    name: "Claude Sonnet 4.6 Thinking (Antigravity)",
    reasoning: true,
    limit: { context: 25e4, output: 64e3 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { disabled: true },
      high: { disabled: true }
    }
  }),
  "antigravity-claude-opus-4-6-thinking": defineModel("antigravity-claude-opus-4-6-thinking", {
    name: "Claude Opus 4.6 Thinking (Antigravity)",
    reasoning: true,
    limit: { context: 25e4, output: 64e3 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { disabled: true },
      high: { disabled: true }
    }
  }),
  "antigravity-gemini-3.1-flash-image": defineModel("antigravity-gemini-3.1-flash-image", {
    name: "Gemini 3.1 Flash Image (Antigravity)",
    reasoning: false,
    limit: { context: 66e3, output: 33e3 },
    modalities: {
      input: ["text", "image"],
      output: ["text", "image"]
    }
  }),
  "antigravity-gpt-oss-120b-medium": defineModel("antigravity-gpt-oss-120b-medium", {
    name: "GPT-OSS 120B Medium (Antigravity)",
    reasoning: true,
    limit: { context: 131072, output: 32768 },
    modalities: DEFAULT_MODALITIES
  }),
  "gemini-2.5-flash": defineModel("gemini-2.5-flash", {
    name: "Gemini 2.5 Flash (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES
  }),
  "gemini-2.5-pro": defineModel("gemini-2.5-pro", {
    name: "Gemini 2.5 Pro (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES
  }),
  "gemini-3-flash-preview": defineModel("gemini-3-flash-preview", {
    name: "Gemini 3 Flash Preview (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES
  }),
  "gemini-3.1-pro-preview": defineModel("gemini-3.1-pro-preview", {
    name: "Gemini 3.1 Pro Preview (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES
  }),
  "gemini-3.5-flash-preview": defineModel("gemini-3.5-flash-preview", {
    name: "Gemini 3.5 Flash Preview (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES
  }),
  "gemini-3.1-flash-image": defineModel("gemini-3.1-flash-image", {
    name: "Gemini 3.1 Flash Image (Gemini CLI)",
    reasoning: false,
    limit: { context: 66e3, output: 33e3 },
    modalities: {
      input: ["text", "image"],
      output: ["text", "image"]
    }
  }),
  "gemini-3.1-flash-image-preview": defineModel("gemini-3.1-flash-image-preview", {
    name: "Gemini 3.1 Flash Image Preview (Gemini CLI)",
    reasoning: false,
    limit: { context: 66e3, output: 33e3 },
    modalities: {
      input: ["text", "image"],
      output: ["text", "image"]
    }
  }),
  "gemini-3.1-pro-preview-customtools": defineModel("gemini-3.1-pro-preview-customtools", {
    name: "Gemini 3.1 Pro Preview Custom Tools (Gemini CLI)",
    reasoning: true,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES
  })
};
var RESOLVER_ALIASES = {
  "gemini-3.1-pro-low": "gemini-3.1-pro",
  "gemini-3.1-pro-high": "gemini-3.1-pro",
  "gemini-3-flash-low": "gemini-3-flash",
  "gemini-3-flash-medium": "gemini-3-flash",
  "gemini-3-flash-high": "gemini-3-flash",
  "gemini-3.5-flash-low": "gemini-3.5-flash",
  "gemini-3.5-flash-medium": "gemini-3.5-flash",
  "gemini-3.5-flash-high": "gemini-3.5-flash",
  "gemini-3.6-flash-low": "gemini-3.6-flash",
  "gemini-3.6-flash-medium": "gemini-3.6-flash",
  "gemini-3.6-flash-high": "gemini-3.6-flash",
  "gemini-3.7-flash-low": "gemini-3.7-flash",
  "gemini-3.7-flash-medium": "gemini-3.7-flash",
  "gemini-3.7-flash-high": "gemini-3.7-flash",
  "gemini-3.8-flash-low": "gemini-3.8-flash",
  "gemini-3.8-flash-medium": "gemini-3.8-flash",
  "gemini-3.8-flash-high": "gemini-3.8-flash",
  "gemini-claude-opus-4-6-thinking-low": "claude-opus-4-6-thinking",
  "gemini-claude-opus-4-6-thinking-medium": "claude-opus-4-6-thinking",
  "gemini-claude-opus-4-6-thinking-high": "claude-opus-4-6-thinking",
  "gemini-claude-sonnet-4-6-thinking-low": "claude-sonnet-4-6",
  "gemini-claude-sonnet-4-6-thinking-medium": "claude-sonnet-4-6",
  "gemini-claude-sonnet-4-6-thinking-high": "claude-sonnet-4-6",
  "gemini-claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-sonnet-4-6-thinking": "claude-sonnet-4-6",
  "claude-sonnet-4-6-thinking-low": "claude-sonnet-4-6",
  "claude-sonnet-4-6-thinking-medium": "claude-sonnet-4-6",
  "claude-sonnet-4-6-thinking-high": "claude-sonnet-4-6",
  "gpt-oss-120b": "gpt-oss-120b-medium"
};
var GEMINI_35_FLASH_ROUTES = {
  antigravity: {
    defaultModel: "gemini-3-flash-agent",
    byTier: {
      low: "gemini-3.5-flash-extra-low",
      medium: "gemini-3.5-flash-low",
      high: "gemini-3-flash-agent"
    }
  },
  geminiCliFallbackModel: "gemini-3-flash-preview"
};
var GEMINI_36_FLASH_ROUTES = {
  defaultModel: "gemini-3.6-flash-medium",
  byTier: {
    low: "gemini-3.6-flash-low",
    medium: "gemini-3.6-flash-medium",
    high: "gemini-3.6-flash-high"
  }
};
var GEMINI_37_FLASH_ROUTES = {
  defaultModel: "gemini-3.7-flash-medium",
  byTier: {
    low: "gemini-3.7-flash-low",
    medium: "gemini-3.7-flash-medium",
    high: "gemini-3.7-flash-high"
  }
};
var GEMINI_38_FLASH_ROUTES = {
  defaultModel: "gemini-3.8-flash-medium",
  byTier: {
    low: "gemini-3.8-flash-low",
    medium: "gemini-3.8-flash-medium",
    high: "gemini-3.8-flash-high"
  }
};
var QUOTA_GROUP_BY_MODEL_ID = {
  "claude-opus-4-6-thinking": "non-gemini",
  "claude-opus-4-6": "non-gemini",
  "claude-sonnet-4-6-thinking": "non-gemini",
  "claude-sonnet-4-6": "non-gemini",
  "gemini-pro-agent": "gemini",
  "gemini-3.1-pro": "gemini",
  "gemini-3.1-pro-low": "gemini",
  "gemini-3.1-pro-high": "gemini",
  "gemini-3-flash": "gemini",
  "gemini-3-flash-agent": "gemini",
  "gemini-3.5-flash-low": "gemini",
  "gemini-3.5-flash-extra-low": "gemini",
  "gemini-3.6-flash-low": "gemini",
  "gemini-3.6-flash-medium": "gemini",
  "gemini-3.6-flash-high": "gemini",
  "gemini-3.6-flash-tiered": "gemini",
  "gemini-3.7-flash-low": "gemini",
  "gemini-3.7-flash-medium": "gemini",
  "gemini-3.7-flash-high": "gemini",
  "gemini-3.7-flash-tiered": "gemini",
  "gemini-3.8-flash-low": "gemini",
  "gemini-3.8-flash-medium": "gemini",
  "gemini-3.8-flash-high": "gemini",
  "gemini-3.8-flash-tiered": "gemini",
  "gemini-3.1-flash-image": "gemini",
  "gpt-oss-120b": "non-gemini",
  "gpt-oss-120b-medium": "non-gemini"
};
var ANTIGRAVITY_OPENCODE_MODEL_IDS = [
  "antigravity-gemini-3.8-flash",
  "antigravity-gemini-3.7-flash",
  "antigravity-gemini-3.6-flash",
  "antigravity-gemini-3.5-flash",
  "antigravity-gemini-3.1-pro",
  "antigravity-claude-sonnet-4-6-thinking",
  "antigravity-claude-opus-4-6-thinking",
  "antigravity-gemini-3.1-flash-image",
  "antigravity-gpt-oss-120b-medium"
];
function pickModelDefinitions(ids) {
  return Object.fromEntries(ids.map((id) => [id, ALL_MODEL_DEFINITIONS[id]]));
}
var OPENCODE_MODEL_DEFINITIONS = pickModelDefinitions(ANTIGRAVITY_OPENCODE_MODEL_IDS);
function getAntigravityOpencodeModelIds() {
  return [...ANTIGRAVITY_OPENCODE_MODEL_IDS];
}
function getResolverAliasMap() {
  return RESOLVER_ALIASES;
}
function getGemini35FlashAntigravityModel(tier) {
  if (!tier) {
    return GEMINI_35_FLASH_ROUTES.antigravity.defaultModel;
  }
  return GEMINI_35_FLASH_ROUTES.antigravity.byTier[tier] ?? GEMINI_35_FLASH_ROUTES.antigravity.defaultModel;
}
function getGemini35FlashGeminiCliFallbackModel() {
  return GEMINI_35_FLASH_ROUTES.geminiCliFallbackModel;
}
function getTieredAntigravityModel(routes, tier) {
  return tier ? routes.byTier[tier] ?? routes.defaultModel : routes.defaultModel;
}
function getGemini36FlashAntigravityModel(tier) {
  return getTieredAntigravityModel(GEMINI_36_FLASH_ROUTES, tier);
}
function getGemini37FlashAntigravityModel(tier) {
  return getTieredAntigravityModel(GEMINI_37_FLASH_ROUTES, tier);
}
function getGemini38FlashAntigravityModel(tier) {
  return getTieredAntigravityModel(GEMINI_38_FLASH_ROUTES, tier);
}
function getQuotaGroupForModel(modelId) {
  const normalized = modelId.toLowerCase();
  return QUOTA_GROUP_BY_MODEL_ID[normalized] ?? // Check Claude / GPT-OSS substrings BEFORE the `gemini` substring so
  // a `gemini-claude-*` alias (which is a Claude route exposed under
  // a `gemini-` namespace) attributes to the non-gemini pool rather
  // than the gemini pool. Substring matching is required because the
  // alias IDs start with `gemini-` but contain `claude`.
  (normalized.includes("claude") || normalized.includes("gpt-oss") ? "non-gemini" : normalized.startsWith("gemini") || normalized.startsWith("tab_") ? "gemini" : void 0);
}

// ../core/dist/quota-types.js
function normalizeLegacyCachedQuota(raw) {
  if (!raw)
    return raw;
  const hasLegacy = "gemini-pro" in raw || "gemini-flash" in raw || "claude" in raw || "gpt-oss" in raw;
  if (!hasLegacy)
    return raw;
  const earlierResetTime = (a, b) => {
    if (!a)
      return b;
    if (!b)
      return a;
    return a < b ? a : b;
  };
  const minFraction = (a, b) => {
    if (!a)
      return b;
    if (!b)
      return a;
    const fa = a.remainingFraction ?? 1;
    const fb = b.remainingFraction ?? 1;
    const winner = fa <= fb ? a : b;
    const loser = fa <= fb ? b : a;
    return {
      ...winner,
      resetTime: earlierResetTime(winner.resetTime, loser.resetTime)
    };
  };
  const gemini = minFraction(raw.gemini, minFraction(raw["gemini-pro"], raw["gemini-flash"]));
  const nonGemini = minFraction(raw["non-gemini"], minFraction(raw.claude, raw["gpt-oss"]));
  return {
    ...gemini !== void 0 ? { gemini } : {},
    ...nonGemini !== void 0 ? { "non-gemini": nonGemini } : {}
  };
}

// ../core/dist/rotation.js
var QUOTA_EXHAUSTED_BACKOFFS = [
  6e4,
  3e5,
  18e5,
  72e5
];
var RATE_LIMIT_EXCEEDED_BACKOFF = 3e4;
var MODEL_CAPACITY_EXHAUSTED_BASE_BACKOFF = 45e3;
var MODEL_CAPACITY_EXHAUSTED_JITTER_MAX = 3e4;
var SERVER_ERROR_BACKOFF = 2e4;
var UNKNOWN_BACKOFF = 6e4;
var MIN_BACKOFF_MS = 2e3;
function parseRateLimitReason(reason, message, status) {
  if (status === 529 || status === 503)
    return "MODEL_CAPACITY_EXHAUSTED";
  if (status === 500)
    return "SERVER_ERROR";
  if (reason) {
    const normalized = reason.toUpperCase();
    if (normalized === "QUOTA_EXHAUSTED" || normalized === "RATE_LIMIT_EXCEEDED" || normalized === "MODEL_CAPACITY_EXHAUSTED") {
      return normalized;
    }
  }
  if (message) {
    const normalized = message.toLowerCase();
    if (normalized.includes("capacity") || normalized.includes("overloaded") || normalized.includes("resource exhausted")) {
      return "MODEL_CAPACITY_EXHAUSTED";
    }
    if (normalized.includes("per minute") || normalized.includes("rate limit") || normalized.includes("too many requests") || normalized.includes("presque")) {
      return "RATE_LIMIT_EXCEEDED";
    }
    if (normalized.includes("exhausted") || normalized.includes("quota")) {
      return "QUOTA_EXHAUSTED";
    }
  }
  return "UNKNOWN";
}
function calculateBackoffMs(reason, consecutiveFailures, retryAfterMs, random = Math.random) {
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.max(retryAfterMs, MIN_BACKOFF_MS);
  }
  switch (reason) {
    case "QUOTA_EXHAUSTED":
      return QUOTA_EXHAUSTED_BACKOFFS[Math.min(consecutiveFailures, QUOTA_EXHAUSTED_BACKOFFS.length - 1)] ?? UNKNOWN_BACKOFF;
    case "RATE_LIMIT_EXCEEDED":
      return RATE_LIMIT_EXCEEDED_BACKOFF;
    case "MODEL_CAPACITY_EXHAUSTED":
      return MODEL_CAPACITY_EXHAUSTED_BASE_BACKOFF + random() * MODEL_CAPACITY_EXHAUSTED_JITTER_MAX - MODEL_CAPACITY_EXHAUSTED_JITTER_MAX / 2;
    case "SERVER_ERROR":
      return SERVER_ERROR_BACKOFF;
    default:
      return UNKNOWN_BACKOFF;
  }
}
function computeSoftQuotaCacheTtlMs(ttlConfig, refreshIntervalMinutes) {
  return (ttlConfig === "auto" ? Math.max(2 * refreshIntervalMinutes, 10) : ttlConfig) * 60 * 1e3;
}
var DEFAULT_HEALTH_SCORE_CONFIG = {
  initial: 70,
  successReward: 1,
  rateLimitPenalty: -10,
  failurePenalty: -20,
  recoveryRatePerHour: 2,
  minUsable: 50,
  maxScore: 100
};
var HealthScoreTracker = class {
  scores = /* @__PURE__ */ new Map();
  config;
  now;
  constructor(config = {}, now = Date.now) {
    this.now = now;
    this.config = { ...DEFAULT_HEALTH_SCORE_CONFIG, ...config };
  }
  /**
   * Get current health score for an account, applying time-based recovery.
   */
  getScore(accountIndex) {
    const state = this.scores.get(accountIndex);
    if (!state) {
      return this.config.initial;
    }
    const now = this.now();
    const hoursSinceUpdate = (now - state.lastUpdated) / (1e3 * 60 * 60);
    const recoveredPoints = Math.floor(hoursSinceUpdate * this.config.recoveryRatePerHour);
    return Math.min(this.config.maxScore, state.score + recoveredPoints);
  }
  /**
   * Record a successful request - improves health score.
   */
  recordSuccess(accountIndex) {
    const now = this.now();
    const current = this.getScore(accountIndex);
    this.scores.set(accountIndex, {
      score: Math.min(this.config.maxScore, current + this.config.successReward),
      lastUpdated: now,
      lastSuccess: now,
      consecutiveFailures: 0
    });
  }
  /**
   * Record a rate limit hit - moderate penalty.
   */
  recordRateLimit(accountIndex) {
    const now = this.now();
    const state = this.scores.get(accountIndex);
    const current = this.getScore(accountIndex);
    this.scores.set(accountIndex, {
      score: Math.max(0, current + this.config.rateLimitPenalty),
      lastUpdated: now,
      lastSuccess: state?.lastSuccess ?? 0,
      consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1
    });
  }
  /**
   * Record a failure (auth, network, etc.) - larger penalty.
   */
  recordFailure(accountIndex) {
    const now = this.now();
    const state = this.scores.get(accountIndex);
    const current = this.getScore(accountIndex);
    this.scores.set(accountIndex, {
      score: Math.max(0, current + this.config.failurePenalty),
      lastUpdated: now,
      lastSuccess: state?.lastSuccess ?? 0,
      consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1
    });
  }
  /**
   * Check if account is healthy enough to use.
   */
  isUsable(accountIndex) {
    return this.getScore(accountIndex) >= this.config.minUsable;
  }
  /**
   * Get consecutive failure count for an account.
   */
  getConsecutiveFailures(accountIndex) {
    return this.scores.get(accountIndex)?.consecutiveFailures ?? 0;
  }
  /**
   * Reset health state for an account (e.g., after removal).
   */
  reset(accountIndex) {
    this.scores.delete(accountIndex);
  }
  /**
   * Get all scores for debugging/logging.
   */
  getSnapshot() {
    const result = /* @__PURE__ */ new Map();
    for (const [index] of this.scores) {
      result.set(index, {
        score: this.getScore(index),
        consecutiveFailures: this.getConsecutiveFailures(index)
      });
    }
    return result;
  }
};
var STICKINESS_BONUS = 150;
var SWITCH_THRESHOLD = 100;
function selectHybridAccount(accounts, tokenTracker, currentAccountIndex = null, minHealthScore = 50, now = Date.now) {
  const candidates = accounts.filter((acc) => !acc.isRateLimited && !acc.isCoolingDown && acc.healthScore >= minHealthScore && tokenTracker.hasTokens(acc.index)).map((acc) => ({
    ...acc,
    tokens: tokenTracker.getTokens(acc.index)
  }));
  if (candidates.length === 0) {
    return null;
  }
  const maxTokens = tokenTracker.getMaxTokens();
  const scored = candidates.map((acc) => {
    const baseScore = calculateHybridScore(acc, maxTokens, now);
    const stickinessBonus = acc.index === currentAccountIndex ? STICKINESS_BONUS : 0;
    return {
      index: acc.index,
      baseScore,
      score: baseScore + stickinessBonus,
      isCurrent: acc.index === currentAccountIndex
    };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) {
    return null;
  }
  const currentCandidate = scored.find((s) => s.isCurrent);
  if (currentCandidate && !best.isCurrent) {
    const advantage = best.baseScore - currentCandidate.baseScore;
    if (advantage < SWITCH_THRESHOLD) {
      return currentCandidate.index;
    }
  }
  return best.index;
}
function calculateHybridScore(account, maxTokens, now) {
  const healthComponent = account.healthScore * 2;
  const tokenComponent = account.tokens / maxTokens * 100 * 5;
  const secondsSinceUsed = (now() - account.lastUsed) / 1e3;
  const freshnessComponent = Math.min(secondsSinceUsed, 3600) * 0.1;
  return Math.max(0, healthComponent + tokenComponent + freshnessComponent);
}
var DEFAULT_TOKEN_BUCKET_CONFIG = {
  maxTokens: 50,
  regenerationRatePerMinute: 6,
  initialTokens: 50
};
var TokenBucketTracker = class {
  buckets = /* @__PURE__ */ new Map();
  config;
  now;
  constructor(config = {}, now = Date.now) {
    this.now = now;
    this.config = { ...DEFAULT_TOKEN_BUCKET_CONFIG, ...config };
  }
  /**
   * Get current token balance for an account, applying regeneration.
   */
  getTokens(accountIndex) {
    const state = this.buckets.get(accountIndex);
    if (!state) {
      return this.config.initialTokens;
    }
    const now = this.now();
    const minutesSinceUpdate = (now - state.lastUpdated) / (1e3 * 60);
    const recoveredTokens = minutesSinceUpdate * this.config.regenerationRatePerMinute;
    return Math.min(this.config.maxTokens, state.tokens + recoveredTokens);
  }
  /**
   * Check if account has enough tokens for a request.
   * @param cost Cost of the request (default: 1)
   */
  hasTokens(accountIndex, cost = 1) {
    return this.getTokens(accountIndex) >= cost;
  }
  /**
   * Consume tokens for a request.
   * @returns true if tokens were consumed, false if insufficient
   */
  consume(accountIndex, cost = 1) {
    const current = this.getTokens(accountIndex);
    if (current < cost) {
      return false;
    }
    this.buckets.set(accountIndex, {
      tokens: current - cost,
      lastUpdated: this.now()
    });
    return true;
  }
  /**
   * Refund tokens (e.g., if request wasn't actually sent).
   */
  refund(accountIndex, amount = 1) {
    const current = this.getTokens(accountIndex);
    this.buckets.set(accountIndex, {
      tokens: Math.min(this.config.maxTokens, current + amount),
      lastUpdated: this.now()
    });
  }
  getMaxTokens() {
    return this.config.maxTokens;
  }
};
var globalTokenTracker = null;
function getTokenTracker() {
  if (!globalTokenTracker) {
    globalTokenTracker = new TokenBucketTracker();
  }
  return globalTokenTracker;
}
function initTokenTracker(config) {
  globalTokenTracker = new TokenBucketTracker(config);
  return globalTokenTracker;
}
var globalHealthTracker = null;
function getHealthTracker() {
  if (!globalHealthTracker) {
    globalHealthTracker = new HealthScoreTracker();
  }
  return globalHealthTracker;
}
function initHealthTracker(config) {
  globalHealthTracker = new HealthScoreTracker(config);
  return globalHealthTracker;
}

// ../core/dist/account-manager.js
function isStorageLockContention(error) {
  if (error instanceof AccountStorageLockContentionError)
    return true;
  const message = String(error);
  return message.includes("Lock file is already being held") || message.includes("ELOCKED");
}
function clampNonNegativeInt(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value < 0 ? 0 : Math.floor(value);
}
function quotaAccountIdentity(refreshToken) {
  return createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);
}
function getQuotaKey(family, headerStyle, model) {
  if (family === "claude") {
    return "claude";
  }
  const base = headerStyle === "gemini-cli" ? "gemini-cli" : "gemini-antigravity";
  if (model) {
    return `${base}:${model}`;
  }
  return base;
}
function isRateLimitedForQuotaKey(account, key, now) {
  const resetTime = account.rateLimitResetTimes[key];
  return resetTime !== void 0 && now() < resetTime;
}
function isRateLimitedForFamily(account, family, now, model) {
  if (family === "claude") {
    return isRateLimitedForQuotaKey(account, "claude", now);
  }
  const antigravityIsLimited = isRateLimitedForHeaderStyle(account, family, "antigravity", now, model);
  const cliIsLimited = isRateLimitedForHeaderStyle(account, family, "gemini-cli", now, model);
  return antigravityIsLimited && cliIsLimited;
}
function isRateLimitedForHeaderStyle(account, family, headerStyle, now, model) {
  clearExpiredRateLimits(account, now);
  if (family === "claude") {
    return isRateLimitedForQuotaKey(account, "claude", now);
  }
  if (model) {
    const modelKey = getQuotaKey(family, headerStyle, model);
    if (isRateLimitedForQuotaKey(account, modelKey, now)) {
      return true;
    }
  }
  const baseKey = getQuotaKey(family, headerStyle);
  return isRateLimitedForQuotaKey(account, baseKey, now);
}
function clearExpiredRateLimits(account, clock) {
  const now = clock();
  const keys = Object.keys(account.rateLimitResetTimes);
  for (const key of keys) {
    const resetTime = account.rateLimitResetTimes[key];
    if (resetTime !== void 0 && now >= resetTime) {
      delete account.rateLimitResetTimes[key];
    }
  }
}
function resolveQuotaGroup(family, model) {
  if (model) {
    const registryGroup = getQuotaGroupForModel(model);
    if (registryGroup)
      return registryGroup;
    const lower = model.toLowerCase();
    if (lower.includes("claude") || lower.includes("gpt-oss")) {
      return "non-gemini";
    }
    if (lower.includes("gemini"))
      return "gemini";
  }
  return family === "claude" ? "non-gemini" : "gemini";
}
function isOverSoftQuotaThreshold(account, family, thresholdPercent, cacheTtlMs, now, model) {
  if (thresholdPercent >= 100)
    return false;
  if (!account.cachedQuota)
    return false;
  if (account.cachedQuotaUpdatedAt == null)
    return false;
  const age = now() - account.cachedQuotaUpdatedAt;
  if (age > cacheTtlMs)
    return false;
  const quotaGroup = resolveQuotaGroup(family, model);
  const groupData = account.cachedQuota[quotaGroup];
  if (groupData?.remainingFraction == null)
    return false;
  const remainingFraction = Math.max(0, Math.min(1, groupData.remainingFraction));
  const usedPercent = (1 - remainingFraction) * 100;
  const isOverThreshold = usedPercent >= thresholdPercent;
  return isOverThreshold;
}
var ACCOUNT_SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1e3;
var MAX_ACCOUNT_SESSION_STATES = 256;
var AccountManager = class {
  accounts = [];
  cursorByFamily = { claude: 0, gemini: 0 };
  currentAccountIndexByFamily = {
    claude: -1,
    gemini: -1
  };
  sessionOffsetApplied = {
    claude: false,
    gemini: false
  };
  lastToastAccountIndex = -1;
  lastToastTime = 0;
  savePending = false;
  saveTimeout = null;
  saveInFlight = null;
  disposed = false;
  savePromiseResolvers = [];
  sessionStartTime;
  sessionRequestCounts = /* @__PURE__ */ new Map();
  sessionUsedAccounts = /* @__PURE__ */ new Set();
  requestSessionStates = /* @__PURE__ */ new Map();
  store;
  storagePath;
  onDiagnostic;
  now;
  random;
  pid;
  constructor(authFallback, stored, options) {
    this.store = options.store;
    this.storagePath = options.storagePath ?? "";
    this.onDiagnostic = options.onDiagnostic;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? (() => Math.random());
    this.pid = options.pid ?? process.pid;
    this.sessionStartTime = this.now();
    const authParts = authFallback ? parseRefreshParts(authFallback.refresh) : null;
    if (stored && stored.accounts.length === 0) {
      this.accounts = [];
      this.cursorByFamily = { claude: 0, gemini: 0 };
      return;
    }
    if (stored && stored.accounts.length > 0) {
      const baseNow = this.now();
      this.accounts = stored.accounts.map((acc, index) => {
        if (!acc.refreshToken || typeof acc.refreshToken !== "string") {
          return null;
        }
        const matchesFallback = !!(authFallback && authParts?.refreshToken && acc.refreshToken === authParts.refreshToken);
        return {
          index,
          email: acc.email,
          label: acc.label,
          addedAt: clampNonNegativeInt(acc.addedAt, baseNow),
          lastUsed: clampNonNegativeInt(acc.lastUsed, 0),
          parts: {
            refreshToken: acc.refreshToken,
            projectId: acc.projectId,
            managedProjectId: acc.managedProjectId
          },
          // Authoritative record-level fields that survive bare-refresh-token
          // rotations where `parts.*` may be overwritten with undefined.
          projectId: acc.projectId,
          managedProjectId: acc.managedProjectId,
          access: matchesFallback ? authFallback?.access : void 0,
          expires: matchesFallback ? authFallback?.expires : void 0,
          enabled: acc.enabled !== false,
          rateLimitResetTimes: acc.rateLimitResetTimes ?? {},
          lastSwitchReason: acc.lastSwitchReason,
          coolingDownUntil: acc.coolingDownUntil,
          cooldownReason: acc.cooldownReason,
          touchedForQuota: {},
          fingerprint: acc.fingerprint ?? generateFingerprint(),
          fingerprintHistory: acc.fingerprintHistory ?? [],
          cachedQuota: normalizeLegacyCachedQuota(acc.cachedQuota),
          // Restore the opaque identity stamp alongside the quota so the
          // post-load projection can detect a stale snapshot captured
          // for a different account after an index shift.
          cachedQuotaAccountId: acc.cachedQuotaAccountId,
          cachedQuotaUpdatedAt: acc.cachedQuotaUpdatedAt,
          capturedTierId: acc.capturedTierId,
          capturedPaidTierId: acc.capturedPaidTierId,
          capturedTierAt: acc.capturedTierAt,
          capturedTierSchemaVersion: acc.capturedTierSchemaVersion,
          dailyRequestCounts: acc.dailyRequestCounts,
          verificationRequired: acc.verificationRequired,
          verificationRequiredAt: acc.verificationRequiredAt,
          verificationRequiredReason: acc.verificationRequiredReason,
          verificationUrl: acc.verificationUrl,
          accountIneligible: acc.accountIneligible,
          accountIneligibleAt: acc.accountIneligibleAt,
          accountIneligibleReason: acc.accountIneligibleReason,
          eligibilityStateUpdatedAt: acc.eligibilityStateUpdatedAt
        };
      }).filter((a) => a !== null);
      let fingerprintVersionChanged = false;
      for (const acc of this.accounts) {
        if (acc.fingerprint && updateFingerprintVersion(acc.fingerprint)) {
          fingerprintVersionChanged = true;
        }
      }
      const legacyCursor = clampNonNegativeInt(stored.activeIndex, 0);
      if (this.accounts.length > 0) {
        const defaultIndex = legacyCursor % this.accounts.length;
        this.currentAccountIndexByFamily.claude = clampNonNegativeInt(stored.activeIndexByFamily?.claude, defaultIndex) % this.accounts.length;
        this.currentAccountIndexByFamily.gemini = clampNonNegativeInt(stored.activeIndexByFamily?.gemini, defaultIndex) % this.accounts.length;
        this.cursorByFamily.claude = this.currentAccountIndexByFamily.claude;
        this.cursorByFamily.gemini = this.currentAccountIndexByFamily.gemini;
      }
      if (fingerprintVersionChanged) {
        this.requestSaveToDisk();
      }
      if (authFallback && authParts?.refreshToken) {
        const hasMatching = this.accounts.some((acc) => acc.parts.refreshToken === authParts.refreshToken);
        if (!hasMatching) {
          const now = this.now();
          const newAccount = {
            index: this.accounts.length,
            email: void 0,
            addedAt: now,
            lastUsed: 0,
            parts: authParts,
            access: authFallback.access,
            expires: authFallback.expires,
            enabled: true,
            rateLimitResetTimes: {},
            touchedForQuota: {},
            fingerprint: generateFingerprint(),
            fingerprintHistory: []
          };
          this.accounts.push(newAccount);
        }
      }
      return;
    }
    if (authFallback) {
      const parts = parseRefreshParts(authFallback.refresh);
      if (parts.refreshToken) {
        const now = this.now();
        this.accounts = [
          {
            index: 0,
            email: void 0,
            addedAt: now,
            lastUsed: 0,
            parts,
            access: authFallback.access,
            expires: authFallback.expires,
            enabled: true,
            rateLimitResetTimes: {},
            touchedForQuota: {}
          }
        ];
        this.cursorByFamily = { claude: 0, gemini: 0 };
        this.currentAccountIndexByFamily.claude = 0;
        this.currentAccountIndexByFamily.gemini = 0;
      }
    }
  }
  getAccountCount() {
    return this.getEnabledAccounts().length;
  }
  getTotalAccountCount() {
    return this.accounts.length;
  }
  getEnabledAccounts() {
    return this.accounts.filter((account) => account.enabled !== false);
  }
  getEffectiveSoftQuotaThreshold(thresholdPercent) {
    return this.getEnabledAccounts().length > 1 ? thresholdPercent : 100;
  }
  getAccountsSnapshot() {
    return this.accounts.map((a) => ({
      ...a,
      parts: { ...a.parts },
      rateLimitResetTimes: { ...a.rateLimitResetTimes }
    }));
  }
  getRequestSessionState(identity) {
    const now = this.now();
    this.pruneRequestSessionStates(now, identity.id);
    const existing = this.requestSessionStates.get(identity.id);
    if (existing) {
      existing.lastAccessedAt = now;
      if (identity.parentId) {
        existing.parentId = identity.parentId;
      }
      return existing;
    }
    const state = {
      parentId: identity.parentId ?? null,
      currentAccountIndexByFamily: { claude: -1, gemini: -1 },
      cursorByFamily: { ...this.cursorByFamily },
      offsetAppliedByFamily: { claude: false, gemini: false },
      usedAccounts: /* @__PURE__ */ new Set(),
      lastAccessedAt: now
    };
    this.requestSessionStates.set(identity.id, state);
    return state;
  }
  pruneRequestSessionStates(now, preservedId) {
    const expiry = now - ACCOUNT_SESSION_STATE_TTL_MS;
    for (const [id, state] of this.requestSessionStates) {
      if (id !== preservedId && state.lastAccessedAt < expiry) {
        this.requestSessionStates.delete(id);
      }
    }
    if (this.requestSessionStates.size < MAX_ACCOUNT_SESSION_STATES || this.requestSessionStates.has(preservedId)) {
      return;
    }
    let oldestId = null;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [id, state] of this.requestSessionStates) {
      if (id !== preservedId && state.lastAccessedAt < oldestAccess) {
        oldestId = id;
        oldestAccess = state.lastAccessedAt;
      }
    }
    if (oldestId) {
      this.requestSessionStates.delete(oldestId);
    }
  }
  getActiveIndex(family, identity) {
    return identity ? this.getRequestSessionState(identity).currentAccountIndexByFamily[family] : this.currentAccountIndexByFamily[family];
  }
  setActiveIndex(family, index, identity) {
    if (!identity) {
      this.currentAccountIndexByFamily[family] = index;
      return;
    }
    const state = this.getRequestSessionState(identity);
    state.currentAccountIndexByFamily[family] = index;
    if (!state.parentId) {
      this.currentAccountIndexByFamily[family] = index;
    }
  }
  getCursor(family, identity) {
    return identity ? this.getRequestSessionState(identity).cursorByFamily[family] : this.cursorByFamily[family];
  }
  advanceCursor(family, identity) {
    const nextGlobalCursor = this.cursorByFamily[family] + 1;
    this.cursorByFamily[family] = nextGlobalCursor;
    if (identity) {
      this.getRequestSessionState(identity).cursorByFamily[family] += 1;
    }
  }
  getUsedAccounts(identity) {
    return identity ? this.getRequestSessionState(identity).usedAccounts : this.sessionUsedAccounts;
  }
  preferAccountOutsideParent(accounts, family, identity) {
    if (!identity) {
      return accounts;
    }
    const parentId = this.getRequestSessionState(identity).parentId;
    if (!parentId) {
      return accounts;
    }
    const parentState = this.requestSessionStates.get(parentId);
    const parentIndex = parentState?.currentAccountIndexByFamily[family] ?? -1;
    if (parentIndex < 0) {
      return accounts;
    }
    const isolated = accounts.filter((account) => account.index !== parentIndex);
    return isolated.length > 0 ? isolated : accounts;
  }
  deleteSessionState(sessionId) {
    this.requestSessionStates.delete(sessionId);
  }
  getCurrentAccountForFamily(family, identity) {
    const currentIndex = this.getActiveIndex(family, identity);
    if (currentIndex >= 0 && currentIndex < this.accounts.length) {
      const account = this.accounts[currentIndex] ?? null;
      if (account && account.enabled !== false) {
        return account;
      }
    }
    return null;
  }
  /**
   * Numeric active indexes for each model family. Exposed so callers
   * that persist `activeIndexByFamily` (e.g. command-data's remove
   * path) can capture the live cursor per family without going
   * through the account-lookup layer.
   */
  getActiveIndexByFamily(identity) {
    return {
      claude: this.getActiveIndex("claude", identity),
      gemini: this.getActiveIndex("gemini", identity)
    };
  }
  markSwitched(account, reason, family, identity) {
    account.lastSwitchReason = reason;
    this.setActiveIndex(family, account.index, identity);
  }
  /**
   * Check if we should show an account switch toast.
   * Debounces repeated toasts for the same account.
   */
  shouldShowAccountToast(accountIndex, debounceMs = 3e4) {
    const now = this.now();
    if (accountIndex !== this.lastToastAccountIndex) {
      return true;
    }
    return now - this.lastToastTime >= debounceMs;
  }
  markToastShown(accountIndex) {
    this.lastToastAccountIndex = accountIndex;
    this.lastToastTime = this.now();
  }
  getCurrentOrNextForFamily(family, model, strategy = "sticky", headerStyle = "antigravity", pidOffsetEnabled = false, softQuotaThresholdPercent = 100, softQuotaCacheTtlMs = 10 * 60 * 1e3, identity, excludeIndexes) {
    const quotaKey = getQuotaKey(family, headerStyle, model);
    const effectiveSoftQuotaThreshold = this.getEffectiveSoftQuotaThreshold(softQuotaThresholdPercent);
    if (identity) {
      const pinned = this.getCurrentAccountForFamily(family, identity);
      if (pinned) {
        clearExpiredRateLimits(pinned, this.now);
        const unavailable = (excludeIndexes?.has(pinned.index) ?? false) || isRateLimitedForHeaderStyle(pinned, family, headerStyle, this.now, model) || isOverSoftQuotaThreshold(pinned, family, effectiveSoftQuotaThreshold, softQuotaCacheTtlMs, this.now, model) || this.isAccountCoolingDown(pinned);
        if (!unavailable) {
          this.markTouchedForQuota(pinned, quotaKey);
          return pinned;
        }
      }
    }
    if (strategy === "round-robin") {
      const next2 = this.getNextForFamily(family, model, headerStyle, effectiveSoftQuotaThreshold, softQuotaCacheTtlMs, identity, excludeIndexes);
      if (next2) {
        this.markTouchedForQuota(next2, quotaKey);
        this.setActiveIndex(family, next2.index, identity);
      }
      return next2;
    }
    if (strategy === "main-first") {
      const mainIndex = this.currentAccountIndexByFamily[family] >= 0 ? this.currentAccountIndexByFamily[family] : 0;
      const main = (mainIndex >= 0 && mainIndex < this.accounts.length) ? this.accounts[mainIndex] : null;
      if (main && main.enabled !== false && !excludeIndexes?.has(main.index)) {
        clearExpiredRateLimits(main, this.now);
        const isLimited = isRateLimitedForHeaderStyle(main, family, headerStyle, this.now, model);
        const isOverThreshold = isOverSoftQuotaThreshold(main, family, effectiveSoftQuotaThreshold, softQuotaCacheTtlMs, this.now, model);
        if (!isLimited && !isOverThreshold && !this.isAccountCoolingDown(main)) {
          this.markTouchedForQuota(main, quotaKey);
          this.setActiveIndex(family, main.index, identity);
          return main;
        }
      }
      const next = this.getNextForFamily(family, model, headerStyle, effectiveSoftQuotaThreshold, softQuotaCacheTtlMs, identity, excludeIndexes);
      if (next) {
        this.markTouchedForQuota(next, quotaKey);
        this.setActiveIndex(family, next.index, identity);
      }
      return next;
    }
    if (strategy === "fallback-first") {
      const mainIndex = this.currentAccountIndexByFamily[family] >= 0 ? this.currentAccountIndexByFamily[family] : 0;
      const fallbacks = this.accounts.filter((a) => a.enabled !== false && a.index !== mainIndex && !excludeIndexes?.has(a.index));
      for (const fb of fallbacks) {
        clearExpiredRateLimits(fb, this.now);
        const isLimited = isRateLimitedForHeaderStyle(fb, family, headerStyle, this.now, model);
        const isOverThreshold = isOverSoftQuotaThreshold(fb, family, effectiveSoftQuotaThreshold, softQuotaCacheTtlMs, this.now, model);
        if (!isLimited && !isOverThreshold && !this.isAccountCoolingDown(fb)) {
          this.markTouchedForQuota(fb, quotaKey);
          this.setActiveIndex(family, fb.index, identity);
          return fb;
        }
      }
      const main = (mainIndex >= 0 && mainIndex < this.accounts.length) ? this.accounts[mainIndex] : null;
      if (main && main.enabled !== false && !excludeIndexes?.has(main.index)) {
        clearExpiredRateLimits(main, this.now);
        this.markTouchedForQuota(main, quotaKey);
        this.setActiveIndex(family, main.index, identity);
        return main;
      }
    }
    if (strategy === "hybrid") {
      const healthTracker = getHealthTracker();
      const tokenTracker = getTokenTracker();
      const eligibleAccounts = this.preferAccountOutsideParent(this.accounts.filter((acc) => acc.enabled !== false && !excludeIndexes?.has(acc.index)), family, identity);
      const accountsWithMetrics = eligibleAccounts.map((acc) => {
        clearExpiredRateLimits(acc, this.now);
        return {
          index: acc.index,
          lastUsed: acc.lastUsed,
          healthScore: healthTracker.getScore(acc.index),
          isRateLimited: isRateLimitedForHeaderStyle(acc, family, headerStyle, this.now, model) || isOverSoftQuotaThreshold(acc, family, effectiveSoftQuotaThreshold, softQuotaCacheTtlMs, this.now, model),
          isCoolingDown: this.isAccountCoolingDown(acc)
        };
      });
      const currentIndex = this.getActiveIndex(family, identity);
      const selectedIndex = selectHybridAccount(accountsWithMetrics, tokenTracker, currentIndex, 50, this.now);
      if (selectedIndex !== null) {
        const selected = this.accounts[selectedIndex];
        if (selected) {
          selected.lastUsed = this.now();
          this.markTouchedForQuota(selected, quotaKey);
          this.setActiveIndex(family, selected.index, identity);
          return selected;
        }
      }
    }
    const offsetApplied = identity ? this.getRequestSessionState(identity).offsetAppliedByFamily : this.sessionOffsetApplied;
    if (pidOffsetEnabled && !offsetApplied[family] && this.accounts.length > 1) {
      const pidOffset = this.pid % this.accounts.length;
      const activeIndex = this.getActiveIndex(family, identity);
      const baseIndex = activeIndex >= 0 ? activeIndex : this.getCursor(family, identity);
      const newIndex = (baseIndex + pidOffset) % this.accounts.length;
      this.onDiagnostic?.("Applying PID account offset", {
        pid: this.pid,
        offset: pidOffset,
        family,
        fromIndex: baseIndex,
        toIndex: newIndex
      });
      this.setActiveIndex(family, newIndex, identity);
      offsetApplied[family] = true;
    }
    const current = this.getCurrentAccountForFamily(family, identity);
    if (current && !excludeIndexes?.has(current.index)) {
      clearExpiredRateLimits(current, this.now);
      const isLimitedForRequestedStyle = isRateLimitedForHeaderStyle(current, family, headerStyle, this.now, model);
      const isOverThreshold = isOverSoftQuotaThreshold(current, family, effectiveSoftQuotaThreshold, softQuotaCacheTtlMs, this.now, model);
      if (!isLimitedForRequestedStyle && !isOverThreshold && !this.isAccountCoolingDown(current)) {
        this.markTouchedForQuota(current, quotaKey);
        return current;
      }
    }
    const next = this.getNextForFamily(family, model, headerStyle, effectiveSoftQuotaThreshold, softQuotaCacheTtlMs, identity, excludeIndexes);
    if (next) {
      this.markTouchedForQuota(next, quotaKey);
      this.setActiveIndex(family, next.index, identity);
    }
    return next;
  }
  getNextForFamily(family, model, headerStyle = "antigravity", softQuotaThresholdPercent = 100, softQuotaCacheTtlMs = 10 * 60 * 1e3, identity, excludeIndexes) {
    const effectiveSoftQuotaThreshold = this.getEffectiveSoftQuotaThreshold(softQuotaThresholdPercent);
    const allAvailable = this.accounts.filter((account2) => {
      clearExpiredRateLimits(account2, this.now);
      return account2.enabled !== false && !excludeIndexes?.has(account2.index) && !isRateLimitedForHeaderStyle(account2, family, headerStyle, this.now, model) && !isOverSoftQuotaThreshold(account2, family, effectiveSoftQuotaThreshold, softQuotaCacheTtlMs, this.now, model) && !this.isAccountCoolingDown(account2);
    });
    const available = this.preferAccountOutsideParent(allAvailable, family, identity);
    if (available.length === 0) {
      return null;
    }
    const usedAccounts = this.getUsedAccounts(identity);
    const sessionUsed = available.filter((account2) => usedAccounts.has(account2.index));
    const candidates = sessionUsed.length > 0 ? sessionUsed : available;
    const cursor = this.getCursor(family, identity);
    const account = candidates[cursor % candidates.length];
    if (!account) {
      return null;
    }
    this.advanceCursor(family, identity);
    return account;
  }
  markRateLimited(account, retryAfterMs, family, headerStyle = "antigravity", model) {
    const key = getQuotaKey(family, headerStyle, model);
    account.rateLimitResetTimes[key] = this.now() + retryAfterMs;
  }
  /**
   * Mark an account as used after a successful API request.
   * This updates the lastUsed timestamp for freshness calculations.
   * Should be called AFTER request completion, not during account selection.
   */
  markAccountUsed(accountIndex) {
    const account = this.accounts.find((a) => a.index === accountIndex);
    if (account) {
      account.lastUsed = this.now();
    }
  }
  recordSessionUsage(accountIndex, identity) {
    this.getUsedAccounts(identity).add(accountIndex);
  }
  wasUsedInSession(accountIndex, identity) {
    return this.getUsedAccounts(identity).has(accountIndex);
  }
  shouldProactivelyRotate(family, model, thresholdPercent, cacheTtlMs, identity) {
    if (thresholdPercent <= 0)
      return false;
    const current = this.getCurrentAccountForFamily(family, identity);
    if (!current?.cachedQuota || current.cachedQuotaUpdatedAt == null)
      return false;
    const age = this.now() - current.cachedQuotaUpdatedAt;
    if (age > cacheTtlMs)
      return false;
    const quotaGroup = resolveQuotaGroup(family, model);
    const groupData = current.cachedQuota[quotaGroup];
    if (groupData?.remainingFraction == null)
      return false;
    const remainingPercent = Math.max(0, Math.min(100, groupData.remainingFraction * 100));
    return remainingPercent < thresholdPercent;
  }
  proactivelyRotateForFamily(family, model, headerStyle, softQuotaThresholdPercent, softQuotaCacheTtlMs, identity) {
    const currentIndex = this.getActiveIndex(family, identity);
    const candidates = this.preferAccountOutsideParent(this.accounts.filter((acc) => {
      if (acc.enabled === false)
        return false;
      if (acc.index === currentIndex)
        return false;
      clearExpiredRateLimits(acc, this.now);
      if (isRateLimitedForHeaderStyle(acc, family, headerStyle, this.now, model))
        return false;
      if (isOverSoftQuotaThreshold(acc, family, softQuotaThresholdPercent, softQuotaCacheTtlMs, this.now, model))
        return false;
      if (this.isAccountCoolingDown(acc))
        return false;
      return true;
    }), family, identity);
    if (candidates.length === 0)
      return null;
    const usedAccounts = this.getUsedAccounts(identity);
    const warmCandidates = candidates.filter((account) => usedAccounts.has(account.index));
    const pool = warmCandidates.length > 0 ? warmCandidates : candidates;
    const quotaGroup = resolveQuotaGroup(family, model);
    pool.sort((a, b) => {
      const aRemaining = a.cachedQuota?.[quotaGroup]?.remainingFraction ?? 0;
      const bRemaining = b.cachedQuota?.[quotaGroup]?.remainingFraction ?? 0;
      return bRemaining - aRemaining;
    });
    const selected = pool[0];
    if (!selected)
      return null;
    const quotaKey = getQuotaKey(family, headerStyle, model);
    this.markTouchedForQuota(selected, quotaKey);
    this.setActiveIndex(family, selected.index, identity);
    return selected;
  }
  markRateLimitedWithReason(account, family, headerStyle, model, reason, retryAfterMs, failureTtlMs = 36e5) {
    const now = this.now();
    if (account.lastFailureTime !== void 0 && now - account.lastFailureTime > failureTtlMs) {
      account.consecutiveFailures = 0;
    }
    const failures = (account.consecutiveFailures ?? 0) + 1;
    account.consecutiveFailures = failures;
    account.lastFailureTime = now;
    const backoffMs = calculateBackoffMs(reason, failures - 1, retryAfterMs, this.random);
    const key = getQuotaKey(family, headerStyle, model);
    account.rateLimitResetTimes[key] = now + backoffMs;
    return backoffMs;
  }
  markRequestSuccess(account) {
    if (account.consecutiveFailures) {
      account.consecutiveFailures = 0;
    }
  }
  clearAllRateLimitsForFamily(family, model) {
    for (const account of this.accounts) {
      if (family === "claude") {
        delete account.rateLimitResetTimes.claude;
      } else {
        const antigravityKey = getQuotaKey(family, "antigravity", model);
        const cliKey = getQuotaKey(family, "gemini-cli", model);
        delete account.rateLimitResetTimes[antigravityKey];
        delete account.rateLimitResetTimes[cliKey];
      }
      account.consecutiveFailures = 0;
    }
  }
  shouldTryOptimisticReset(family, model) {
    const minWaitMs = this.getMinWaitTimeForFamily(family, model);
    return minWaitMs > 0 && minWaitMs <= 2e3;
  }
  markAccountCoolingDown(account, cooldownMs, reason) {
    account.coolingDownUntil = this.now() + cooldownMs;
    account.cooldownReason = reason;
  }
  isAccountCoolingDown(account) {
    if (account.coolingDownUntil === void 0) {
      return false;
    }
    if (this.now() >= account.coolingDownUntil) {
      this.clearAccountCooldown(account);
      return false;
    }
    return true;
  }
  clearAccountCooldown(account) {
    delete account.coolingDownUntil;
    delete account.cooldownReason;
  }
  getAccountCooldownReason(account) {
    return this.isAccountCoolingDown(account) ? account.cooldownReason : void 0;
  }
  markTouchedForQuota(account, quotaKey) {
    account.touchedForQuota[quotaKey] = this.now();
  }
  isFreshForQuota(account, quotaKey) {
    const touchedAt = account.touchedForQuota[quotaKey];
    if (!touchedAt)
      return true;
    const resetTime = account.rateLimitResetTimes[quotaKey];
    if (resetTime && touchedAt < resetTime)
      return true;
    return false;
  }
  getFreshAccountsForQuota(quotaKey, family, model) {
    return this.accounts.filter((acc) => {
      clearExpiredRateLimits(acc, this.now);
      return acc.enabled !== false && this.isFreshForQuota(acc, quotaKey) && !isRateLimitedForFamily(acc, family, this.now, model) && !this.isAccountCoolingDown(acc);
    });
  }
  isRateLimitedForHeaderStyle(account, family, headerStyle, model) {
    return isRateLimitedForHeaderStyle(account, family, headerStyle, this.now, model);
  }
  getAvailableHeaderStyle(account, family, model) {
    clearExpiredRateLimits(account, this.now);
    if (family === "claude") {
      return isRateLimitedForHeaderStyle(account, family, "antigravity", this.now) ? null : "antigravity";
    }
    if (!isRateLimitedForHeaderStyle(account, family, "antigravity", this.now, model)) {
      return "antigravity";
    }
    if (!isRateLimitedForHeaderStyle(account, family, "gemini-cli", this.now, model)) {
      return "gemini-cli";
    }
    return null;
  }
  /**
   * Check if any OTHER account has antigravity quota available for the given family/model.
   *
   * Used to determine whether to switch accounts vs fall back to gemini-cli:
   * - If true: Switch to another account (preserve antigravity priority)
   * - If false: All accounts exhausted antigravity, safe to fall back to gemini-cli
   *
   * @param currentAccountIndex - Index of the current account (will be excluded from check)
   * @param family - Model family ("gemini" or "claude")
   * @param model - Optional model name for model-specific rate limits
   * @returns true if any other enabled, non-cooling-down account has antigravity available
   */
  hasOtherAccountWithAntigravityAvailable(currentAccountIndex, family, model) {
    if (family === "claude") {
      return false;
    }
    return this.accounts.some((acc) => {
      if (acc.index === currentAccountIndex) {
        return false;
      }
      if (acc.enabled === false) {
        return false;
      }
      if (this.isAccountCoolingDown(acc)) {
        return false;
      }
      clearExpiredRateLimits(acc, this.now);
      return !isRateLimitedForHeaderStyle(acc, family, "antigravity", this.now, model);
    });
  }
  setAccountEnabled(accountIndex, enabled) {
    const account = this.accounts[accountIndex];
    if (!account) {
      return false;
    }
    if (enabled && account.accountIneligible) {
      return false;
    }
    account.enabled = enabled;
    if (!enabled) {
      for (const family of Object.keys(this.currentAccountIndexByFamily)) {
        if (this.currentAccountIndexByFamily[family] === accountIndex) {
          const next = this.accounts.find((a, i) => i !== accountIndex && a.enabled !== false);
          this.currentAccountIndexByFamily[family] = next?.index ?? -1;
        }
      }
    }
    this.requestSaveToDisk();
    return true;
  }
  markAccountVerificationRequired(accountIndex, reason, verifyUrl) {
    const account = this.accounts[accountIndex];
    if (!account) {
      return false;
    }
    const timestamp = this.now();
    account.verificationRequired = true;
    account.verificationRequiredAt = timestamp;
    account.verificationRequiredReason = reason?.trim() || void 0;
    if (account.accountIneligible === true || account.accountIneligibleAt !== void 0 || account.accountIneligibleReason !== void 0) {
      account.accountIneligible = false;
      account.accountIneligibleAt = void 0;
      account.accountIneligibleReason = void 0;
      account.eligibilityStateUpdatedAt = timestamp;
    }
    const normalizedVerifyUrl = verifyUrl?.trim();
    if (normalizedVerifyUrl) {
      account.verificationUrl = normalizedVerifyUrl;
    }
    if (account.enabled !== false) {
      this.setAccountEnabled(accountIndex, false);
    } else {
      this.requestSaveToDisk();
    }
    return true;
  }
  markAccountIneligible(accountIndex, reason) {
    const account = this.accounts[accountIndex];
    if (!account) {
      return false;
    }
    const timestamp = this.now();
    account.accountIneligible = true;
    account.accountIneligibleAt = timestamp;
    account.accountIneligibleReason = reason?.trim() || "Google marked this account as ineligible.";
    account.eligibilityStateUpdatedAt = timestamp;
    account.verificationRequired = false;
    account.verificationRequiredAt = void 0;
    account.verificationRequiredReason = void 0;
    account.verificationUrl = void 0;
    if (account.enabled !== false) {
      this.setAccountEnabled(accountIndex, false);
    } else {
      this.requestSaveToDisk();
    }
    return true;
  }
  clearAccountAccessBlocks(accountIndex, enableAccount = false) {
    const account = this.accounts[accountIndex];
    if (!account) {
      return false;
    }
    const wasVerificationRequired = account.verificationRequired === true;
    const wasIneligible = account.accountIneligible === true;
    const hadMetadata = wasVerificationRequired || wasIneligible || account.verificationRequiredAt !== void 0 || account.verificationRequiredReason !== void 0 || account.verificationUrl !== void 0 || account.accountIneligibleAt !== void 0 || account.accountIneligibleReason !== void 0 || account.eligibilityStateUpdatedAt !== void 0;
    account.verificationRequired = false;
    account.verificationRequiredAt = void 0;
    account.verificationRequiredReason = void 0;
    account.verificationUrl = void 0;
    account.accountIneligible = false;
    account.accountIneligibleAt = void 0;
    account.accountIneligibleReason = void 0;
    if (wasIneligible || account.eligibilityStateUpdatedAt !== void 0) {
      account.eligibilityStateUpdatedAt = this.now();
    }
    if (enableAccount && (wasVerificationRequired || wasIneligible) && account.enabled === false) {
      this.setAccountEnabled(accountIndex, true);
    } else if (hadMetadata) {
      this.requestSaveToDisk();
    }
    return true;
  }
  removeAccountByIndex(accountIndex) {
    if (accountIndex < 0 || accountIndex >= this.accounts.length) {
      return false;
    }
    const account = this.accounts[accountIndex];
    if (!account) {
      return false;
    }
    return this.removeAccount(account);
  }
  removeAccount(account) {
    const idx = this.accounts.indexOf(account);
    if (idx < 0) {
      return false;
    }
    this.accounts.splice(idx, 1);
    this.accounts.forEach((acc, index) => {
      acc.index = index;
    });
    if (this.accounts.length === 0) {
      this.cursorByFamily = { claude: 0, gemini: 0 };
      this.currentAccountIndexByFamily.claude = -1;
      this.currentAccountIndexByFamily.gemini = -1;
      this.requestSessionStates.clear();
      return true;
    }
    for (const family of ["claude", "gemini"]) {
      if (this.cursorByFamily[family] > idx) {
        this.cursorByFamily[family] -= 1;
      }
      this.cursorByFamily[family] = this.cursorByFamily[family] % this.accounts.length;
      if (this.currentAccountIndexByFamily[family] > idx) {
        this.currentAccountIndexByFamily[family] -= 1;
      }
      if (this.currentAccountIndexByFamily[family] >= this.accounts.length) {
        this.currentAccountIndexByFamily[family] = -1;
      }
      for (const state of this.requestSessionStates.values()) {
        const currentIndex = state.currentAccountIndexByFamily[family];
        if (currentIndex === idx) {
          state.currentAccountIndexByFamily[family] = -1;
        } else if (currentIndex > idx) {
          state.currentAccountIndexByFamily[family] -= 1;
        }
        if (state.cursorByFamily[family] > idx) {
          state.cursorByFamily[family] -= 1;
        }
        state.cursorByFamily[family] %= this.accounts.length;
      }
    }
    for (const state of this.requestSessionStates.values()) {
      state.usedAccounts = new Set([...state.usedAccounts].filter((accountIndex) => accountIndex !== idx).map((accountIndex) => accountIndex > idx ? accountIndex - 1 : accountIndex));
    }
    return true;
  }
  updateFromAuth(account, auth) {
    const parts = parseRefreshParts(auth.refresh);
    account.parts = {
      ...parts,
      projectId: parts.projectId ?? account.parts.projectId,
      managedProjectId: parts.managedProjectId ?? account.parts.managedProjectId
    };
    account.projectId = parts.projectId ?? account.projectId;
    account.managedProjectId = parts.managedProjectId ?? account.managedProjectId;
    account.access = auth.access;
    account.expires = auth.expires;
  }
  toAuthDetails(account) {
    return {
      type: "oauth",
      refresh: formatRefreshParts(account.parts),
      access: account.access,
      expires: account.expires
    };
  }
  getMinWaitTimeForFamily(family, model, headerStyle, strict) {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a, this.now);
      return a.enabled !== false && (strict && headerStyle ? !isRateLimitedForHeaderStyle(a, family, headerStyle, this.now, model) : !isRateLimitedForFamily(a, family, this.now, model));
    });
    if (available.length > 0) {
      return 0;
    }
    const waitTimes = [];
    for (const a of this.accounts) {
      if (family === "claude") {
        const t = a.rateLimitResetTimes.claude;
        if (t !== void 0)
          waitTimes.push(Math.max(0, t - this.now()));
      } else if (strict && headerStyle) {
        const key = getQuotaKey(family, headerStyle, model);
        const t = a.rateLimitResetTimes[key];
        if (t !== void 0)
          waitTimes.push(Math.max(0, t - this.now()));
      } else {
        const antigravityKey = getQuotaKey(family, "antigravity", model);
        const cliKey = getQuotaKey(family, "gemini-cli", model);
        const t1 = a.rateLimitResetTimes[antigravityKey];
        const t2 = a.rateLimitResetTimes[cliKey];
        const accountWait = Math.min(t1 !== void 0 ? Math.max(0, t1 - this.now()) : Infinity, t2 !== void 0 ? Math.max(0, t2 - this.now()) : Infinity);
        if (accountWait !== Infinity)
          waitTimes.push(accountWait);
      }
    }
    return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
  }
  getAccounts() {
    return [...this.accounts];
  }
  buildStorageSnapshot() {
    const claudeIndex = Math.max(0, this.currentAccountIndexByFamily.claude);
    const geminiIndex = Math.max(0, this.currentAccountIndexByFamily.gemini);
    return {
      version: 4,
      accounts: this.accounts.map((a) => ({
        email: a.email,
        label: a.label,
        refreshToken: a.parts.refreshToken,
        projectId: a.parts.projectId ?? a.projectId,
        managedProjectId: a.parts.managedProjectId ?? a.managedProjectId,
        addedAt: a.addedAt,
        lastUsed: a.lastUsed,
        enabled: a.enabled,
        rateLimitResetTimes: Object.keys(a.rateLimitResetTimes).length > 0 ? a.rateLimitResetTimes : void 0,
        fingerprint: a.fingerprint,
        fingerprintHistory: a.fingerprintHistory?.length ? a.fingerprintHistory : void 0,
        cachedQuota: a.cachedQuota && Object.keys(a.cachedQuota).length > 0 ? a.cachedQuota : void 0,
        // Persist the opaque identity stamp alongside the quota so a later
        // loadFromDisk + projection can detect a stale snapshot captured
        // for a different account after an index shift.
        cachedQuotaAccountId: a.cachedQuotaAccountId,
        cachedQuotaUpdatedAt: a.cachedQuotaUpdatedAt,
        capturedTierId: a.capturedTierId,
        capturedPaidTierId: a.capturedPaidTierId,
        capturedTierAt: a.capturedTierAt,
        capturedTierSchemaVersion: a.capturedTierSchemaVersion,
        dailyRequestCounts: a.dailyRequestCounts,
        verificationRequired: a.verificationRequired,
        verificationRequiredAt: a.verificationRequiredAt,
        verificationRequiredReason: a.verificationRequiredReason,
        verificationUrl: a.verificationUrl,
        accountIneligible: a.accountIneligible,
        accountIneligibleAt: a.accountIneligibleAt,
        accountIneligibleReason: a.accountIneligibleReason,
        eligibilityStateUpdatedAt: a.eligibilityStateUpdatedAt
      })),
      activeIndex: claudeIndex,
      activeIndexByFamily: {
        claude: claudeIndex,
        gemini: geminiIndex
      }
    };
  }
  async saveToDisk() {
    await this.store.saveMerged(this.storagePath, this.buildStorageSnapshot());
  }
  /**
   * Persist via full-file replace (no merge). Required after destructive
   * operations (account removal) so a deleted account is not resurrected by
   * mergeAccountStorage re-reading it from disk.
   */
  async saveToDiskReplace() {
    const snapshot = this.buildStorageSnapshot();
    await this.store.mutate(this.storagePath, () => snapshot);
  }
  requestSaveToDisk() {
    if (this.disposed || this.savePending) {
      return;
    }
    this.savePending = true;
    this.saveTimeout = setTimeout(() => {
      this.saveInFlight = this.executeSave().finally(() => {
        this.saveInFlight = null;
      });
    }, 1e3);
  }
  async flushSaveToDisk() {
    if (!this.savePending) {
      await this.saveInFlight;
      return;
    }
    return new Promise((resolve3, reject) => {
      this.savePromiseResolvers.push({ resolve: resolve3, reject });
    });
  }
  async dispose() {
    if (this.disposed)
      return;
    this.disposed = true;
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    if (this.savePending) {
      await this.executeSave();
    }
    await this.saveInFlight;
  }
  async executeSave() {
    this.savePending = false;
    this.saveTimeout = null;
    const resolvers = this.savePromiseResolvers;
    this.savePromiseResolvers = [];
    try {
      await this.saveToDisk();
      for (const { resolve: resolve3 } of resolvers) {
        resolve3();
      }
    } catch (error) {
      if (isStorageLockContention(error)) {
        this.onDiagnostic?.("Skipped account-state persist due to storage lock contention", {
          error: String(error)
        });
        for (const { resolve: resolve3 } of resolvers) {
          resolve3();
        }
        return;
      }
      this.onDiagnostic?.("Failed to persist account state", {
        error: String(error)
      });
      for (const { reject } of resolvers) {
        reject(error);
      }
    }
  }
  // ========== Fingerprint Management ==========
  /**
   * Regenerate fingerprint for an account, saving the old one to history.
   * @param accountIndex - Index of the account to regenerate fingerprint for
   * @returns The new fingerprint, or null if account not found
   */
  regenerateAccountFingerprint(accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account)
      return null;
    if (account.fingerprint) {
      const historyEntry = {
        fingerprint: account.fingerprint,
        timestamp: this.now(),
        reason: "regenerated"
      };
      if (!account.fingerprintHistory) {
        account.fingerprintHistory = [];
      }
      account.fingerprintHistory.unshift(historyEntry);
      if (account.fingerprintHistory.length > MAX_FINGERPRINT_HISTORY) {
        account.fingerprintHistory = account.fingerprintHistory.slice(0, MAX_FINGERPRINT_HISTORY);
      }
    }
    account.fingerprint = generateFingerprint();
    this.requestSaveToDisk();
    return account.fingerprint;
  }
  /**
   * Restore a fingerprint from history for an account.
   * @param accountIndex - Index of the account
   * @param historyIndex - Index in the fingerprint history to restore from (0 = most recent)
   * @returns The restored fingerprint, or null if account/history not found
   */
  restoreAccountFingerprint(accountIndex, historyIndex) {
    const account = this.accounts[accountIndex];
    if (!account)
      return null;
    const history = account.fingerprintHistory;
    if (!history || historyIndex < 0 || historyIndex >= history.length) {
      return null;
    }
    const fingerprintToRestore = history[historyIndex].fingerprint;
    if (account.fingerprint) {
      const historyEntry = {
        fingerprint: account.fingerprint,
        timestamp: this.now(),
        reason: "restored"
      };
      account.fingerprintHistory.unshift(historyEntry);
      if (account.fingerprintHistory.length > MAX_FINGERPRINT_HISTORY) {
        account.fingerprintHistory = account.fingerprintHistory.slice(0, MAX_FINGERPRINT_HISTORY);
      }
    }
    account.fingerprint = { ...fingerprintToRestore, createdAt: this.now() };
    this.requestSaveToDisk();
    return account.fingerprint;
  }
  /**
   * Get fingerprint history for an account.
   * @param accountIndex - Index of the account
   * @returns Array of fingerprint versions, or empty array if not found
   */
  getAccountFingerprintHistory(accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account?.fingerprintHistory) {
      return [];
    }
    return [...account.fingerprintHistory];
  }
  updateQuotaCache(accountIndex, quotaGroups, expectedRefreshToken) {
    const account = this.accounts[accountIndex];
    if (!account || account.parts.refreshToken !== expectedRefreshToken && expectedRefreshToken !== void 0)
      return;
    account.cachedQuota = quotaGroups;
    account.cachedQuotaAccountId = quotaAccountIdentity(account.parts.refreshToken);
    account.cachedQuotaUpdatedAt = this.now();
  }
  /**
   * Apply a subset of fields from a quota-fetch `updatedAccount` result onto
   * the live in-memory record for the given index. Only patches fields that
   * are present and non-empty in `patch` to avoid overwriting valid state
   * with stale or missing values.
   *
   * Identity guard: if `expectedRefreshToken` is provided and the account at
   * `accountIndex` no longer carries that token (concurrent reorder/replace),
   * the patch is silently dropped.
   *
   * `managedProjectId` is intentionally absent from the patch type: the only
   * caller (`BackgroundQuotaRefresh`) routes through `PollerAccountView` which
   * exposes only `capturedTierId`/`capturedTierAt`; project-context updates
   * happen via `ensureProjectContext`, not through this method.
   */
  applyUpdatedAccount(accountIndex, patch, expectedRefreshToken) {
    const account = this.accounts[accountIndex];
    if (!account || expectedRefreshToken !== void 0 && account.parts.refreshToken !== expectedRefreshToken)
      return;
    if (patch.capturedTierId !== void 0) {
      account.capturedTierId = patch.capturedTierId;
    }
    if (patch.capturedPaidTierId !== void 0) {
      account.capturedPaidTierId = patch.capturedPaidTierId;
    }
    if (patch.capturedTierAt !== void 0) {
      account.capturedTierAt = patch.capturedTierAt;
    }
    if (patch.capturedTierSchemaVersion !== void 0) {
      account.capturedTierSchemaVersion = patch.capturedTierSchemaVersion;
    }
  }
  /**
   * Record a successful API request for an account.
   * Tracks per model family with daily reset.
   */
  recordRequest(accountIndex, family) {
    const account = this.accounts[accountIndex];
    if (!account)
      return;
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (!account.dailyRequestCounts || account.dailyRequestCounts.date !== today) {
      account.dailyRequestCounts = { date: today, claude: 0, gemini: 0 };
    }
    account.dailyRequestCounts[family]++;
    account.lastUsed = this.now();
    this.recordSessionRequest(accountIndex, family);
  }
  /**
   * Get request counts for an account for today.
   */
  getDailyRequestCounts(accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account?.dailyRequestCounts)
      return null;
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (account.dailyRequestCounts.date !== today)
      return null;
    return { ...account.dailyRequestCounts };
  }
  /**
   * Get total daily request counts across all accounts for a model family.
   */
  getTotalDailyRequests(family) {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    let total = 0;
    for (const account of this.accounts) {
      if (account.dailyRequestCounts?.date === today) {
        total += account.dailyRequestCounts[family];
      }
    }
    return total;
  }
  /**
   * Get a summary of daily request distribution across accounts.
   * Returns accounts sorted by request count (descending).
   */
  getDailyRequestSummary(family) {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const result = [];
    for (const account of this.accounts) {
      const count = account.dailyRequestCounts?.date === today ? account.dailyRequestCounts[family] : 0;
      if (count > 0) {
        result.push({ index: account.index, email: account.email, count });
      }
    }
    return result.sort((a, b) => b.count - a.count);
  }
  /**
   * Record a request for the current session (in-memory only).
   */
  recordSessionRequest(accountIndex, family) {
    const key = String(accountIndex);
    const current = this.sessionRequestCounts.get(key) ?? {
      claude: 0,
      gemini: 0
    };
    current[family]++;
    this.sessionRequestCounts.set(key, current);
  }
  /**
   * Get a summary of the current session's request usage.
   */
  getSessionSummary() {
    const durationMs = this.now() - this.sessionStartTime;
    const durationMinutes = Math.round(durationMs / 6e4);
    const durationHours = durationMs / 36e5;
    let totalClaude = 0;
    let totalGemini = 0;
    const perAccount = [];
    for (const [key, counts] of this.sessionRequestCounts) {
      const idx = Number(key);
      const account = this.accounts[idx];
      totalClaude += counts.claude;
      totalGemini += counts.gemini;
      if (counts.claude > 0 || counts.gemini > 0) {
        perAccount.push({
          index: idx,
          email: account?.email,
          claude: counts.claude,
          gemini: counts.gemini
        });
      }
    }
    const totalRequests = totalClaude + totalGemini;
    const requestsPerHour = durationHours > 0 ? Math.round(totalRequests / durationHours) : 0;
    return {
      durationMinutes,
      totalClaude,
      totalGemini,
      requestsPerHour,
      accountsUsed: perAccount.length,
      perAccount: perAccount.sort((a, b) => b.claude + b.gemini - (a.claude + a.gemini))
    };
  }
  isAccountOverSoftQuota(account, family, thresholdPercent, cacheTtlMs, model) {
    return isOverSoftQuotaThreshold(account, family, this.getEffectiveSoftQuotaThreshold(thresholdPercent), cacheTtlMs, this.now, model);
  }
  getAccountsForQuotaCheck() {
    return this.accounts.map((a) => ({
      email: a.email,
      refreshToken: a.parts.refreshToken,
      projectId: a.parts.projectId ?? a.projectId,
      managedProjectId: a.parts.managedProjectId ?? a.managedProjectId,
      addedAt: a.addedAt,
      lastUsed: a.lastUsed,
      enabled: a.enabled
    }));
  }
  getOldestQuotaCacheAge() {
    let oldest = null;
    for (const acc of this.accounts) {
      if (acc.enabled === false)
        continue;
      if (acc.cachedQuotaUpdatedAt == null)
        return null;
      const age = this.now() - acc.cachedQuotaUpdatedAt;
      if (oldest === null || age > oldest)
        oldest = age;
    }
    return oldest;
  }
  areAllAccountsOverSoftQuota(family, thresholdPercent, cacheTtlMs, model) {
    if (thresholdPercent >= 100)
      return false;
    const enabled = this.accounts.filter((a) => a.enabled !== false);
    if (enabled.length <= 1)
      return false;
    return enabled.every((a) => isOverSoftQuotaThreshold(a, family, thresholdPercent, cacheTtlMs, this.now, model));
  }
  /**
   * Get minimum wait time until any account's soft quota resets.
   * Returns 0 if any account is available (not over threshold).
   * Returns the minimum resetTime across all over-threshold accounts.
   * Returns null if no resetTime data is available.
   */
  getMinWaitTimeForSoftQuota(family, thresholdPercent, cacheTtlMs, model) {
    if (thresholdPercent >= 100)
      return 0;
    const enabled = this.accounts.filter((a) => a.enabled !== false);
    if (enabled.length === 0)
      return null;
    if (enabled.length === 1)
      return 0;
    const available = enabled.filter((a) => !isOverSoftQuotaThreshold(a, family, thresholdPercent, cacheTtlMs, this.now, model));
    if (available.length > 0)
      return 0;
    if (!model && family !== "claude")
      return null;
    const quotaGroup = resolveQuotaGroup(family, model);
    const now = this.now();
    const waitTimes = [];
    for (const acc of enabled) {
      const groupData = acc.cachedQuota?.[quotaGroup];
      if (groupData?.resetTime) {
        const resetTimestamp = Date.parse(groupData.resetTime);
        if (Number.isFinite(resetTimestamp)) {
          waitTimes.push(Math.max(0, resetTimestamp - now));
        }
      }
    }
    if (waitTimes.length === 0)
      return null;
    const minWait = Math.min(...waitTimes);
    return minWait === 0 ? null : minWait;
  }
};

// ../core/dist/agy-request-metadata.js
import { Buffer as Buffer2 } from "node:buffer";
import { randomUUID as randomUUID4 } from "node:crypto";
var FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n;
var FNV1A_64_PRIME = 0x100000001b3n;
var DEFAULT_SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1e3;
var DEFAULT_MAX_SESSION_STATES = 256;
var AGY_REQUEST_FIELD_ORDER = [
  "contents",
  "systemInstruction",
  "tools",
  "toolConfig",
  "labels",
  "generationConfig",
  "sessionId"
];
var AGY_MODEL_ENUM_BY_WIRE_MODEL = {
  "gemini-3.5-flash-extra-low": "MODEL_PLACEHOLDER_M187",
  "gemini-3.5-flash-low": "MODEL_PLACEHOLDER_M20",
  "gemini-3-flash-agent": "MODEL_PLACEHOLDER_M84",
  "gemini-3.6-flash-low": "MODEL_PLACEHOLDER_M73",
  "gemini-3.6-flash-medium": "MODEL_PLACEHOLDER_M72",
  "gemini-3.6-flash-high": "MODEL_PLACEHOLDER_M71",
  "gemini-3.7-flash-low": "MODEL_PLACEHOLDER_M300",
  "gemini-3.7-flash-medium": "MODEL_PLACEHOLDER_M299",
  "gemini-3.7-flash-high": "MODEL_PLACEHOLDER_M298",
  "gemini-3.8-flash-low": "MODEL_PLACEHOLDER_M320",
  "gemini-3.8-flash-medium": "MODEL_PLACEHOLDER_M319",
  "gemini-3.8-flash-high": "MODEL_PLACEHOLDER_M318",
  "gemini-3.1-pro-low": "MODEL_PLACEHOLDER_M36",
  "gemini-pro-agent": "MODEL_PLACEHOLDER_M16",
  "claude-sonnet-4-6": "MODEL_PLACEHOLDER_M35",
  "claude-opus-4-6-thinking": "MODEL_PLACEHOLDER_M26",
  "gemini-3.1-flash-image": "MODEL_PLACEHOLDER_M21",
  "gpt-oss-120b-medium": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM"
};
function fnv1a64Signed(input2) {
  let hash = FNV1A_64_OFFSET_BASIS;
  for (const byte of Buffer2.from(input2, "utf8")) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * FNV1A_64_PRIME);
  }
  return BigInt.asIntN(64, hash).toString();
}
function createAgyRequestSessionContext(workspaceUri, ids = {}) {
  return {
    conversationId: ids.conversationId ?? randomUUID4(),
    trajectoryId: ids.trajectoryId ?? randomUUID4(),
    numericSessionId: fnv1a64Signed(workspaceUri)
  };
}
var AgyRequestSessionStore = class {
  entries = /* @__PURE__ */ new Map();
  workspaceUri;
  ttlMs;
  maxEntries;
  now;
  constructor(workspaceUri, options = {}) {
    this.workspaceUri = workspaceUri;
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_STATE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_SESSION_STATES;
    this.now = options.now ?? Date.now;
  }
  getOrCreate(key) {
    const timestamp = this.now();
    this.prune(timestamp, key);
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastAccessedAt = timestamp;
      return existing.context;
    }
    const context = createAgyRequestSessionContext(this.workspaceUri);
    this.entries.set(key, {
      context,
      lastAccessedAt: timestamp,
      lastRequestTimestamp: 0
    });
    return context;
  }
  beginRequest(key) {
    const session = this.getOrCreate(key);
    const stored = this.entries.get(key);
    const timestamp = Math.max(stored.lastAccessedAt, stored.lastRequestTimestamp + 1);
    stored.lastRequestTimestamp = timestamp;
    return { session, timestamp };
  }
  completeExecution(key) {
    const stored = this.entries.get(key);
    if (stored) {
      stored.context.lastExecutionId = randomUUID4();
    }
  }
  has(key) {
    return this.entries.has(key);
  }
  delete(key) {
    this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
  }
  get size() {
    return this.entries.size;
  }
  prune(timestamp, preservedKey) {
    const expiry = timestamp - this.ttlMs;
    for (const [key, value] of this.entries) {
      if (key !== preservedKey && value.lastAccessedAt < expiry) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size >= this.maxEntries && !this.entries.has(preservedKey)) {
      let oldestKey = null;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [key, value] of this.entries) {
        if (key !== preservedKey && value.lastAccessedAt < oldestAccess) {
          oldestKey = key;
          oldestAccess = value.lastAccessedAt;
        }
      }
      if (!oldestKey) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }
};
function getAgyModelEnum(model) {
  return AGY_MODEL_ENUM_BY_WIRE_MODEL[model.toLowerCase()];
}
function orderAgyRequestPayloadInPlace(payload) {
  const ordered = {};
  const remaining = new Set(Object.keys(payload));
  for (const key of AGY_REQUEST_FIELD_ORDER) {
    if (key in payload) {
      ordered[key] = payload[key];
      remaining.delete(key);
    }
  }
  for (const key of remaining) {
    ordered[key] = payload[key];
  }
  for (const key of Object.keys(payload)) {
    delete payload[key];
  }
  Object.assign(payload, ordered);
}
function countAgyRequestSteps(payload, mode = "parts") {
  const contents = payload.contents;
  if (!Array.isArray(contents))
    return 1;
  if (mode === "contents")
    return Math.max(1, contents.length);
  let partCount = 0;
  let functionResponseCount = 0;
  for (const content of contents) {
    if (!content || typeof content !== "object" || Array.isArray(content))
      continue;
    const parts = content.parts;
    if (!Array.isArray(parts))
      continue;
    partCount += parts.length;
    if (mode === "cli") {
      functionResponseCount += parts.filter((part) => {
        if (!part || typeof part !== "object" || Array.isArray(part))
          return false;
        return "functionResponse" in part;
      }).length;
    }
  }
  if (mode === "cli") {
    return Math.max(1, contents.length + functionResponseCount);
  }
  return Math.max(1, partCount);
}
function buildAgyAgentRequestMetadata(session, payload, model, timestamp = Date.now(), options = {}) {
  const lastStepIndex = countAgyRequestSteps(payload, options.stepCountMode) + (session.lastExecutionId ? 1 : 0);
  const isClaude = model.toLowerCase().startsWith("claude-");
  const isNonGemini = isClaude || model.toLowerCase().startsWith("gpt-");
  session.usedClaude = session.usedClaude === true || isClaude;
  session.usedNonGeminiModel = session.usedNonGeminiModel === true || isNonGemini;
  const modelEnum = getAgyModelEnum(model);
  const labels = {
    ...session.lastExecutionId ? { last_execution_id: session.lastExecutionId } : {},
    last_step_index: String(lastStepIndex),
    ...modelEnum ? { model_enum: modelEnum } : {},
    trajectory_id: session.trajectoryId,
    used_claude: session.usedClaude ? "true" : "false",
    used_claude_conservative: session.usedClaude ? "true" : "false",
    used_non_gemini_model: session.usedNonGeminiModel ? "true" : "false"
  };
  return {
    requestId: `agent/${session.conversationId}/${timestamp}/${session.trajectoryId}/${lastStepIndex + 1}`,
    sessionId: session.numericSessionId,
    labels,
    lastStepIndex
  };
}

// ../core/dist/agy-transport.js
import { Buffer as Buffer3 } from "node:buffer";
import * as net from "node:net";
import { PassThrough, Readable, Transform } from "node:stream";
import * as tls from "node:tls";
import { createGunzip } from "node:zlib";
var DEFAULT_HTTPS_PORT = 443;
var DEFAULT_PROXY_PORT = 8080;
var DEFAULT_AGY_RESPONSE_HEADER_TIMEOUT_MS = 18e4;
var DEFAULT_AGY_IDLE_TIMEOUT_MS = 18e4;
function headersToRecord(headers) {
  const result = {};
  if (!headers)
    return result;
  const normalized = new Headers(headers);
  normalized.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}
function getHeader(headers, name) {
  return headers[name.toLowerCase()];
}
function bodyToBuffer(body) {
  if (body == null)
    return Buffer3.alloc(0);
  if (typeof body === "string")
    return Buffer3.from(body);
  if (body instanceof Uint8Array)
    return Buffer3.from(body);
  if (body instanceof ArrayBuffer)
    return Buffer3.from(body);
  throw new Error("agy transport only supports string/byte request bodies");
}
function shouldUseChunkedBody(url) {
  return url.pathname.includes(":streamGenerateContent");
}
function buildAgyCliHeaderPairs(url, init = {}) {
  const parsedUrl = new URL(url);
  const headers = headersToRecord(init.headers);
  const body = bodyToBuffer(init.body);
  const host = parsedUrl.port ? `${parsedUrl.hostname}:${parsedUrl.port}` : parsedUrl.hostname;
  const userAgent = getHeader(headers, "User-Agent") ?? buildAntigravityHarnessUserAgent();
  const authorization = getHeader(headers, "Authorization");
  const contentType = getHeader(headers, "Content-Type") ?? "application/json";
  const acceptEncoding = getHeader(headers, "Accept-Encoding") ?? "gzip";
  const chunked = shouldUseChunkedBody(parsedUrl);
  const pairs = [
    ["Host", host],
    ["User-Agent", userAgent]
  ];
  if (chunked) {
    pairs.push(["Transfer-Encoding", "chunked"]);
  } else {
    pairs.push(["Content-Length", String(body.byteLength)]);
  }
  if (authorization) {
    pairs.push(["Authorization", authorization]);
  }
  pairs.push(["Content-Type", contentType]);
  pairs.push(["Accept-Encoding", acceptEncoding]);
  return pairs;
}
function noProxyIncludes(hostname) {
  const raw = process.env.NO_PROXY || process.env.no_proxy || "";
  if (!raw)
    return false;
  const host = hostname.toLowerCase();
  return raw.split(",").map((entry) => entry.trim().toLowerCase()).some((entry) => {
    if (!entry)
      return false;
    if (entry === "*")
      return true;
    if (entry.startsWith("."))
      return host.endsWith(entry);
    return host === entry || host.endsWith(`.${entry}`);
  });
}
function getHttpsProxy(url) {
  if (url.protocol !== "https:" || noProxyIncludes(url.hostname))
    return void 0;
  const rawProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (!rawProxy)
    return void 0;
  try {
    return new URL(rawProxy);
  } catch {
    return void 0;
  }
}
function waitForHead(socket, timeoutMs, onTimeout) {
  return new Promise((resolve3, reject) => {
    let buffer = Buffer3.alloc(0);
    const timeout = setTimeout(() => {
      onTimeout();
      cleanup(() => reject(new Error(`Antigravity request timed out waiting for response headers after ${timeoutMs}ms`)));
    }, timeoutMs);
    const cleanup = (finish) => {
      socket.off("data", onData);
      socket.off("error", onError);
      clearTimeout(timeout);
      finish();
    };
    const onError = (error) => cleanup(() => reject(error));
    const onData = (chunk) => {
      buffer = Buffer3.concat([buffer, chunk]);
      const marker = buffer.indexOf("\r\n\r\n");
      if (marker === -1)
        return;
      const head = buffer.subarray(0, marker).toString("latin1");
      const leftover = buffer.subarray(marker + 4);
      cleanup(() => resolve3({ head, leftover }));
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}
async function connectViaProxy(proxyUrl, targetUrl, timeoutMs, onDebug) {
  const proxySocket = net.connect({
    host: proxyUrl.hostname,
    port: Number(proxyUrl.port || DEFAULT_PROXY_PORT)
  });
  await new Promise((resolve3, reject) => {
    const timeout = setTimeout(() => {
      onDebug?.(`agy transport proxy connect timeout after ${timeoutMs}ms`);
      proxySocket.destroy();
      reject(new Error(`Antigravity request timed out connecting to HTTPS proxy after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => clearTimeout(timeout);
    proxySocket.once("connect", () => {
      cleanup();
      resolve3();
    });
    proxySocket.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
  const targetHost = targetUrl.hostname;
  const targetPort = Number(targetUrl.port || DEFAULT_HTTPS_PORT);
  const auth = proxyUrl.username ? `Proxy-Authorization: Basic ${Buffer3.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64")}\r
` : "";
  proxySocket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r
Host: ${targetHost}:${targetPort}\r
` + auth + "\r\n");
  const { head, leftover } = await waitForHead(proxySocket, timeoutMs, () => {
    onDebug?.(`agy transport proxy CONNECT response timeout after ${timeoutMs}ms`);
    proxySocket.destroy();
  });
  if (!/^HTTP\/1\.[01] 2\d\d\b/.test(head)) {
    proxySocket.destroy();
    throw new Error(`Proxy CONNECT failed: ${head.split("\r\n")[0] ?? "unknown"}`);
  }
  if (leftover.length > 0) {
    proxySocket.unshift(leftover);
  }
  return await new Promise((resolve3, reject) => {
    const tlsSocket = tls.connect({
      socket: proxySocket,
      servername: targetHost
    });
    const timeout = setTimeout(() => {
      onDebug?.(`agy transport proxy TLS handshake timeout after ${timeoutMs}ms`);
      tlsSocket.destroy();
      reject(new Error(`Antigravity request timed out during proxy TLS handshake after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => clearTimeout(timeout);
    tlsSocket.once("secureConnect", () => {
      cleanup();
      resolve3(tlsSocket);
    });
    tlsSocket.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}
async function connectDirect(targetUrl, timeoutMs, onDebug) {
  return await new Promise((resolve3, reject) => {
    const socket = tls.connect({
      host: targetUrl.hostname,
      port: Number(targetUrl.port || DEFAULT_HTTPS_PORT),
      servername: targetUrl.hostname
    });
    const timeout = setTimeout(() => {
      onDebug?.(`agy transport TLS connect timeout after ${timeoutMs}ms`);
      socket.destroy();
      reject(new Error(`Antigravity request timed out connecting after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => clearTimeout(timeout);
    socket.once("secureConnect", () => {
      cleanup();
      resolve3(socket);
    });
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}
async function connectTls(targetUrl, timeoutMs, onDebug) {
  const proxyUrl = getHttpsProxy(targetUrl);
  return proxyUrl ? await connectViaProxy(proxyUrl, targetUrl, timeoutMs, onDebug) : await connectDirect(targetUrl, timeoutMs, onDebug);
}
function serializeRequest(url, init, body) {
  const method = init.method ?? "POST";
  const path5 = `${url.pathname}${url.search}`;
  const headerLines = buildAgyCliHeaderPairs(url.toString(), init).map(([key, value]) => `${key}: ${value}`).join("\r\n");
  const head = Buffer3.from(`${method} ${path5} HTTP/1.1\r
${headerLines}\r
\r
`);
  if (body.byteLength === 0) {
    return head;
  }
  if (!shouldUseChunkedBody(url)) {
    return Buffer3.concat([head, body]);
  }
  return Buffer3.concat([
    head,
    Buffer3.from(`${body.byteLength.toString(16)}\r
`),
    body,
    Buffer3.from("\r\n0\r\n\r\n")
  ]);
}
function parseResponseHead(head) {
  const lines = head.split("\r\n");
  const statusLine = lines.shift() ?? "";
  const match = /^HTTP\/1\.[01]\s+(\d{3})\s*(.*)$/.exec(statusLine);
  if (!match) {
    throw new Error(`Invalid HTTP response: ${statusLine}`);
  }
  const headers = new Headers();
  let chunked = false;
  let gzip = false;
  let contentLength;
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index <= 0)
      continue;
    const key = line.slice(0, index);
    const value = line.slice(index + 1).trim();
    const lowerKey = key.toLowerCase();
    const lowerValue = value.toLowerCase();
    if (lowerKey === "transfer-encoding" && lowerValue.includes("chunked")) {
      chunked = true;
      continue;
    }
    if (lowerKey === "content-encoding" && lowerValue.includes("gzip")) {
      gzip = true;
      continue;
    }
    if (lowerKey === "content-length") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        contentLength = parsed;
      }
      if (gzip)
        continue;
    }
    headers.append(key, value);
  }
  return {
    status: Number(match[1]),
    statusText: match[2] ?? "",
    headers,
    chunked,
    gzip,
    contentLength
  };
}
var ContentLengthStream = class extends Transform {
  remaining;
  constructor(contentLength) {
    super();
    this.remaining = contentLength;
  }
  _transform(chunk, _encoding, callback) {
    if (this.remaining <= 0) {
      callback();
      return;
    }
    if (chunk.length <= this.remaining) {
      this.remaining -= chunk.length;
      this.push(chunk);
    } else {
      this.push(chunk.subarray(0, this.remaining));
      this.remaining = 0;
    }
    if (this.remaining <= 0) {
      this.push(null);
    }
    callback();
  }
};
var ChunkedDecodeStream = class extends Transform {
  buffer = Buffer3.alloc(0);
  _transform(chunk, _encoding, callback) {
    this.buffer = Buffer3.concat([this.buffer, chunk]);
    try {
      this.flushAvailableChunks();
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
  _flush(callback) {
    try {
      this.flushAvailableChunks();
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
  flushAvailableChunks() {
    while (true) {
      const lineEnd = this.buffer.indexOf("\r\n");
      if (lineEnd === -1)
        return;
      const sizeLine = this.buffer.subarray(0, lineEnd).toString("latin1");
      const sizeText = sizeLine.split(";", 1)[0]?.trim() ?? "";
      const size = Number.parseInt(sizeText, 16);
      if (!Number.isFinite(size)) {
        throw new Error(`Invalid chunk size: ${sizeLine}`);
      }
      const chunkStart = lineEnd + 2;
      const chunkEnd = chunkStart + size;
      const nextOffset = chunkEnd + 2;
      if (this.buffer.length < nextOffset)
        return;
      if (size === 0) {
        this.buffer = Buffer3.alloc(0);
        this.push(null);
        return;
      }
      this.push(this.buffer.subarray(chunkStart, chunkEnd));
      this.buffer = this.buffer.subarray(nextOffset);
    }
  }
};
function buildResponseStream(socket, leftover, head, signal, idleTimeoutMs, onDebug) {
  const source = new PassThrough();
  if (leftover.length > 0) {
    source.write(leftover);
  }
  socket.pipe(source);
  let responseBody = source;
  if (head.chunked) {
    responseBody = responseBody.pipe(new ChunkedDecodeStream());
  } else if (typeof head.contentLength === "number") {
    responseBody = responseBody.pipe(new ContentLengthStream(head.contentLength));
  }
  if (head.gzip) {
    responseBody = responseBody.pipe(createGunzip());
  }
  let idleTimer;
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = void 0;
    }
  };
  const armIdle = () => {
    if (!idleTimeoutMs || idleTimeoutMs <= 0)
      return;
    clearIdle();
    idleTimer = setTimeout(() => {
      onDebug?.(`agy transport idle timeout after ${idleTimeoutMs}ms with no body data`);
      socket.destroy(new Error(`Antigravity response stalled: no data for ${idleTimeoutMs}ms`));
    }, idleTimeoutMs);
  };
  socket.on("data", armIdle);
  armIdle();
  const abort = () => socket.destroy(new DOMException("The operation was aborted", "AbortError"));
  const cleanup = () => {
    clearIdle();
    socket.off("data", armIdle);
    signal?.removeEventListener("abort", abort);
  };
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }
  responseBody.once("end", () => {
    cleanup();
    socket.destroy();
  });
  responseBody.once("error", () => {
    cleanup();
    socket.destroy();
  });
  responseBody.once("close", cleanup);
  return Readable.toWeb(responseBody);
}
async function fetchWithAgyCliTransport(url, init = {}, options = {}) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`agy transport only supports https URLs: ${url}`);
  }
  if (options.signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
  const body = bodyToBuffer(init.body);
  const requestBytes = serializeRequest(parsedUrl, init, body);
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGY_RESPONSE_HEADER_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_AGY_IDLE_TIMEOUT_MS;
  options.onDebug?.(`agy transport connecting to ${parsedUrl.hostname} with header timeout ${timeoutMs}ms`);
  const socket = await connectTlsWithAbort(parsedUrl, timeoutMs, options.signal, options.onDebug);
  const abort = () => {
    socket.destroy(new DOMException("The operation was aborted", "AbortError"));
  };
  try {
    options.signal?.addEventListener("abort", abort, { once: true });
    socket.write(requestBytes);
    options.onDebug?.(`agy transport request dispatched (${requestBytes.byteLength} bytes)`);
    const { head, leftover } = await waitForHead(socket, timeoutMs, () => {
      options.onDebug?.(`agy transport response header timeout after ${timeoutMs}ms`);
      socket.destroy();
    });
    const parsedHead = parseResponseHead(head);
    options.onDebug?.(`agy transport response headers received: ${parsedHead.status} ${parsedHead.statusText}`);
    const bodyStream = buildResponseStream(socket, leftover, parsedHead, options.signal, idleTimeoutMs, options.onDebug);
    return new Response(bodyStream, {
      status: parsedHead.status,
      statusText: parsedHead.statusText,
      headers: parsedHead.headers
    });
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
async function connectTlsWithAbort(targetUrl, timeoutMs, signal, onDebug) {
  if (!signal) {
    return connectTls(targetUrl, timeoutMs, onDebug);
  }
  const connectPromise = connectTls(targetUrl, timeoutMs, onDebug);
  let onAbort;
  const abortPromise = new Promise((_, reject) => {
    onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([connectPromise, abortPromise]);
  } catch (error) {
    void connectPromise.then((socket) => socket.destroy()).catch(() => {
    });
    throw error;
  } finally {
    if (onAbort)
      signal.removeEventListener("abort", onAbort);
  }
}

// ../core/dist/antigravity/oauth.js
import { createHash as createHash2, randomBytes as randomBytes2 } from "node:crypto";

// ../core/dist/constants.js
var ANTIGRAVITY_CLIENT_ID = Buffer.from("1b1a1d1b1a1a1c1a1c1a1f131b075e4742595943441842181b4649584f18191f5c5e45464540421e4d1e1a194f5a044b5a5a59044d45454d464f5f594f584945445e4f445e04494547", "hex").map(function(b){return b^42;}).toString("utf8");
var ANTIGRAVITY_CLIENT_SECRET = Buffer.from("6d6569797a7207611f126c7d781e121c664e66601b476668125972691e501c5b6e6b4c", "hex").map(function(b){return b^42;}).toString("utf8");
var ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs"
];
var ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
var ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.googleapis.com";
var ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
var ANTIGRAVITY_ENDPOINT_FALLBACKS = [
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_PROD
];
var ANTIGRAVITY_LOAD_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_PROD
];
var ANTIGRAVITY_ENDPOINT = ANTIGRAVITY_ENDPOINT_DAILY;
var GEMINI_CLI_ENDPOINT = ANTIGRAVITY_ENDPOINT_PROD;
var ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";
var ANTIGRAVITY_VERSION_FALLBACK = "1.18.3";
var antigravityVersion = ANTIGRAVITY_VERSION_FALLBACK;
var versionLocked = false;
function getAntigravityVersion() {
  return antigravityVersion;
}
function setAntigravityVersion(version) {
  if (versionLocked)
    return;
  antigravityVersion = version;
  versionLocked = true;
}
var ANTIGRAVITY_VERSION = ANTIGRAVITY_VERSION_FALLBACK;
var ANTIGRAVITY_HEADERS = {
  "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/${ANTIGRAVITY_VERSION} Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`,
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata": `{"ideType":"ANTIGRAVITY","platform":"${process.platform === "win32" ? "WINDOWS" : "MACOS"}","pluginType":"GEMINI"}`
};
var GEMINI_CLI_VERSION = "1.0.0";
var GEMINI_CLI_DEFAULT_MODEL = "gemini-2.5-pro";
function buildGeminiCliUserAgent(model) {
  const effectiveModel = model || GEMINI_CLI_DEFAULT_MODEL;
  const platform = process.platform || "darwin";
  const arch = process.arch || "arm64";
  return `GeminiCLI/${GEMINI_CLI_VERSION}/${effectiveModel} (${platform}; ${arch})`;
}
var GEMINI_CLI_HEADERS = {
  "User-Agent": "google-api-nodejs-client/9.15.1",
  "X-Goog-Api-Client": "gl-node/22.17.0",
  "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI"
};
function getRandomizedHeaders(style, model) {
  if (style === "gemini-cli") {
    return {
      "User-Agent": buildGeminiCliUserAgent(model),
      "X-Goog-Api-Client": GEMINI_CLI_HEADERS["X-Goog-Api-Client"],
      "Client-Metadata": GEMINI_CLI_HEADERS["Client-Metadata"]
    };
  }
  return {
    "User-Agent": buildAntigravityHarnessUserAgent()
  };
}
var ANTIGRAVITY_PROVIDER_ID = "google";
var CLAUDE_TOOL_SYSTEM_INSTRUCTION = `CRITICAL TOOL USAGE INSTRUCTIONS:
You are operating in a custom environment where tool definitions differ from your training data.
You MUST follow these rules strictly:

1. DO NOT use your internal training data to guess tool parameters
2. ONLY use the exact parameter structure defined in the tool schema
3. Parameter names in schemas are EXACT - do not substitute with similar names from your training
4. Array parameters have specific item types - check the schema's 'items' field for the exact structure
5. When you see "STRICT PARAMETERS" in a tool description, those type definitions override any assumptions
6. Tool use in agentic workflows is REQUIRED - you must call tools with the exact parameters specified

If you are unsure about a tool's parameters, YOU MUST read the schema definition carefully.`;
var CLAUDE_DESCRIPTION_PROMPT = "\n\n\u26A0\uFE0F STRICT PARAMETERS: {params}.";
var EMPTY_SCHEMA_PLACEHOLDER_NAME = "_placeholder";
var EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION = "Placeholder. Always pass true.";
var SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
var SEARCH_MODEL = "gemini-2.5-flash";
var SEARCH_TIMEOUT_MS = 6e4;
var SEARCH_SYSTEM_INSTRUCTION = `You are an expert web search assistant with access to Google Search and URL analysis tools.

Your capabilities:
- Use google_search to find real-time information from the web
- Use url_context to fetch and analyze content from specific URLs when provided

Guidelines:
- Always provide accurate, well-sourced information
- Cite your sources when presenting facts
- If analyzing URLs, extract the most relevant information
- Be concise but comprehensive in your responses
- If information is uncertain or conflicting, acknowledge it
- Focus on answering the user's question directly`;

// ../core/dist/fetch-timeout.js
var ACTIVE_FETCH_TIMEOUT_MS = 15e3;
async function fetchWithActiveTimeout(input2, init = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? ACTIVE_FETCH_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const activeController = new AbortController();
  const onTimeoutAbort = () => activeController.abort(timeoutSignal.reason);
  if (timeoutSignal.aborted) {
    onTimeoutAbort();
  } else {
    timeoutSignal.addEventListener("abort", onTimeoutAbort, { once: true });
  }
  const composedSignal = init.signal ? AbortSignal.any([activeController.signal, init.signal]) : activeController.signal;
  try {
    return await fetchImpl(input2, { ...init, signal: composedSignal });
  } finally {
    timeoutSignal.removeEventListener("abort", onTimeoutAbort);
  }
}

// ../core/dist/antigravity/oauth.js
var log2 = createLogger("oauth");
function generatePkcePair() {
  const verifier = randomBytes2(32).toString("base64url");
  return {
    verifier,
    challenge: createHash2("sha256").update(verifier).digest("base64url")
  };
}
function encodeState(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
function decodeState(state) {
  const normalized = state.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, "=");
  const json = Buffer.from(padded, "base64").toString("utf8");
  const parsed = JSON.parse(json);
  if (typeof parsed.verifier !== "string") {
    throw new Error("Missing PKCE verifier in state");
  }
  return {
    verifier: parsed.verifier,
    projectId: typeof parsed.projectId === "string" ? parsed.projectId : ""
  };
}
async function authorizeAntigravity(projectId = "") {
  const pkce = generatePkcePair();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", encodeState({ verifier: pkce.verifier, projectId: projectId || "" }));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return {
    url: url.toString(),
    verifier: pkce.verifier,
    projectId: projectId || ""
  };
}
async function fetchProjectID(accessToken) {
  const errors = [];
  const loadHeaders = buildAntigravityHarnessBootstrapHeaders(accessToken);
  const loadEndpoints = Array.from(/* @__PURE__ */ new Set([
    ...ANTIGRAVITY_LOAD_ENDPOINTS,
    ...ANTIGRAVITY_ENDPOINT_FALLBACKS
  ]));
  for (const baseEndpoint of loadEndpoints) {
    try {
      const url = `${baseEndpoint}/v1internal:loadCodeAssist`;
      const response = await fetchWithAgyCliTransport(url, {
        method: "POST",
        headers: loadHeaders,
        body: JSON.stringify({
          metadata: buildAntigravityLoadCodeAssistMetadata()
        })
      }, { timeoutMs: 1e4 });
      if (!response.ok) {
        const message = await response.text().catch(() => "");
        errors.push(`loadCodeAssist ${response.status} at ${baseEndpoint}${message ? `: ${message}` : ""}`);
        continue;
      }
      const data = await response.json();
      if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) {
        return data.cloudaicompanionProject;
      }
      if (data.cloudaicompanionProject && typeof data.cloudaicompanionProject.id === "string" && data.cloudaicompanionProject.id) {
        return data.cloudaicompanionProject.id;
      }
      errors.push(`loadCodeAssist missing project id at ${baseEndpoint}`);
    } catch (e) {
      errors.push(`loadCodeAssist error at ${baseEndpoint}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (errors.length) {
    log2.warn("Failed to resolve Antigravity project via loadCodeAssist", {
      errors: errors.join("; ")
    });
  }
  return "";
}
async function exchangeAntigravity(code, state) {
  try {
    const { verifier, projectId } = decodeState(state);
    const startTime = Date.now();
    const tokenResponse = await fetchWithActiveTimeout("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent": GEMINI_CLI_HEADERS["User-Agent"]
      },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: ANTIGRAVITY_REDIRECT_URI,
        code_verifier: verifier
      })
    });
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return { type: "failed", error: errorText };
    }
    const tokenPayload = await tokenResponse.json();
    const userInfoResponse = await fetchWithActiveTimeout("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`,
        "User-Agent": GEMINI_CLI_HEADERS["User-Agent"]
      }
    });
    const userInfo = userInfoResponse.ok ? await userInfoResponse.json() : {};
    const refreshToken = tokenPayload.refresh_token;
    if (!refreshToken) {
      return { type: "failed", error: "Missing refresh token in response" };
    }
    let effectiveProjectId = projectId;
    if (!effectiveProjectId) {
      effectiveProjectId = await fetchProjectID(tokenPayload.access_token);
    }
    const storedRefresh = `${refreshToken}|${effectiveProjectId || ""}`;
    return {
      type: "success",
      refresh: storedRefresh,
      access: tokenPayload.access_token,
      expires: calculateTokenExpiry(startTime, tokenPayload.expires_in),
      email: userInfo.email,
      label: userInfo.name?.trim() || void 0,
      projectId: effectiveProjectId || ""
    };
  } catch (error) {
    return {
      type: "failed",
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
}

// ../core/dist/project.js
var log3 = createLogger("project");
var PROJECT_CONTEXT_CACHE_TTL_MS = 30 * 60 * 1e3;
var projectContextResultCache = /* @__PURE__ */ new Map();
var projectContextPendingCache = /* @__PURE__ */ new Map();
var provisionFailedKeys = /* @__PURE__ */ new Set();
function buildBootstrapRequestBody(extra = {}) {
  return {
    ...extra,
    metadata: buildAntigravityLoadCodeAssistMetadata()
  };
}
function getDefaultTierId(allowedTiers) {
  if (!allowedTiers || allowedTiers.length === 0) {
    return void 0;
  }
  for (const tier of allowedTiers) {
    if (tier?.isDefault) {
      return tier.id;
    }
  }
  return allowedTiers[0]?.id;
}
function wait(ms) {
  return new Promise((resolve3) => {
    setTimeout(resolve3, ms);
  });
}
function extractManagedProjectId(payload) {
  if (!payload) {
    return void 0;
  }
  if (typeof payload.cloudaicompanionProject === "string") {
    return payload.cloudaicompanionProject;
  }
  if (payload.cloudaicompanionProject && typeof payload.cloudaicompanionProject.id === "string") {
    return payload.cloudaicompanionProject.id;
  }
  return void 0;
}
function getCacheKeyFromRefresh(refresh) {
  const packedRefresh = refresh?.trim();
  if (!packedRefresh)
    return void 0;
  return parseRefreshParts(packedRefresh).refreshToken.trim() || packedRefresh;
}
function getCacheKey(auth) {
  return getCacheKeyFromRefresh(auth.refresh);
}
function invalidateProjectContextCache(refresh) {
  if (!refresh) {
    projectContextPendingCache.clear();
    projectContextResultCache.clear();
    provisionFailedKeys.clear();
    return;
  }
  const cacheKey = getCacheKeyFromRefresh(refresh);
  if (!cacheKey)
    return;
  projectContextPendingCache.delete(cacheKey);
  projectContextResultCache.delete(cacheKey);
  provisionFailedKeys.delete(cacheKey);
}
function clearProvisionFailedKeys() {
  provisionFailedKeys.clear();
}
async function loadManagedProject(accessToken, _projectId) {
  const requestBody = buildBootstrapRequestBody();
  const loadHeaders = buildAntigravityHarnessBootstrapHeaders(accessToken);
  const loadEndpoints = Array.from(/* @__PURE__ */ new Set([
    ...ANTIGRAVITY_LOAD_ENDPOINTS,
    ...ANTIGRAVITY_ENDPOINT_FALLBACKS
  ]));
  for (const baseEndpoint of loadEndpoints) {
    try {
      const response = await fetchWithAgyCliTransport(`${baseEndpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: loadHeaders,
        body: JSON.stringify(requestBody)
      });
      if (!response.ok) {
        continue;
      }
      return await response.json();
    } catch (error) {
      log3.debug("Failed to load managed project", {
        endpoint: baseEndpoint,
        error: String(error)
      });
    }
  }
  return null;
}
async function onboardManagedProject(accessToken, tierId, projectId, attempts = 10, delayMs = 5e3) {
  const requestBody = { tierId };
  const onboardEndpoints = Array.from(/* @__PURE__ */ new Set([
    ANTIGRAVITY_ENDPOINT_PROD,
    ...ANTIGRAVITY_LOAD_ENDPOINTS,
    ...ANTIGRAVITY_ENDPOINT_FALLBACKS
  ]));
  for (const baseEndpoint of onboardEndpoints) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetchWithAgyCliTransport(`${baseEndpoint}/v1internal:onboardUser`, {
          method: "POST",
          headers: buildAntigravityHarnessBootstrapHeaders(accessToken),
          body: JSON.stringify(requestBody)
        });
        if (!response.ok) {
          log3.debug("Onboard request failed", {
            endpoint: baseEndpoint,
            status: response.status,
            statusText: response.statusText
          });
          break;
        }
        const payload = await response.json();
        const managedProjectId = payload.response?.cloudaicompanionProject?.id;
        if (payload.done && managedProjectId) {
          return managedProjectId;
        }
        if (payload.done && projectId) {
          return projectId;
        }
      } catch (error) {
        log3.debug("Failed to onboard managed project", {
          endpoint: baseEndpoint,
          error: String(error)
        });
        break;
      }
      await wait(delayMs);
    }
  }
  return void 0;
}
async function ensureProjectContext(auth) {
  const accessToken = auth.access;
  if (!accessToken) {
    return { auth, effectiveProjectId: "" };
  }
  const cacheKey = getCacheKey(auth);
  if (cacheKey) {
    const cached = projectContextResultCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < PROJECT_CONTEXT_CACHE_TTL_MS) {
      return cached.result;
    }
    if (cached) {
      projectContextResultCache.delete(cacheKey);
    }
    const pending = projectContextPendingCache.get(cacheKey);
    if (pending) {
      return pending;
    }
  }
  const resolveContext = async () => {
    const parts = parseRefreshParts(auth.refresh);
    if (parts.managedProjectId) {
      return { auth, effectiveProjectId: parts.managedProjectId };
    }
    const fallbackProjectId = ANTIGRAVITY_DEFAULT_PROJECT_ID;
    if (cacheKey && provisionFailedKeys.has(cacheKey)) {
      const effectiveProjectId = parts.projectId || fallbackProjectId;
      return { auth, effectiveProjectId };
    }
    const persistManagedProject = async (managedProjectId, capturedTier) => {
      const updatedAuth = {
        ...auth,
        refresh: formatRefreshParts({
          refreshToken: parts.refreshToken,
          projectId: parts.projectId,
          managedProjectId
        })
      };
      return {
        auth: updatedAuth,
        effectiveProjectId: managedProjectId,
        capturedTier
      };
    };
    const loadPayload = await loadManagedProject(accessToken, parts.projectId ?? fallbackProjectId);
    const capturedTierId = loadPayload?.currentTier?.id;
    const paidTierId = typeof loadPayload?.paidTier === "string" ? loadPayload.paidTier : loadPayload?.paidTier?.id;
    const tierFromPayload = capturedTierId ? {
      id: capturedTierId,
      ...paidTierId ? { paidId: paidTierId } : {},
      capturedAt: Date.now()
    } : void 0;
    const resolvedManagedProjectId = extractManagedProjectId(loadPayload);
    if (resolvedManagedProjectId) {
      return persistManagedProject(resolvedManagedProjectId, tierFromPayload);
    }
    const tierId = getDefaultTierId(loadPayload?.allowedTiers) ?? "free-tier";
    log3.debug("Auto-provisioning managed project", {
      tierId,
      projectId: parts.projectId
    });
    const provisionedProjectId = await onboardManagedProject(accessToken, tierId, parts.projectId);
    if (provisionedProjectId) {
      log3.debug("Successfully provisioned managed project", {
        provisionedProjectId
      });
      return persistManagedProject(provisionedProjectId, tierFromPayload);
    }
    log3.warn("Failed to provision managed project - account may not work correctly", {
      hasProjectId: !!parts.projectId
    });
    if (cacheKey) {
      provisionFailedKeys.add(cacheKey);
    }
    if (parts.projectId) {
      return {
        auth,
        effectiveProjectId: parts.projectId,
        capturedTier: tierFromPayload
      };
    }
    return {
      auth,
      effectiveProjectId: fallbackProjectId,
      capturedTier: tierFromPayload
    };
  };
  if (!cacheKey) {
    return resolveContext();
  }
  const promise = resolveContext().then((result) => {
    const nextKey = getCacheKey(result.auth) ?? cacheKey;
    projectContextPendingCache.delete(cacheKey);
    projectContextResultCache.set(nextKey, { result, cachedAt: Date.now() });
    if (nextKey !== cacheKey) {
      projectContextResultCache.delete(cacheKey);
    }
    return result;
  }).catch((error) => {
    projectContextPendingCache.delete(cacheKey);
    throw error;
  });
  projectContextPendingCache.set(cacheKey, promise);
  return promise;
}

// ../core/dist/quota-manager.js
import { createHash as createHash3 } from "node:crypto";
var log4 = createLogger("quota-manager");
var QUOTA_MANAGER_DEFAULT_BASE_BACKOFF_MS = 3e4;
var QUOTA_MANAGER_DEFAULT_MAX_BACKOFF_MS = 10 * 60 * 1e3;
var QUOTA_MANAGER_DEFAULT_TIMEOUT_MS = 1e4;
function defaultKeyOf(account) {
  if (account.email)
    return `e:${account.email.toLowerCase()}`;
  const token = account.refreshToken || "";
  return `t:${createHash3("sha256").update(token).digest("hex").slice(0, 16)}`;
}
function createQuotaManager(options) {
  const now = options.now ?? (() => Date.now());
  const baseBackoffMs = options.baseBackoffMs ?? QUOTA_MANAGER_DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? QUOTA_MANAGER_DEFAULT_MAX_BACKOFF_MS;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? QUOTA_MANAGER_DEFAULT_TIMEOUT_MS;
  const state = /* @__PURE__ */ new Map();
  let disposed = false;
  const keyOf = (account) => options.keyOf(account);
  const recordSuccess = (key) => {
    const entry = state.get(key);
    if (!entry)
      return;
    entry.consecutiveFailures = 0;
    entry.backoffUntil = 0;
  };
  const recordFailure = (key) => {
    const current = now();
    const entry = state.get(key) ?? {
      consecutiveFailures: 0,
      backoffUntil: 0
    };
    const failures = entry.consecutiveFailures + 1;
    const backoffMs = Math.min(maxBackoffMs, baseBackoffMs * 2 ** (failures - 1));
    entry.consecutiveFailures = failures;
    entry.backoffUntil = current + backoffMs;
    state.set(key, entry);
    return { backoffMs, backoffUntil: entry.backoffUntil };
  };
  const cacheResult = (key, result) => {
    const entry = state.get(key) ?? {
      consecutiveFailures: 0,
      backoffUntil: 0
    };
    entry.cached = result;
    state.set(key, entry);
  };
  const buildDisabledResult = (account, index) => ({
    index,
    email: account.email,
    status: "disabled",
    disabled: true,
    quota: void 0,
    geminiCliQuota: void 0,
    updatedAccount: void 0
  });
  const buildSkippedResult = (account, index, backoffUntil) => {
    const cached = state.get(keyOf(account))?.cached;
    if (cached) {
      return { ...cached, index };
    }
    return {
      index,
      email: account.email,
      status: "error",
      error: `quota refresh skipped (backoff until ${new Date(backoffUntil).toISOString()})`
    };
  };
  const refreshAccount = async (account, refreshOptions) => {
    if (disposed) {
      return {
        index: refreshOptions.index,
        email: account.email,
        status: "error",
        error: "quota manager disposed"
      };
    }
    const { index, force = false } = refreshOptions;
    const key = keyOf(account);
    if (account.enabled === false) {
      const result = buildDisabledResult(account, index);
      cacheResult(key, result);
      return result;
    }
    const current = now();
    const entry = state.get(key);
    if (!force && entry && entry.backoffUntil > current) {
      return buildSkippedResult(account, index, entry.backoffUntil);
    }
    const inflight = entry?.inflight;
    if (inflight) {
      const cached = await inflight;
      return { ...cached, index };
    }
    const controller = new AbortController();
    const stored = state.get(key) ?? {
      consecutiveFailures: 0,
      backoffUntil: 0
    };
    stored.controller = controller;
    state.set(key, stored);
    const promise = (async () => {
      try {
        const signal = AbortSignal.timeout(fetchTimeoutMs);
        const composite = controller.signal.aborted ? controller.signal : AbortSignal.any([controller.signal, signal]);
        const result = await options.fetchAccountQuota(account, composite);
        if (controller.signal.aborted) {
          throw new Error("quota manager disposed mid-fetch");
        }
        const attributed = { ...result, index };
        cacheResult(key, attributed);
        if (result.status === "error") {
          const { backoffMs } = recordFailure(key);
          log4.debug("quota-refresh-failed", {
            key: hashKey(key),
            backoffMs,
            error: result.error ?? "attributed error result"
          });
          return attributed;
        }
        recordSuccess(key);
        return attributed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (disposed || controller.signal.aborted) {
          const failureResult2 = {
            index,
            email: account.email,
            status: "error",
            error: message
          };
          cacheResult(key, failureResult2);
          return failureResult2;
        }
        const { backoffMs } = recordFailure(key);
        log4.debug("quota-refresh-failed", {
          key: hashKey(key),
          backoffMs,
          error: message
        });
        const failureResult = {
          index,
          email: account.email,
          status: "error",
          error: message
        };
        cacheResult(key, failureResult);
        return failureResult;
      } finally {
        const finished = state.get(key);
        if (finished) {
          finished.inflight = void 0;
          finished.controller = void 0;
          state.set(key, finished);
        }
      }
    })();
    stored.inflight = promise;
    state.set(key, stored);
    return promise;
  };
  const refreshAccounts = async (accounts, refreshOptions) => {
    const results = [];
    for (const account of accounts) {
      const index = refreshOptions.indexFor(account);
      const result = await refreshAccount(account, {
        index,
        force: refreshOptions.force
      });
      results.push(result);
    }
    return results;
  };
  const getCached = (account) => {
    const entry = state.get(keyOf(account));
    return entry?.cached;
  };
  const getBackoffUntil = (account) => {
    return state.get(keyOf(account))?.backoffUntil ?? 0;
  };
  const hashedLogLabel = (prefix, account) => {
    const identity = typeof account === "string" ? account : keyOf(account);
    return `${prefix} ${hashKey(identity)}`;
  };
  const dispose = async () => {
    if (disposed)
      return;
    disposed = true;
    const pending = Array.from(state.values(), (entry) => entry.inflight).filter((promise) => promise != null);
    for (const [, entry] of state) {
      entry.controller?.abort();
    }
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
    for (const [, entry] of state) {
      entry.inflight = void 0;
    }
  };
  return {
    refreshAccount,
    refreshAccounts,
    getCached,
    getBackoffUntil,
    hashedLogLabel,
    dispose,
    classifyQuotaGroup,
    aggregateQuota,
    aggregateGeminiCliQuota
  };
}
function hashKey(key) {
  return createHash3("sha256").update(key).digest("hex").slice(0, 8);
}
function classifyQuotaGroup(modelName, displayName) {
  const registryGroup = getQuotaGroupForModel(modelName);
  if (registryGroup) {
    return registryGroup;
  }
  const combined = `${modelName} ${displayName ?? ""}`.toLowerCase();
  if (combined.includes("claude") || combined.includes("gpt-oss")) {
    return "non-gemini";
  }
  if (combined.includes("gemini")) {
    return "gemini";
  }
  return null;
}
function normalizeRemainingFraction(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  if (value < 0)
    return 0;
  if (value > 1)
    return 1;
  return value;
}
function parseResetTime(resetTime) {
  if (!resetTime)
    return null;
  const timestamp = Date.parse(resetTime);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return timestamp;
}
function aggregateQuota(models) {
  const groups = {};
  const perModel = [];
  if (!models) {
    return { groups, perModel, modelCount: 0 };
  }
  let totalCount = 0;
  for (const [modelName, entry] of Object.entries(models)) {
    const group = classifyQuotaGroup(modelName, entry.displayName ?? entry.modelName);
    const quotaInfo = entry.quotaInfo;
    const remainingFraction = quotaInfo ? normalizeRemainingFraction(quotaInfo.remainingFraction) : void 0;
    const resetTime = quotaInfo?.resetTime;
    const resetTimestamp = parseResetTime(resetTime);
    totalCount += 1;
    perModel.push({
      modelId: modelName,
      displayName: entry.displayName ?? entry.modelName,
      group,
      remainingFraction: remainingFraction ?? 0,
      resetTime
    });
    if (!group) {
      continue;
    }
    const existing = groups[group];
    const nextCount = (existing?.modelCount ?? 0) + 1;
    const nextRemaining = remainingFraction === void 0 ? existing?.remainingFraction : existing?.remainingFraction === void 0 ? remainingFraction : Math.min(existing.remainingFraction, remainingFraction);
    let nextResetTime = existing?.resetTime;
    if (resetTimestamp !== null) {
      if (!existing?.resetTime) {
        nextResetTime = resetTime;
      } else {
        const existingTimestamp = parseResetTime(existing.resetTime);
        if (existingTimestamp === null || resetTimestamp < existingTimestamp) {
          nextResetTime = resetTime;
        }
      }
    }
    groups[group] = {
      remainingFraction: nextRemaining,
      resetTime: nextResetTime,
      modelCount: nextCount
    };
  }
  perModel.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return { groups, perModel, modelCount: totalCount };
}
function mostConstrainedWindow(windows) {
  if (windows.length === 0)
    return void 0;
  let best = windows[0];
  for (let i = 1; i < windows.length; i++) {
    if (windows[i].remainingFraction < best.remainingFraction) {
      best = windows[i];
    }
  }
  return {
    remainingFraction: best.remainingFraction,
    resetTime: best.resetTime
  };
}
function poolForBucketId(bucketId) {
  if (bucketId.startsWith("gemini-"))
    return "gemini";
  if (bucketId.startsWith("3p-"))
    return "non-gemini";
  return null;
}
function parseDescriptionModelCount(description) {
  const prefixMatch = description.match(/^[^:]+:\s*/);
  const payload = prefixMatch ? description.slice(prefixMatch[0].length) : description;
  if (!payload)
    return 0;
  const entries = payload.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return entries.length;
}
function windowDurationMs(window) {
  switch (window) {
    case "5h":
      return 5 * 60 * 60 * 1e3;
    case "weekly":
      return 7 * 24 * 60 * 60 * 1e3;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}
function aggregateQuotaSummary(response) {
  const groups = {};
  let totalCount = 0;
  for (const group of response.groups) {
    const windows = [];
    for (const bucket of group.buckets) {
      const pool2 = poolForBucketId(bucket.bucketId);
      if (!pool2)
        continue;
      windows.push({
        window: bucket.window,
        remainingFraction: normalizeRemainingFraction(bucket.remainingFraction),
        resetTime: bucket.resetTime
      });
    }
    if (windows.length === 0)
      continue;
    windows.sort((a, b) => windowDurationMs(a.window) - windowDurationMs(b.window));
    const constrained = mostConstrainedWindow(windows);
    const recognizedBucket = group.buckets.find((bucket) => poolForBucketId(bucket.bucketId));
    if (!recognizedBucket)
      continue;
    const pool = poolForBucketId(recognizedBucket.bucketId);
    if (!pool || !constrained)
      continue;
    const modelCount = group.description ? parseDescriptionModelCount(group.description) : 0;
    groups[pool] = {
      remainingFraction: constrained.remainingFraction,
      resetTime: constrained.resetTime,
      modelCount,
      windows
    };
    totalCount += modelCount;
  }
  return { groups, modelCount: totalCount };
}
async function fetchQuotaSummary(options) {
  const timeoutMs = options.timeoutMs ?? QUOTA_MANAGER_DEFAULT_TIMEOUT_MS;
  const userAgent = options.userAgent ?? buildAntigravityHarnessUserAgent();
  const transport = options.fetchVia ?? defaultTransport;
  const errors = [];
  if (options.endpoints.length === 0) {
    throw new Error("No endpoints configured for fetchQuotaSummary");
  }
  const tryBody = async (endpoint, projectId) => {
    const body = { project: projectId };
    try {
      const response = await transport(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
        method: "POST",
        headers: {
          "User-Agent": userAgent,
          Authorization: `Bearer ${options.accessToken}`,
          "Content-Type": "application/json",
          "Accept-Encoding": "gzip"
        },
        body: JSON.stringify(body)
      }, { timeoutMs });
      if (response.ok) {
        return {
          ok: true,
          summary: await response.json()
        };
      }
      const status = response.status;
      if (status === 403) {
        errors.push(`retrieveUserQuotaSummary 403 at ${endpoint} (project=${projectId.slice(0, 12)}\u2026)`);
        return { ok: false, reason: "403" };
      }
      if (status === 429 || status >= 500) {
        const message2 = await response.text().catch(() => "");
        errors.push(`retrieveUserQuotaSummary ${status} at ${endpoint}${message2 ? `: ${message2.trim().slice(0, 200)}` : ""}`);
        return { ok: false, reason: "transient" };
      }
      const message = await response.text().catch(() => "");
      errors.push(`retrieveUserQuotaSummary ${status} at ${endpoint}${message ? `: ${message.trim().slice(0, 200)}` : ""}`);
      return { ok: false, reason: "transient" };
    } catch (error) {
      errors.push(`retrieveUserQuotaSummary network error at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, reason: "transient" };
    }
  };
  const primary = options.managedProjectId ?? options.projectId;
  let primaryGot403 = false;
  if (primary) {
    for (const endpoint of options.endpoints) {
      const result = await tryBody(endpoint, primary);
      if (result.ok)
        return { summary: result.summary };
      if (result.reason === "403")
        primaryGot403 = true;
    }
  }
  const fallbackId = primaryGot403 && options.managedProjectId && options.projectId && options.managedProjectId !== options.projectId ? options.projectId : void 0;
  if (fallbackId) {
    for (const endpoint of options.endpoints) {
      const result = await tryBody(endpoint, fallbackId);
      if (result.ok)
        return { summary: result.summary };
    }
  }
  throw new Error(errors.join("; ") || "fetchQuotaSummary failed: no project ID available");
}
function aggregateGeminiCliQuota(response) {
  const models = [];
  if (!response.buckets || response.buckets.length === 0) {
    return { models };
  }
  for (const bucket of response.buckets) {
    if (!bucket.modelId) {
      continue;
    }
    const modelId = bucket.modelId;
    const isRelevantModel = modelId.startsWith("gemini-3-") || modelId.startsWith("gemini-3.") || modelId.startsWith("gemini-2.5-");
    if (!isRelevantModel) {
      continue;
    }
    models.push({
      modelId: bucket.modelId,
      remainingFraction: normalizeRemainingFraction(bucket.remainingFraction),
      resetTime: bucket.resetTime
    });
  }
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return { models };
}
async function fetchAvailableModels(options) {
  const timeoutMs = options.timeoutMs ?? QUOTA_MANAGER_DEFAULT_TIMEOUT_MS;
  const userAgent = options.userAgent ?? buildAntigravityHarnessUserAgent();
  const errors = [];
  const transport = options.fetchVia ?? defaultTransport;
  for (const endpoint of options.endpoints) {
    const body = options.projectId ? { project: options.projectId } : {};
    try {
      const response = await transport(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: {
          "User-Agent": userAgent,
          Authorization: `Bearer ${options.accessToken}`,
          "Content-Type": "application/json",
          "Accept-Encoding": "gzip"
        },
        body: JSON.stringify(body)
      }, { timeoutMs });
      if (response.ok) {
        return await response.json();
      }
      const status = response.status;
      if (status === 403 && options.projectId) {
        try {
          const retryResponse = await transport(`${endpoint}/v1internal:fetchAvailableModels`, {
            method: "POST",
            headers: {
              "User-Agent": userAgent,
              Authorization: `Bearer ${options.accessToken}`,
              "Content-Type": "application/json",
              "Accept-Encoding": "gzip"
            },
            body: JSON.stringify({})
          }, { timeoutMs });
          if (retryResponse.ok) {
            return await retryResponse.json();
          }
        } catch {
        }
      }
      if (status === 429 || status >= 500) {
        const message2 = await response.text().catch(() => "");
        const snippet2 = message2.trim().slice(0, 200);
        errors.push(`fetchAvailableModels ${status} at ${endpoint}${snippet2 ? `: ${snippet2}` : ""}`);
        continue;
      }
      const message = await response.text().catch(() => "");
      const snippet = message.trim().slice(0, 200);
      errors.push(`fetchAvailableModels ${status} at ${endpoint}${snippet ? `: ${snippet}` : ""}`);
      break;
    } catch (error) {
      errors.push(`fetchAvailableModels network error at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.join("; ") || "fetchAvailableModels failed");
}
async function fetchGeminiCliQuota(options) {
  const timeoutMs = options.timeoutMs ?? QUOTA_MANAGER_DEFAULT_TIMEOUT_MS;
  const userAgent = options.userAgent ?? buildAntigravityHarnessUserAgent();
  const transport = options.fetchVia ?? defaultTransport;
  const errors = [];
  for (const endpoint of options.endpoints) {
    const body = options.projectId ? { project: options.projectId } : {};
    try {
      const response = await transport(`${endpoint}/v1internal:retrieveUserQuota`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": userAgent
        },
        body: JSON.stringify(body)
      }, { timeoutMs });
      if (response.ok) {
        return await response.json();
      }
      const status = response.status;
      if (status === 429 || status >= 500) {
        errors.push(`fetchGeminiCliQuota ${status} at ${endpoint}`);
        continue;
      }
      return { buckets: [] };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("; ") || "fetchGeminiCliQuota failed");
  }
  return { buckets: [] };
}
async function defaultTransport(url, init, options) {
  return fetchWithActiveTimeout(url, init, { timeoutMs: options.timeoutMs });
}

// ../core/dist/transform/claude.js
var CLAUDE_THINKING_MAX_OUTPUT_TOKENS = 64e3;
function computeClaudeMaxOutputTokens(thinkingBudget) {
  if (typeof thinkingBudget !== "number" || thinkingBudget <= 0) {
    return CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
  }
  return Math.min(Math.max(thinkingBudget * 2, 32e3), CLAUDE_THINKING_MAX_OUTPUT_TOKENS);
}
var CLAUDE_INTERLEAVED_THINKING_HINT = "Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.";
function isClaudeModel(model) {
  return model.toLowerCase().includes("claude");
}
function isClaudeThinkingModel(model) {
  const lower = model.toLowerCase();
  return lower.includes("claude") && lower.includes("thinking");
}
function appendClaudeThinkingHint(payload, hint = CLAUDE_INTERLEAVED_THINKING_HINT) {
  const existing = payload.systemInstruction;
  if (typeof existing === "string" && existing.includes(hint)) {
    return;
  }
  if (existing && typeof existing === "object") {
    const sys = existing;
    if (Array.isArray(sys.parts)) {
      const alreadyHasHint = sys.parts.some((p) => p && typeof p === "object" && p.text === hint);
      if (alreadyHasHint)
        return;
    }
  }
  if (typeof existing === "string") {
    payload.systemInstruction = existing.trim().length > 0 ? { role: "user", parts: [{ text: existing }, { text: hint }] } : hint;
  } else if (existing && typeof existing === "object") {
    const sys = existing;
    const partsValue = sys.parts;
    if (Array.isArray(partsValue)) {
      sys.parts = [...partsValue, { text: hint }];
    } else {
      sys.parts = [{ text: hint }];
    }
    payload.systemInstruction = sys;
  } else if (Array.isArray(payload.contents)) {
    payload.systemInstruction = { parts: [{ text: hint }] };
  }
}

// ../core/dist/transform/gemini.js
var UNSUPPORTED_SCHEMA_FIELDS = /* @__PURE__ */ new Set([
  "additionalProperties",
  "$schema",
  "$id",
  "$comment",
  "$ref",
  "$defs",
  "definitions",
  "const",
  "contentMediaType",
  "contentEncoding",
  "if",
  "then",
  "else",
  "not",
  "patternProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentRequired",
  "dependentSchemas",
  "propertyNames",
  "minContains",
  "maxContains"
]);
var NUMERIC_SCHEMA_CONSTRAINTS = /* @__PURE__ */ new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf"
]);
function toGeminiSchema(schema, options = {}) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }
  const inputSchema = schema;
  const result = {};
  const numericConstraintHints = [];
  const propertyNames = /* @__PURE__ */ new Set();
  if (inputSchema.properties && typeof inputSchema.properties === "object") {
    for (const propName of Object.keys(inputSchema.properties)) {
      propertyNames.add(propName);
    }
  }
  for (const [key, value] of Object.entries(inputSchema)) {
    if (UNSUPPORTED_SCHEMA_FIELDS.has(key)) {
      continue;
    }
    if (key === "type" && typeof value === "string") {
      result[key] = value.toUpperCase();
    } else if (key === "properties" && typeof value === "object" && value !== null) {
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = toGeminiSchema(propSchema, options);
      }
      result[key] = props;
    } else if (key === "items" && typeof value === "object") {
      result[key] = toGeminiSchema(value, options);
    } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      result[key] = value.map((item) => toGeminiSchema(item, options));
    } else if (key === "enum" && Array.isArray(value)) {
      result[key] = value;
    } else if (options.moveNumericConstraintsToDescription && NUMERIC_SCHEMA_CONSTRAINTS.has(key)) {
      if (typeof value === "string" || typeof value === "number") {
        numericConstraintHints.push(`${key}: ${value}`);
      }
    } else if (key === "default" || key === "examples") {
      result[key] = value;
    } else if (key === "required" && Array.isArray(value)) {
      if (propertyNames.size > 0) {
        const validRequired = value.filter((prop) => typeof prop === "string" && propertyNames.has(prop));
        if (validRequired.length > 0) {
          result[key] = validRequired;
        }
      } else {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  if (numericConstraintHints.length > 0) {
    const hint = numericConstraintHints.join(", ");
    result.description = typeof result.description === "string" && result.description ? `${result.description} (${hint})` : hint;
  }
  if (result.type === "ARRAY" && !result.items) {
    result.items = { type: "STRING" };
  }
  return result;
}
function isGeminiModel(model) {
  const lower = model.toLowerCase();
  return lower.includes("gemini") && !lower.includes("claude");
}
function isGemini3Model(model) {
  return model.toLowerCase().includes("gemini-3");
}
function isImageGenerationModel(model) {
  const lower = model.toLowerCase();
  return lower.includes("image") || lower.includes("imagen");
}
function buildGemini3ThinkingConfig(includeThoughts, thinkingLevel) {
  return {
    includeThoughts,
    thinkingLevel
  };
}
function buildGemini25ThinkingConfig(includeThoughts, thinkingBudget) {
  return {
    includeThoughts,
    ...typeof thinkingBudget === "number" && thinkingBudget > 0 ? { thinkingBudget } : {}
  };
}
var VALID_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9"
];
function buildImageGenerationConfig() {
  const aspectRatio = process.env.OPENCODE_IMAGE_ASPECT_RATIO || "1:1";
  if (VALID_ASPECT_RATIOS.includes(aspectRatio)) {
    return { aspectRatio };
  }
  console.warn(`[gemini] Invalid aspect ratio "${aspectRatio}". Using default "1:1". Valid values: ${VALID_ASPECT_RATIOS.join(", ")}`);
  return { aspectRatio: "1:1" };
}
function normalizeGeminiTools(payload, schemaOptions = {}) {
  let toolDebugMissing = 0;
  const toolDebugSummaries = [];
  if (!Array.isArray(payload.tools)) {
    return { toolDebugMissing, toolDebugSummaries };
  }
  payload.tools = payload.tools.map((tool2, toolIndex) => {
    const t = tool2;
    if (t.googleSearch || t.googleSearchRetrieval) {
      return t;
    }
    if (Array.isArray(t.functionDeclarations)) {
      return {
        ...t,
        functionDeclarations: t.functionDeclarations.map((declaration) => {
          const normalized = { ...declaration };
          const rawSchema = normalized.parameters ?? normalized.parametersJsonSchema ?? {
            type: "OBJECT",
            properties: {}
          };
          normalized.parameters = toGeminiSchema(rawSchema, schemaOptions);
          delete normalized.parametersJsonSchema;
          return normalized;
        })
      };
    }
    const newTool = { ...t };
    const schemaCandidates = [
      newTool.function?.input_schema,
      newTool.function?.parameters,
      newTool.function?.inputSchema,
      newTool.custom?.input_schema,
      newTool.custom?.parameters,
      newTool.parameters,
      newTool.input_schema,
      newTool.inputSchema
    ].filter(Boolean);
    const placeholderSchema = {
      type: "OBJECT",
      properties: {
        _placeholder: {
          type: "BOOLEAN",
          description: "Placeholder. Always pass true."
        }
      },
      required: ["_placeholder"]
    };
    let schema = schemaCandidates[0];
    const schemaObjectOk = schema && typeof schema === "object" && !Array.isArray(schema);
    if (!schemaObjectOk) {
      schema = placeholderSchema;
      toolDebugMissing += 1;
    } else {
      schema = toGeminiSchema(schema, schemaOptions);
    }
    const nameCandidate = newTool.name || newTool.function?.name || newTool.custom?.name || `tool-${toolIndex}`;
    if (newTool.function && schema) {
      ;
      newTool.function.input_schema = schema;
    }
    if (newTool.custom && schema) {
      ;
      newTool.custom.input_schema = schema;
    }
    if (!newTool.custom && newTool.function) {
      const fn = newTool.function;
      newTool.custom = {
        name: fn.name || nameCandidate,
        description: fn.description,
        input_schema: schema
      };
    }
    if (!newTool.custom && !newTool.function) {
      newTool.custom = {
        name: nameCandidate,
        description: newTool.description,
        input_schema: schema
      };
      if (!newTool.parameters && !newTool.input_schema && !newTool.inputSchema) {
        newTool.parameters = schema;
      }
    }
    if (newTool.custom && !newTool.custom.input_schema) {
      ;
      newTool.custom.input_schema = {
        type: "OBJECT",
        properties: {}
      };
      toolDebugMissing += 1;
    }
    toolDebugSummaries.push(`idx=${toolIndex}, hasCustom=${!!newTool.custom}, customSchema=${!!newTool.custom?.input_schema}, hasFunction=${!!newTool.function}, functionSchema=${!!newTool.function?.input_schema}`);
    if (newTool.custom) {
      delete newTool.custom;
    }
    return newTool;
  });
  return { toolDebugMissing, toolDebugSummaries };
}
function applyGeminiTransforms(payload, options) {
  const { model, tierThinkingBudget, tierThinkingLevel, normalizedThinking, googleSearch } = options;
  if (normalizedThinking) {
    let thinkingConfig;
    if (tierThinkingLevel && isGemini3Model(model)) {
      thinkingConfig = buildGemini3ThinkingConfig(normalizedThinking.includeThoughts ?? true, tierThinkingLevel);
    } else {
      const thinkingBudget = tierThinkingBudget ?? normalizedThinking.thinkingBudget;
      thinkingConfig = buildGemini25ThinkingConfig(normalizedThinking.includeThoughts ?? true, thinkingBudget);
    }
    const generationConfig = payload.generationConfig ?? {};
    generationConfig.thinkingConfig = thinkingConfig;
    payload.generationConfig = generationConfig;
  }
  if (googleSearch && googleSearch.mode === "auto") {
    const tools = payload.tools || [];
    if (!payload.tools) {
      payload.tools = tools;
    }
    ;
    payload.tools.push({
      googleSearch: {}
    });
  }
  const result = normalizeGeminiTools(payload, {
    moveNumericConstraintsToDescription: model.toLowerCase().startsWith("gpt-oss-")
  });
  const wrapResult = wrapToolsAsFunctionDeclarations(payload);
  return {
    ...result,
    wrappedFunctionCount: wrapResult.wrappedFunctionCount,
    passthroughToolCount: wrapResult.passthroughToolCount
  };
}
function isWebSearchTool(tool2) {
  if (tool2.googleSearch || tool2.googleSearchRetrieval) {
    return true;
  }
  if (tool2.type === "web_search_20250305") {
    return true;
  }
  const name = tool2.name;
  if (name === "web_search" || name === "google_search") {
    return true;
  }
  return false;
}
function wrapToolsAsFunctionDeclarations(payload) {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
    return { wrappedFunctionCount: 0, passthroughToolCount: 0 };
  }
  const functionDeclarations = [];
  const passthroughTools = [];
  let hasWebSearchTool = false;
  for (const tool2 of payload.tools) {
    if (tool2.googleSearch || tool2.googleSearchRetrieval || tool2.codeExecution) {
      passthroughTools.push(tool2);
      continue;
    }
    if (isWebSearchTool(tool2)) {
      hasWebSearchTool = true;
      continue;
    }
    if (tool2.functionDeclarations) {
      if (Array.isArray(tool2.functionDeclarations)) {
        for (const decl of tool2.functionDeclarations) {
          functionDeclarations.push({
            name: String(decl.name || `tool-${functionDeclarations.length}`),
            description: String(decl.description || ""),
            parameters: decl.parameters || {
              type: "OBJECT",
              properties: {}
            }
          });
        }
      }
      continue;
    }
    const fn = tool2.function;
    const custom = tool2.custom;
    const name = String(tool2.name || fn?.name || custom?.name || `tool-${functionDeclarations.length}`);
    const description = String(tool2.description || fn?.description || custom?.description || "");
    const schema = fn?.input_schema || fn?.parameters || fn?.inputSchema || custom?.input_schema || custom?.parameters || tool2.parameters || tool2.input_schema || tool2.inputSchema || { type: "OBJECT", properties: {} };
    functionDeclarations.push({
      name,
      description,
      parameters: schema
    });
  }
  const finalTools = [];
  if (functionDeclarations.length > 0) {
    finalTools.push({ functionDeclarations });
  }
  finalTools.push(...passthroughTools);
  if (hasWebSearchTool && functionDeclarations.length === 0) {
    finalTools.push({ googleSearch: {} });
  } else if (hasWebSearchTool && functionDeclarations.length > 0) {
    console.warn("[gemini] web_search tool detected but cannot be combined with function declarations. Use the explicit google_search() tool call instead.");
  }
  payload.tools = finalTools;
  return {
    wrappedFunctionCount: functionDeclarations.length,
    passthroughToolCount: passthroughTools.length + (hasWebSearchTool && functionDeclarations.length === 0 ? 1 : 0)
  };
}

// ../core/dist/transform/cross-model-sanitizer.js
var GEMINI_SIGNATURE_FIELDS = [
  "thoughtSignature",
  "thinkingMetadata"
];
var CLAUDE_SIGNATURE_FIELDS = ["signature"];
function getModelFamily(model) {
  if (isClaudeModel(model))
    return "claude";
  if (isGeminiModel(model))
    return "gemini";
  return "unknown";
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stripGeminiThinkingMetadata(part, preserveNonSignature = true) {
  let stripped = 0;
  if ("thoughtSignature" in part) {
    delete part.thoughtSignature;
    stripped++;
  }
  if ("thinkingMetadata" in part) {
    delete part.thinkingMetadata;
    stripped++;
  }
  if (isPlainObject(part.metadata)) {
    const metadata = part.metadata;
    if (isPlainObject(metadata.google)) {
      const google = metadata.google;
      for (const field of GEMINI_SIGNATURE_FIELDS) {
        if (field in google) {
          delete google[field];
          stripped++;
        }
      }
      if (!preserveNonSignature || Object.keys(google).length === 0) {
        delete metadata.google;
      }
      if (Object.keys(metadata).length === 0) {
        delete part.metadata;
      }
    }
  }
  return { part, stripped };
}
function stripClaudeThinkingFields(part) {
  let stripped = 0;
  if (part.type === "thinking" || part.type === "redacted_thinking") {
    for (const field of CLAUDE_SIGNATURE_FIELDS) {
      if (field in part) {
        delete part[field];
        stripped++;
      }
    }
  }
  if ("signature" in part && typeof part.signature === "string") {
    if (part.signature.length >= 50) {
      delete part.signature;
      stripped++;
    }
  }
  return { part, stripped };
}
function sanitizeCrossModelPayloadInPlace(payload, options) {
  const targetFamily = getModelFamily(options.targetModel);
  if (targetFamily === "unknown") {
    return 0;
  }
  const preserveNonSignature = options.preserveNonSignatureMetadata ?? true;
  let totalStripped = 0;
  const sanitizePartsInPlace = (parts) => {
    for (const part of parts) {
      if (!isPlainObject(part))
        continue;
      if (targetFamily === "claude") {
        const result = stripGeminiThinkingMetadata(part, preserveNonSignature);
        totalStripped += result.stripped;
      } else if (targetFamily === "gemini") {
        const result = stripClaudeThinkingFields(part);
        totalStripped += result.stripped;
      }
    }
  };
  if (Array.isArray(payload.contents)) {
    for (const content of payload.contents) {
      if (isPlainObject(content) && Array.isArray(content.parts)) {
        sanitizePartsInPlace(content.parts);
      }
    }
  }
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (isPlainObject(message) && Array.isArray(message.content)) {
        sanitizePartsInPlace(message.content);
      }
    }
  }
  if (isPlainObject(payload.extra_body)) {
    const extraBody = payload.extra_body;
    if (Array.isArray(extraBody.messages)) {
      for (const message of extraBody.messages) {
        if (isPlainObject(message) && Array.isArray(message.content)) {
          sanitizePartsInPlace(message.content);
        }
      }
    }
  }
  return totalStripped;
}

// ../core/dist/transform/model-resolver.js
var THINKING_TIER_BUDGETS = {
  claude: { low: 8192, medium: 16384, high: 32768 },
  "gemini-2.5-pro": { low: 8192, medium: 16384, high: 32768 },
  "gemini-2.5-flash": { low: 6144, medium: 12288, high: 24576 },
  default: { low: 4096, medium: 8192, high: 16384 }
};
var MODEL_ALIASES = getResolverAliasMap();
var TIER_REGEX = /-(minimal|low|medium|high)$/;
var QUOTA_PREFIX_REGEX = /^antigravity-/i;
var GEMINI_3_PRO_REGEX = /^gemini-3(?:\.\d+)?-pro/i;
var GEMINI_3_FLASH_REGEX = /^gemini-3(?:\.\d+)?-flash/i;
var IMAGE_GENERATION_MODELS = /image|imagen/i;
function supportsThinkingTiers(model) {
  const lower = model.toLowerCase();
  return lower.includes("gemini-3") || lower.includes("gemini-2.5") || lower.includes("claude") && lower.includes("thinking");
}
function extractThinkingTierFromModel(model) {
  if (!supportsThinkingTiers(model)) {
    return void 0;
  }
  const tierMatch = model.match(TIER_REGEX);
  return tierMatch?.[1];
}
function getBudgetFamily(model) {
  if (model.includes("claude")) {
    return "claude";
  }
  if (model.includes("gemini-2.5-pro")) {
    return "gemini-2.5-pro";
  }
  if (model.includes("gemini-2.5-flash")) {
    return "gemini-2.5-flash";
  }
  return "default";
}
function isThinkingCapableModel(model) {
  const lower = model.toLowerCase();
  return lower.includes("thinking") || lower.includes("gemini-3") || lower.includes("gemini-2.5");
}
function isGemini3ProModel(model) {
  return GEMINI_3_PRO_REGEX.test(model);
}
function isGemini3FlashModel(model) {
  return GEMINI_3_FLASH_REGEX.test(model);
}
function isGemini35FlashModel(model) {
  return /^gemini-3\.5-flash/i.test(model);
}
function resolveGemini35FlashAntigravityModel(tier) {
  return getGemini35FlashAntigravityModel(tier);
}
function getAgyGeminiFlashThinkingBudget(tier, highBudget = 1e4) {
  switch (tier) {
    case "low":
      return 1e3;
    case "high":
      return highBudget;
    default:
      return 4e3;
  }
}
function getAgyGemini31ProModel(tier) {
  return tier === "high" ? "gemini-pro-agent" : "gemini-3.1-pro-low";
}
function getAgyGemini31ProThinkingBudget(tier) {
  return tier === "high" ? 10001 : 1001;
}
function resolveModelWithTier(requestedModel, options = {}) {
  const isAntigravity = QUOTA_PREFIX_REGEX.test(requestedModel);
  const modelWithoutQuota = requestedModel.replace(QUOTA_PREFIX_REGEX, "");
  const tier = extractThinkingTierFromModel(modelWithoutQuota);
  const baseName = tier ? modelWithoutQuota.replace(TIER_REGEX, "") : modelWithoutQuota;
  const isImageModel = IMAGE_GENERATION_MODELS.test(modelWithoutQuota);
  const isClaudeModel2 = modelWithoutQuota.toLowerCase().includes("claude");
  const preferGeminiCli = options.cli_first === true && !isAntigravity && !isImageModel && !isClaudeModel2;
  const quotaPreference = preferGeminiCli ? "gemini-cli" : "antigravity";
  const explicitQuota = isAntigravity || isImageModel;
  const isGemini3 = modelWithoutQuota.toLowerCase().startsWith("gemini-3");
  const skipAlias = isAntigravity && isGemini3;
  const isGemini3Pro = isGemini3ProModel(modelWithoutQuota);
  const isGemini3Flash = isGemini3FlashModel(modelWithoutQuota);
  const isGemini31Pro = /^gemini-3\.1-pro/i.test(baseName);
  const isGemini35Flash = /^gemini-3\.5-flash/i.test(baseName);
  const isGemini36Flash = /^gemini-3\.6-flash/i.test(baseName);
  const isGemini37Flash = /^gemini-3\.7-flash/i.test(baseName);
  const isGemini38Flash = /^gemini-3\.8-flash/i.test(baseName);
  const isGptOss120b = /^gpt-oss-120b(?:-medium)?$/i.test(baseName);
  if (isGemini31Pro && quotaPreference === "antigravity") {
    return {
      actualModel: getAgyGemini31ProModel(tier),
      thinkingBudget: getAgyGemini31ProThinkingBudget(tier),
      tier,
      isThinkingModel: true,
      quotaPreference,
      explicitQuota
    };
  }
  if (isGemini35Flash && quotaPreference === "antigravity") {
    return {
      actualModel: resolveGemini35FlashAntigravityModel(tier ?? "medium"),
      thinkingBudget: getAgyGeminiFlashThinkingBudget(tier),
      tier: tier ?? "medium",
      isThinkingModel: true,
      quotaPreference,
      explicitQuota
    };
  }
  if (isGemini36Flash && quotaPreference === "antigravity") {
    return {
      actualModel: getGemini36FlashAntigravityModel(tier ?? "medium"),
      thinkingBudget: getAgyGeminiFlashThinkingBudget(tier),
      tier: tier ?? "medium",
      isThinkingModel: true,
      quotaPreference,
      explicitQuota
    };
  }
  if (isGemini37Flash && quotaPreference === "antigravity") {
    return {
      actualModel: getGemini37FlashAntigravityModel(tier ?? "medium"),
      thinkingBudget: getAgyGeminiFlashThinkingBudget(tier, -1),
      tier: tier ?? "medium",
      isThinkingModel: true,
      quotaPreference,
      explicitQuota
    };
  }
  if (isGemini38Flash && quotaPreference === "antigravity") {
    return {
      actualModel: getGemini38FlashAntigravityModel(tier ?? "medium"),
      thinkingBudget: getAgyGeminiFlashThinkingBudget(tier, -1),
      tier: tier ?? "medium",
      isThinkingModel: true,
      quotaPreference,
      explicitQuota
    };
  }
  if (isGptOss120b && quotaPreference === "antigravity") {
    return {
      actualModel: "gpt-oss-120b-medium",
      thinkingBudget: 8192,
      isThinkingModel: true,
      quotaPreference,
      explicitQuota
    };
  }
  let antigravityModel = modelWithoutQuota;
  if (skipAlias) {
    if ((isGemini3Pro || isGemini3Flash) && !tier && !isImageModel) {
      const defaultTier = isGemini3Pro ? "low" : "medium";
      antigravityModel = `${modelWithoutQuota}-${defaultTier}`;
    }
  }
  const actualModel = skipAlias ? antigravityModel : MODEL_ALIASES[modelWithoutQuota] || MODEL_ALIASES[baseName] || baseName;
  const resolvedModel = actualModel;
  const isThinking = isThinkingCapableModel(resolvedModel);
  if (isImageModel) {
    return {
      actualModel: resolvedModel,
      isThinkingModel: false,
      isImageModel: true,
      quotaPreference,
      explicitQuota
    };
  }
  const isEffectiveGemini3 = resolvedModel.toLowerCase().includes("gemini-3");
  const lowerModelWithoutQuota = modelWithoutQuota.toLowerCase();
  const isClaudeThinking = resolvedModel.toLowerCase().includes("claude") && resolvedModel.toLowerCase().includes("thinking") || lowerModelWithoutQuota.includes("claude") && lowerModelWithoutQuota.includes("thinking") || lowerModelWithoutQuota === "gemini-claude-sonnet-4-6";
  if (!tier) {
    if (isEffectiveGemini3) {
      return {
        actualModel: resolvedModel,
        thinkingLevel: isGemini35Flash ? "medium" : "low",
        isThinkingModel: true,
        quotaPreference,
        explicitQuota
      };
    }
    if (isClaudeThinking) {
      return {
        actualModel: resolvedModel,
        thinkingBudget: 1024,
        isThinkingModel: true,
        quotaPreference,
        explicitQuota
      };
    }
    return {
      actualModel: resolvedModel,
      isThinkingModel: isThinking,
      quotaPreference,
      explicitQuota
    };
  }
  if (isEffectiveGemini3) {
    return {
      actualModel: resolvedModel,
      thinkingLevel: tier,
      tier,
      isThinkingModel: true,
      quotaPreference,
      explicitQuota
    };
  }
  if (isClaudeThinking) {
    return {
      actualModel: resolvedModel,
      thinkingBudget: 1024,
      tier,
      isThinkingModel: true,
      quotaPreference,
      explicitQuota
    };
  }
  const budgetFamily = getBudgetFamily(resolvedModel);
  const budgets = THINKING_TIER_BUDGETS[budgetFamily];
  const thinkingBudget = budgets[tier];
  return {
    actualModel: resolvedModel,
    thinkingBudget,
    tier,
    isThinkingModel: isThinking,
    quotaPreference,
    explicitQuota
  };
}
function resolveModelForHeaderStyle(requestedModel, headerStyle) {
  const lower = requestedModel.toLowerCase();
  const isGemini3 = lower.includes("gemini-3");
  if (!isGemini3) {
    return resolveModelWithTier(requestedModel);
  }
  if (headerStyle === "antigravity") {
    let transformedModel = requestedModel.replace(/-preview-customtools$/i, "").replace(/-preview$/i, "").replace(/^antigravity-/i, "");
    const isGemini3Pro = isGemini3ProModel(transformedModel);
    const isGemini3Flash = isGemini3FlashModel(transformedModel);
    const hasTierSuffix = /-(minimal|low|medium|high)$/i.test(transformedModel);
    const isImageModel = IMAGE_GENERATION_MODELS.test(transformedModel);
    const isGemini35Flash = isGemini35FlashModel(transformedModel.replace(TIER_REGEX, ""));
    if ((isGemini3Pro || isGemini3Flash) && !isGemini35Flash && !hasTierSuffix && !isImageModel) {
      const defaultTier = isGemini3Pro ? "low" : "medium";
      transformedModel = `${transformedModel}-${defaultTier}`;
    }
    const prefixedModel = `antigravity-${transformedModel}`;
    return resolveModelWithTier(prefixedModel);
  }
  if (headerStyle === "gemini-cli") {
    const requestedTier = extractThinkingTierFromModel(requestedModel.replace(/^antigravity-/i, ""));
    let transformedModel = requestedModel.replace(/^antigravity-/i, "").replace(/-(minimal|low|medium|high)$/i, "");
    const hasPreviewSuffix = /-preview($|-)/i.test(transformedModel);
    const isGemini35Flash = isGemini35FlashModel(transformedModel);
    if (isGemini35Flash) {
      transformedModel = getGemini35FlashGeminiCliFallbackModel();
    } else if (!hasPreviewSuffix) {
      transformedModel = `${transformedModel}-preview`;
    }
    const resolved = resolveModelWithTier(transformedModel, { cli_first: true });
    return {
      ...resolved,
      thinkingLevel: requestedTier ?? resolved.thinkingLevel,
      tier: requestedTier ?? resolved.tier,
      quotaPreference: "gemini-cli"
    };
  }
  return resolveModelWithTier(requestedModel);
}

// ../core/dist/version.js
var VERSION_URL = "https://antigravity-auto-updater-974169037036.us-central1.run.app";
var CHANGELOG_URL = "https://antigravity.google/changelog";
var FETCH_TIMEOUT_MS = 5e3;
var CHANGELOG_SCAN_CHARS = 5e3;
var VERSION_REGEX = /\d+\.\d+\.\d+/;
var lastResolution = null;
function parseVersion(text) {
  const match = text.match(VERSION_REGEX);
  return match ? match[0] : null;
}
async function tryFetchVersion(url, maxChars) {
  try {
    const response = await fetchWithActiveTimeout(url, void 0, {
      timeoutMs: FETCH_TIMEOUT_MS
    });
    if (!response.ok)
      return null;
    let text = await response.text();
    if (maxChars)
      text = text.slice(0, maxChars);
    return parseVersion(text);
  } catch {
    return null;
  }
}
function getAntigravityVersionResolution() {
  return lastResolution ?? { version: getAntigravityVersion(), source: "fallback" };
}
async function initAntigravityVersion() {
  const log18 = createLogger("version");
  const fallback = getAntigravityVersion();
  let version;
  let source;
  version = await tryFetchVersion(VERSION_URL);
  if (version) {
    source = "api";
  } else {
    version = await tryFetchVersion(CHANGELOG_URL, CHANGELOG_SCAN_CHARS);
    if (version) {
      source = "changelog";
    } else {
      source = "fallback";
      setAntigravityVersion(fallback);
      log18.info("version-fetch-failed", { fallback });
      lastResolution = { version: fallback, source };
      return lastResolution;
    }
  }
  if (version !== fallback) {
    log18.info("version-updated", { version, source, previous: fallback });
  } else {
    log18.debug("version-unchanged", { version, source });
  }
  setAntigravityVersion(version);
  lastResolution = { version, source };
  return lastResolution;
}

// src/hooks/auto-update-checker/cache.ts
import * as fs from "node:fs";
import * as path2 from "node:path";

// src/hooks/auto-update-checker/constants.ts
import * as os from "node:os";
import * as path from "node:path";
var PACKAGE_NAME = "@cortexkit/opencode-antigravity-auth";
var NPM_REGISTRY_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`;
var NPM_FETCH_TIMEOUT = 5e3;
function getCacheDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "opencode");
  }
  return path.join(os.homedir(), ".cache", "opencode");
}
var CACHE_DIR = getCacheDir();
var INSTALLED_PACKAGE_JSON = path.join(
  CACHE_DIR,
  "node_modules",
  PACKAGE_NAME,
  "package.json"
);
function getUserConfigDir() {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}
var USER_CONFIG_DIR = getUserConfigDir();
var USER_OPENCODE_CONFIG = path.join(
  USER_CONFIG_DIR,
  "opencode",
  "opencode.json"
);
var USER_OPENCODE_CONFIG_JSONC = path.join(
  USER_CONFIG_DIR,
  "opencode",
  "opencode.jsonc"
);

// src/hooks/auto-update-checker/cache.ts
function stripTrailingCommas(json) {
  return json.replace(/,(\s*[}\]])/g, "$1");
}
function removeFromBunLock(packageName) {
  const lockPath = path2.join(CACHE_DIR, "bun.lock");
  if (!fs.existsSync(lockPath)) return false;
  try {
    const content = fs.readFileSync(lockPath, "utf-8");
    const lock = JSON.parse(stripTrailingCommas(content));
    let modified = false;
    if (lock.workspaces?.[""]?.dependencies?.[packageName]) {
      delete lock.workspaces[""].dependencies[packageName];
      modified = true;
    }
    if (lock.packages?.[packageName]) {
      delete lock.packages[packageName];
      modified = true;
    }
    if (modified) {
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
      console.log(`[auto-update-checker] Removed from bun.lock: ${packageName}`);
    }
    return modified;
  } catch {
    return false;
  }
}
function invalidatePackage(packageName = PACKAGE_NAME) {
  try {
    const pkgDir = path2.join(CACHE_DIR, "node_modules", packageName);
    const pkgJsonPath = path2.join(CACHE_DIR, "package.json");
    let packageRemoved = false;
    let dependencyRemoved = false;
    let lockRemoved = false;
    if (fs.existsSync(pkgDir)) {
      fs.rmSync(pkgDir, { recursive: true, force: true });
      console.log(`[auto-update-checker] Package removed: ${pkgDir}`);
      packageRemoved = true;
    }
    if (fs.existsSync(pkgJsonPath)) {
      const content = fs.readFileSync(pkgJsonPath, "utf-8");
      const pkgJson = JSON.parse(content);
      if (pkgJson.dependencies?.[packageName]) {
        delete pkgJson.dependencies[packageName];
        fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2));
        console.log(
          `[auto-update-checker] Dependency removed from package.json: ${packageName}`
        );
        dependencyRemoved = true;
      }
    }
    lockRemoved = removeFromBunLock(packageName);
    if (!packageRemoved && !dependencyRemoved && !lockRemoved) {
      console.log(
        `[auto-update-checker] Package not found, nothing to invalidate: ${packageName}`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error("[auto-update-checker] Failed to invalidate package:", err);
    return false;
  }
}

// src/hooks/auto-update-checker/checker.ts
import * as fs3 from "node:fs";
import * as path3 from "node:path";
import { fileURLToPath } from "node:url";

// src/plugin/debug.ts
import {
  createWriteStream,
  mkdirSync as mkdirSync2,
  readdirSync,
  statSync,
  unlinkSync as unlinkSync2
} from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join5 } from "node:path";
import { env } from "node:process";

// src/plugin/logging-utils.ts
function isTruthyFlag2(flag) {
  return flag === "1" || flag?.toLowerCase() === "true";
}
function parseDebugLevel(flag) {
  const trimmed = flag.trim();
  if (trimmed === "2" || trimmed === "verbose") return 2;
  if (trimmed === "1" || trimmed === "true") return 1;
  return 0;
}
function deriveDebugPolicy(input2) {
  const envDebugFlag = input2.envDebugFlag ?? "";
  const debugLevel = input2.configDebug ? envDebugFlag === "2" || envDebugFlag === "verbose" ? 2 : 1 : parseDebugLevel(envDebugFlag);
  const debugEnabled = debugLevel >= 1;
  const verboseEnabled = debugLevel >= 2;
  const debugTuiEnabled = debugEnabled && (input2.configDebugTui || isTruthyFlag2(input2.envDebugTuiFlag));
  return {
    debugLevel,
    debugEnabled,
    debugTuiEnabled,
    verboseEnabled
  };
}
function formatAccountLabel(email, accountIndex) {
  return email || `Account ${accountIndex + 1}`;
}
function formatAccountContextLabel(email, accountIndex) {
  if (email) {
    return email;
  }
  if (accountIndex >= 0) {
    return `Account ${accountIndex + 1}`;
  }
  return "All accounts";
}
function formatErrorForLog(error) {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
function truncateTextForLog(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}... (truncated ${text.length - maxChars} chars)`;
}
function formatBodyPreviewForLog(body, maxChars) {
  if (body == null) {
    return void 0;
  }
  if (typeof body === "string") {
    return truncateTextForLog(body, maxChars);
  }
  if (body instanceof URLSearchParams) {
    return truncateTextForLog(body.toString(), maxChars);
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return `[Blob size=${body.size}]`;
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return "[FormData payload omitted]";
  }
  return `[${body.constructor?.name ?? typeof body} payload omitted]`;
}
function writeConsoleLog2(level, ...args) {
  switch (level) {
    case "debug":
      console.debug(...args);
      break;
    case "info":
      console.info(...args);
      break;
    case "warn":
      console.warn(...args);
      break;
    case "error":
      console.error(...args);
      break;
  }
}
function redactSensitive(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}
var SENSITIVE_FIELD_PATTERN = /token|refresh|access|project|fingerprint|deviceId|sessionId|sessionToken|secret|password|apiKey|clientSecret/i;
function redactSensitiveFields(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(redactSensitiveFields);
  if (typeof value === "object") {
    const record = value;
    const redacted = {};
    for (const [key, entry] of Object.entries(record)) {
      if (SENSITIVE_FIELD_PATTERN.test(key) && typeof entry === "string") {
        redacted[key] = redactSensitive(entry);
      } else {
        redacted[key] = redactSensitiveFields(entry);
      }
    }
    return redacted;
  }
  return value;
}
function redactJsonBodyString(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (parsed == null || typeof parsed !== "object") return body;
  return JSON.stringify(redactSensitiveFields(parsed));
}
function redactBodyForLog(body) {
  if (typeof body === "string") return redactJsonBodyString(body);
  return body;
}

// src/plugin/storage.ts
import {
  appendFileSync,
  copyFileSync,
  existsSync as existsSync2,
  promises as fs2,
  mkdirSync,
  readFileSync as readFileSync2,
  renameSync,
  unlinkSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname3, join as join4 } from "node:path";

// src/plugin/logger.ts
var ENV_CONSOLE_LOG2 = "OPENCODE_ANTIGRAVITY_CONSOLE_LOG";
var LEVEL_PRIORITY = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
var LOG_LEVEL_FROM_OPERATOR = {
  error: "error",
  warn: "warn",
  info: "info",
  debug: "debug",
  trace: "debug"
};
var _client = null;
var _configuredLevel = "debug";
function shouldEmit(level) {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[_configuredLevel];
}
function setRuntimeLogLevel(level) {
  _configuredLevel = LOG_LEVEL_FROM_OPERATOR[level] ?? "debug";
}
function initLogger(client) {
  _client = client;
  setLogSink(({ service, level, message, extra }) => {
    emitLog(service, level, message, extra);
  });
}
function emitLog(service, level, message, extra) {
  if (!shouldEmit(level)) return;
  if (isDebugTuiEnabled()) {
    const app = _client?.app;
    if (app && typeof app.log === "function") {
      app.log({
        body: { service, level, message, extra }
      }).catch(() => {
      });
    }
  }
  if (isConsoleLogEnabled2()) {
    const prefix = `[${service}]`;
    const args = extra ? [prefix, message, extra] : [prefix, message];
    writeConsoleLog2(level, ...args);
  }
}
function isConsoleLogEnabled2() {
  return isTruthyFlag2(process.env[ENV_CONSOLE_LOG2]);
}
function createLogger2(module) {
  const service = `antigravity.${module}`;
  const log18 = (level, message, extra) => {
    emitLog(service, level, message, extra);
  };
  return {
    debug: (message, extra) => log18("debug", message, extra),
    info: (message, extra) => log18("info", message, extra),
    warn: (message, extra) => log18("warn", message, extra),
    error: (message, extra) => log18("error", message, extra)
  };
}

// src/plugin/storage.ts
var log5 = createLogger2("storage");
var mutateAccountStorage2 = mutateAccountStorage;
var GITIGNORE_ENTRIES = [
  "antigravity-accounts.json",
  "antigravity-accounts.json.*.tmp",
  "antigravity-signature-cache.json",
  "antigravity-logs/"
];
async function ensureGitignore(configDir) {
  const gitignorePath = join4(configDir, ".gitignore");
  try {
    let content;
    let existingLines = [];
    try {
      content = await fs2.readFile(gitignorePath, "utf-8");
      existingLines = content.split("\n").map((line) => line.trim());
    } catch (error) {
      if (error.code !== "ENOENT") {
        return;
      }
      content = "";
    }
    const missingEntries = GITIGNORE_ENTRIES.filter(
      (entry) => !existingLines.includes(entry)
    );
    if (missingEntries.length === 0) {
      return;
    }
    if (content === "") {
      await fs2.writeFile(
        gitignorePath,
        `${missingEntries.join("\n")}
`,
        "utf-8"
      );
      log5.info("Created .gitignore in config directory");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      await fs2.appendFile(
        gitignorePath,
        `${suffix + missingEntries.join("\n")}
`,
        "utf-8"
      );
      log5.info("Updated .gitignore with missing entries", {
        added: missingEntries
      });
    }
  } catch (error) {
    log5.warn("Failed to update .gitignore with account storage entries", {
      error: String(error)
    });
  }
}
function ensureGitignoreSync(configDir) {
  const gitignorePath = join4(configDir, ".gitignore");
  try {
    let content;
    let existingLines = [];
    if (existsSync2(gitignorePath)) {
      content = readFileSync2(gitignorePath, "utf-8");
      existingLines = content.split("\n").map((line) => line.trim());
    } else {
      content = "";
    }
    const missingEntries = GITIGNORE_ENTRIES.filter(
      (entry) => !existingLines.includes(entry)
    );
    if (missingEntries.length === 0) {
      return;
    }
    if (content === "") {
      writeFileSync2(gitignorePath, `${missingEntries.join("\n")}
`, "utf-8");
      log5.info("Created .gitignore in config directory");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      appendFileSync(
        gitignorePath,
        `${suffix + missingEntries.join("\n")}
`,
        "utf-8"
      );
      log5.info("Updated .gitignore with missing entries", {
        added: missingEntries
      });
    }
  } catch (error) {
    log5.warn("Failed to update .gitignore with account storage entries", {
      error: String(error)
    });
  }
}
function getLegacyWindowsConfigDir() {
  return join4(
    process.env.APPDATA || join4(homedir2(), "AppData", "Roaming"),
    "opencode"
  );
}
function getConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }
  const xdgConfig2 = process.env.XDG_CONFIG_HOME || join4(homedir2(), ".config");
  return join4(xdgConfig2, "opencode");
}
function migrateLegacyWindowsConfig() {
  if (process.platform !== "win32") {
    return false;
  }
  const newPath = join4(getConfigDir(), "antigravity-accounts.json");
  const legacyPath = join4(
    getLegacyWindowsConfigDir(),
    "antigravity-accounts.json"
  );
  if (!existsSync2(legacyPath) || existsSync2(newPath)) {
    return false;
  }
  try {
    const newConfigDir = getConfigDir();
    mkdirSync(newConfigDir, { recursive: true });
    try {
      renameSync(legacyPath, newPath);
      log5.info("Migrated Windows config via rename", {
        from: legacyPath,
        to: newPath
      });
    } catch {
      copyFileSync(legacyPath, newPath);
      unlinkSync(legacyPath);
      log5.info("Migrated Windows config via copy+delete", {
        from: legacyPath,
        to: newPath
      });
    }
    return true;
  } catch (error) {
    log5.warn("Failed to migrate legacy Windows config, will use legacy path", {
      legacyPath,
      newPath,
      error: String(error)
    });
    return false;
  }
}
function getStoragePathWithMigration() {
  const newPath = join4(getConfigDir(), "antigravity-accounts.json");
  if (process.platform === "win32") {
    migrateLegacyWindowsConfig();
    if (!existsSync2(newPath)) {
      const legacyPath = join4(
        getLegacyWindowsConfigDir(),
        "antigravity-accounts.json"
      );
      if (existsSync2(legacyPath)) {
        log5.info("Using legacy Windows config path (migration failed)", {
          legacyPath,
          newPath
        });
        return legacyPath;
      }
    }
  }
  return newPath;
}
function getStoragePath() {
  return getStoragePathWithMigration();
}
async function loadAccounts() {
  const path5 = getStoragePath();
  await ensureGitignore(dirname3(path5));
  return loadAccountStorage(path5);
}
async function saveAccounts(storage) {
  const path5 = getStoragePath();
  const configDir = dirname3(path5);
  await fs2.mkdir(configDir, { recursive: true });
  await ensureGitignore(configDir);
  await saveAccountStorage(path5, storage);
}
async function saveAccountsReplace(storage) {
  const path5 = getStoragePath();
  const configDir = dirname3(path5);
  await fs2.mkdir(configDir, { recursive: true });
  await ensureGitignore(configDir);
  await saveAccountStorageReplace(path5, storage);
}
async function clearAccounts() {
  const path5 = getStoragePath();
  try {
    await clearAccountStorage(path5);
  } catch (error) {
    const code = error.code;
    if (code !== "ENOENT") {
      log5.error("Failed to clear account storage", { error: String(error) });
    }
  }
}

// src/plugin/debug.ts
var MAX_BODY_PREVIEW_CHARS = 12e3;
var MAX_BODY_LOG_CHARS = 5e4;
var DEBUG_MESSAGE_PREFIX = "[opencode-antigravity-auth debug]";
var debugState = null;
function closeDebugStream() {
  const current = debugState?.logStream;
  if (!current) return;
  try {
    current.end();
  } catch {
  }
}
function closeDebugLog() {
  const current = debugState?.logStream;
  if (!current) return Promise.resolve();
  if (debugState) {
    debugState.logStream = null;
  }
  return new Promise((resolve3) => {
    current.once("close", () => resolve3());
    current.once("error", () => resolve3());
    try {
      current.end();
    } catch {
      resolve3();
    }
  });
}
function getConfigDir2() {
  const platform = process.platform;
  if (platform === "win32") {
    return join5(
      env.APPDATA || join5(homedir3(), "AppData", "Roaming"),
      "opencode"
    );
  }
  const xdgConfig2 = env.XDG_CONFIG_HOME || join5(homedir3(), ".config");
  return join5(xdgConfig2, "opencode");
}
function getLogsDir(customLogDir) {
  const logsDir = customLogDir || join5(getConfigDir2(), "antigravity-logs");
  try {
    mkdirSync2(logsDir, { recursive: true, mode: 448 });
  } catch {
  }
  return logsDir;
}
function createLogFilePath(customLogDir) {
  const logsDir = getLogsDir(customLogDir);
  cleanupOldLogs(logsDir, 25);
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  return join5(logsDir, `antigravity-debug-${timestamp}.log`);
}
function cleanupOldLogs(logsDir, maxFiles) {
  try {
    const files = readdirSync(logsDir).filter(
      (file) => file.startsWith("antigravity-debug-") && file.endsWith(".log")
    ).map((file) => join5(logsDir, file));
    if (files.length <= maxFiles) {
      return;
    }
    const sortedFiles = files.map((file) => ({
      file,
      mtime: statSync(file).mtimeMs
    })).sort((a, b) => b.mtime - a.mtime);
    for (let i = maxFiles; i < sortedFiles.length; i++) {
      try {
        unlinkSync2(sortedFiles[i].file);
      } catch {
      }
    }
  } catch {
  }
}
function createLogWriter(filePath) {
  if (!filePath) {
    return { writer: () => {
    }, stream: null };
  }
  try {
    const stream = createWriteStream(filePath, { flags: "a", mode: 384 });
    stream.on("error", () => {
    });
    return {
      stream,
      writer: (line) => {
        const timestamp = (/* @__PURE__ */ new Date()).toISOString();
        const formatted = `[${timestamp}] ${line}`;
        stream.write(`${formatted}
`);
      }
    };
  } catch {
    return { writer: () => {
    }, stream: null };
  }
}
function initializeDebug(config) {
  closeDebugStream();
  const envDebugFlag = env.OPENCODE_ANTIGRAVITY_DEBUG ?? "";
  const { debugEnabled } = deriveDebugPolicy({
    configDebug: config.debug,
    configDebugTui: config.debug_tui,
    envDebugFlag,
    envDebugTuiFlag: env.OPENCODE_ANTIGRAVITY_DEBUG_TUI
  });
  const debugTuiEnabled = config.debug_tui || isTruthyFlag2(env.OPENCODE_ANTIGRAVITY_DEBUG_TUI);
  const logFilePath = debugEnabled ? createLogFilePath(config.log_dir) : void 0;
  const { writer: logWriter, stream: logStream } = createLogWriter(logFilePath);
  if (debugEnabled) {
    ensureGitignoreSync(getConfigDir2());
  }
  debugState = {
    debugEnabled,
    debugTuiEnabled,
    logFilePath,
    logWriter,
    logStream
  };
}
function getDebugState() {
  if (!debugState) {
    const { debugEnabled } = deriveDebugPolicy({
      configDebug: false,
      configDebugTui: false,
      envDebugFlag: env.OPENCODE_ANTIGRAVITY_DEBUG,
      envDebugTuiFlag: env.OPENCODE_ANTIGRAVITY_DEBUG_TUI
    });
    const debugTuiEnabled = isTruthyFlag2(env.OPENCODE_ANTIGRAVITY_DEBUG_TUI);
    const logFilePath = debugEnabled ? createLogFilePath() : void 0;
    const { writer: logWriter, stream: logStream } = createLogWriter(logFilePath);
    debugState = {
      debugEnabled,
      debugTuiEnabled,
      logFilePath,
      logWriter,
      logStream
    };
  }
  return debugState;
}
function isDebugEnabled() {
  return getDebugState().debugEnabled;
}
function isDebugTuiEnabled() {
  return getDebugState().debugTuiEnabled;
}
function getLogFilePath() {
  return getDebugState().logFilePath;
}
var requestCounter = 0;
function startAntigravityDebugRequest(meta) {
  const state = getDebugState();
  if (!state.debugEnabled) {
    return null;
  }
  const id = `ANTIGRAVITY-${++requestCounter}`;
  const method = meta.method ?? "GET";
  logDebug(
    `[Antigravity Debug ${id}] pid=${process.pid} ${method} ${meta.resolvedUrl}`
  );
  if (meta.originalUrl && meta.originalUrl !== meta.resolvedUrl) {
    logDebug(`[Antigravity Debug ${id}] Original URL: ${meta.originalUrl}`);
  }
  if (meta.projectId) {
    logDebug(
      `[Antigravity Debug ${id}] Project: ${redactSensitive(meta.projectId)}`
    );
  }
  logDebug(
    `[Antigravity Debug ${id}] Streaming: ${meta.streaming ? "yes" : "no"}`
  );
  logDebug(
    `[Antigravity Debug ${id}] Headers: ${JSON.stringify(maskHeaders(meta.headers))}`
  );
  const bodyPreview = formatBodyPreviewForLog(
    redactBodyForLog(meta.body),
    MAX_BODY_PREVIEW_CHARS
  );
  if (bodyPreview) {
    logDebug(`[Antigravity Debug ${id}] Body Preview: ${bodyPreview}`);
  }
  return { id, streaming: meta.streaming, startedAt: Date.now() };
}
function logAntigravityDebugResponse(context, response, meta = {}) {
  const state = getDebugState();
  if (!state.debugEnabled || !context) {
    return;
  }
  const durationMs = Date.now() - context.startedAt;
  logDebug(
    `[Antigravity Debug ${context.id}] Response ${response.status} ${response.statusText} (${durationMs}ms)`
  );
  logDebug(
    `[Antigravity Debug ${context.id}] Response Headers: ${JSON.stringify(
      maskHeaders(meta.headersOverride ?? response.headers)
    )}`
  );
  if (meta.note) {
    logDebug(`[Antigravity Debug ${context.id}] Note: ${meta.note}`);
  }
  if (meta.error) {
    logDebug(
      `[Antigravity Debug ${context.id}] Error: ${formatErrorForLog(meta.error)}`
    );
  }
  if (meta.body) {
    logDebug(
      `[Antigravity Debug ${context.id}] Response Body Preview: ${truncateTextForLog(meta.body, MAX_BODY_PREVIEW_CHARS)}`
    );
  }
}
function maskHeaders(headers) {
  if (!headers) {
    return {};
  }
  const result = {};
  const SENSITIVE_HEADERS = /* @__PURE__ */ new Set([
    "authorization",
    "x-api-key",
    "x-goog-api-key",
    "cookie",
    "set-cookie"
  ]);
  const parsed = headers instanceof Headers ? headers : new Headers(headers);
  parsed.forEach((value, key) => {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      result[key] = "[redacted]";
    } else if (key.toLowerCase() === "user-agent") {
      result[key] = redactSensitive(value);
    } else {
      result[key] = value;
    }
  });
  return redactSensitiveFields(result);
}
function logDebug(line) {
  getDebugState().logWriter(line);
}
function runWithDebugEnabled(action) {
  if (!getDebugState().debugEnabled) return;
  action();
}
function logAccountContext(label, info) {
  runWithDebugEnabled(() => {
    const accountLabel = formatAccountContextLabel(info.email, info.index);
    const indexLabel = info.index >= 0 ? `${info.index + 1}/${info.totalAccounts}` : `-/${info.totalAccounts}`;
    let rateLimitInfo = "";
    if (info.rateLimitState && Object.keys(info.rateLimitState).length > 0) {
      const now = Date.now();
      const activeRateLimits = {};
      for (const [key, resetTime] of Object.entries(info.rateLimitState)) {
        if (typeof resetTime === "number" && resetTime > now) {
          const remainingSec = Math.ceil((resetTime - now) / 1e3);
          activeRateLimits[key] = `${remainingSec}s`;
        }
      }
      if (Object.keys(activeRateLimits).length > 0) {
        rateLimitInfo = ` rateLimits=${JSON.stringify(activeRateLimits)}`;
      }
    }
    logDebug(
      `[Account] ${label}: ${accountLabel} (${indexLabel}) family=${info.family}${rateLimitInfo}`
    );
  });
}
function logRateLimitEvent(accountIndex, email, family, status, retryAfterMs, bodyInfo) {
  runWithDebugEnabled(() => {
    const accountLabel = formatAccountLabel(email, accountIndex);
    logDebug(
      `[RateLimit] ${status} on ${accountLabel} family=${family} retryAfterMs=${retryAfterMs}`
    );
    if (bodyInfo.message) {
      logDebug(`[RateLimit] message: ${bodyInfo.message}`);
    }
    if (bodyInfo.quotaResetTime) {
      logDebug(`[RateLimit] quotaResetTime: ${bodyInfo.quotaResetTime}`);
    }
    if (bodyInfo.retryDelayMs !== void 0 && bodyInfo.retryDelayMs !== null) {
      logDebug(`[RateLimit] body retryDelayMs: ${bodyInfo.retryDelayMs}`);
    }
    if (bodyInfo.reason) {
      logDebug(`[RateLimit] reason: ${bodyInfo.reason}`);
    }
  });
}
function logRateLimitSnapshot(family, accounts) {
  runWithDebugEnabled(() => {
    const now = Date.now();
    const entries = accounts.map((account) => {
      const label = formatAccountLabel(account.email, account.index);
      const reset = account.rateLimitResetTimes?.[family];
      if (typeof reset !== "number") {
        return `${label}=ready`;
      }
      const remaining = Math.max(0, reset - now);
      const seconds = Math.ceil(remaining / 1e3);
      return `${label}=wait ${seconds}s`;
    });
    logDebug(`[RateLimit] snapshot family=${family} ${entries.join(" | ")}`);
  });
}
async function logResponseBody(context, response, status) {
  const state = getDebugState();
  if (!state.debugEnabled || !context) return void 0;
  try {
    const text = await response.clone().text();
    const preview = truncateTextForLog(text, MAX_BODY_LOG_CHARS);
    logDebug(
      `[Antigravity Debug ${context.id}] Response Body (${status}): ${preview}`
    );
    return text;
  } catch (e) {
    logDebug(
      `[Antigravity Debug ${context.id}] Failed to read response body: ${formatErrorForLog(e)}`
    );
    return void 0;
  }
}
function logModelFamily(url, extractedModel, family) {
  runWithDebugEnabled(() => {
    logDebug(
      `[ModelFamily] url=${url} model=${extractedModel ?? "unknown"} family=${family}`
    );
  });
}
function debugLogToFile(message) {
  runWithDebugEnabled(() => {
    logDebug(message);
  });
}
function logToast(message, variant) {
  runWithDebugEnabled(() => {
    const variantLabel = variant.toUpperCase();
    logDebug(`[Toast/${variantLabel}] ${message}`);
  });
}
function logCacheStats(model, cacheReadTokens, cacheWriteTokens, totalInputTokens) {
  runWithDebugEnabled(() => {
    const cacheHitRate = totalInputTokens > 0 ? Math.round(cacheReadTokens / totalInputTokens * 100) : 0;
    const status = cacheReadTokens > 0 ? "HIT" : cacheWriteTokens > 0 ? "WRITE" : "MISS";
    logDebug(
      `[Cache] ${status} model=${model} read=${cacheReadTokens} write=${cacheWriteTokens} total=${totalInputTokens} hitRate=${cacheHitRate}%`
    );
  });
}
function logQuotaStatus(accountEmail, accountIndex, quotaPercent, family) {
  runWithDebugEnabled(() => {
    const accountLabel = formatAccountLabel(accountEmail, accountIndex);
    const familyInfo = family ? ` family=${family}` : "";
    const status = quotaPercent <= 0 ? "EXHAUSTED" : quotaPercent < 20 ? "LOW" : "OK";
    logDebug(
      `[Quota] ${accountLabel} remaining=${quotaPercent.toFixed(1)}% status=${status}${familyInfo}`
    );
  });
}
function logQuotaFetch(event, accountCount, details) {
  runWithDebugEnabled(() => {
    const countInfo = accountCount !== void 0 ? ` accounts=${accountCount}` : "";
    const detailsInfo = details ? ` ${details}` : "";
    logDebug(`[QuotaFetch] ${event.toUpperCase()}${countInfo}${detailsInfo}`);
  });
}

// src/hooks/auto-update-checker/logging.ts
var AUTO_UPDATE_LOG_PREFIX = "[auto-update-checker]";
function formatAutoUpdateLogMessage(message) {
  return `${AUTO_UPDATE_LOG_PREFIX} ${message}`;
}
function logAutoUpdate(message) {
  debugLogToFile(formatAutoUpdateLogMessage(message));
}

// src/hooks/auto-update-checker/checker.ts
function stripJsonComments(json) {
  return json.replace(
    /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g,
    (m, g) => g ? "" : m
  ).replace(/,(\s*[}\]])/g, "$1");
}
function getConfigPaths(directory) {
  return [
    path3.join(directory, ".opencode", "opencode.json"),
    path3.join(directory, ".opencode", "opencode.jsonc"),
    path3.join(directory, ".opencode.json"),
    USER_OPENCODE_CONFIG,
    USER_OPENCODE_CONFIG_JSONC
  ];
}
function getLocalDevPath(directory) {
  for (const configPath of getConfigPaths(directory)) {
    try {
      if (!fs3.existsSync(configPath)) continue;
      const content = fs3.readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsonComments(content));
      const plugins = config.plugin ?? [];
      for (const entry of plugins) {
        if (entry.startsWith("file://") && entry.includes(PACKAGE_NAME)) {
          try {
            return fileURLToPath(entry);
          } catch {
            return entry.replace("file://", "");
          }
        }
      }
    } catch {
    }
  }
  return null;
}
function findPackageJsonUp(startPath) {
  try {
    const stat2 = fs3.statSync(startPath);
    let dir = stat2.isDirectory() ? startPath : path3.dirname(startPath);
    for (let i = 0; i < 10; i++) {
      const pkgPath = path3.join(dir, "package.json");
      if (fs3.existsSync(pkgPath)) {
        try {
          const content = fs3.readFileSync(pkgPath, "utf-8");
          const pkg = JSON.parse(content);
          if (pkg.name === PACKAGE_NAME) return pkgPath;
        } catch {
          continue;
        }
      }
      const parent = path3.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    return null;
  }
  return null;
}
function getLocalDevVersion(directory) {
  const localPath = getLocalDevPath(directory);
  if (!localPath) return null;
  try {
    const pkgPath = findPackageJsonUp(localPath);
    if (!pkgPath) return null;
    const content = fs3.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content);
    return pkg.version ?? null;
  } catch {
    return null;
  }
}
function findPluginEntry(directory) {
  for (const configPath of getConfigPaths(directory)) {
    try {
      if (!fs3.existsSync(configPath)) continue;
      const content = fs3.readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsonComments(content));
      const plugins = config.plugin ?? [];
      for (const entry of plugins) {
        if (entry === PACKAGE_NAME) {
          return { entry, isPinned: false, pinnedVersion: null, configPath };
        }
        if (entry.startsWith(`${PACKAGE_NAME}@`)) {
          const pinnedVersion = entry.slice(PACKAGE_NAME.length + 1);
          const isPinned = pinnedVersion !== "latest";
          return {
            entry,
            isPinned,
            pinnedVersion: isPinned ? pinnedVersion : null,
            configPath
          };
        }
        if (entry.startsWith("file://") && entry.includes(PACKAGE_NAME)) {
          return { entry, isPinned: false, pinnedVersion: null, configPath };
        }
      }
    } catch {
    }
  }
  return null;
}
function getCachedVersion() {
  try {
    if (fs3.existsSync(INSTALLED_PACKAGE_JSON)) {
      const content = fs3.readFileSync(INSTALLED_PACKAGE_JSON, "utf-8");
      const pkg = JSON.parse(content);
      if (pkg.version) return pkg.version;
    }
  } catch {
    return null;
  }
  try {
    const currentDir = path3.dirname(fileURLToPath(import.meta.url));
    const pkgPath = findPackageJsonUp(currentDir);
    if (pkgPath) {
      const content = fs3.readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(content);
      if (pkg.version) return pkg.version;
    }
  } catch (err) {
    logAutoUpdate(`Failed to resolve version from current directory: ${err}`);
  }
  return null;
}
function updatePinnedVersion(configPath, oldEntry, newVersion) {
  try {
    const content = fs3.readFileSync(configPath, "utf-8");
    const newEntry = `${PACKAGE_NAME}@${newVersion}`;
    const pluginMatch = content.match(/"plugin"\s*:\s*\[/);
    if (!pluginMatch || pluginMatch.index === void 0) {
      logAutoUpdate(`No "plugin" array found in ${configPath}`);
      return false;
    }
    const startIdx = pluginMatch.index + pluginMatch[0].length;
    let bracketCount = 1;
    let endIdx = startIdx;
    for (let i = startIdx; i < content.length && bracketCount > 0; i++) {
      if (content[i] === "[") bracketCount++;
      else if (content[i] === "]") bracketCount--;
      endIdx = i;
    }
    const before = content.slice(0, startIdx);
    const pluginArrayContent = content.slice(startIdx, endIdx);
    const after = content.slice(endIdx);
    const escapedOldEntry = oldEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`["']${escapedOldEntry}["']`);
    if (!regex.test(pluginArrayContent)) {
      logAutoUpdate(
        `Entry "${oldEntry}" not found in plugin array of ${configPath}`
      );
      return false;
    }
    const updatedPluginArray = pluginArrayContent.replace(
      regex,
      `"${newEntry}"`
    );
    const updatedContent = before + updatedPluginArray + after;
    if (updatedContent === content) {
      logAutoUpdate(`No changes made to ${configPath}`);
      return false;
    }
    fs3.writeFileSync(configPath, updatedContent, "utf-8");
    logAutoUpdate(`Updated ${configPath}: ${oldEntry} \u2192 ${newEntry}`);
    return true;
  } catch (err) {
    console.error(
      `[auto-update-checker] Failed to update config file ${configPath}:`,
      err
    );
    return false;
  }
}
async function getLatestVersion() {
  try {
    const response = await fetchWithActiveTimeout(
      NPM_REGISTRY_URL,
      { headers: { Accept: "application/json" } },
      { timeoutMs: NPM_FETCH_TIMEOUT }
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data.latest ?? null;
  } catch {
    return null;
  }
}

// src/hooks/auto-update-checker/index.ts
function createAutoUpdateCheckerHook(client, directory, options = {}) {
  const { showStartupToast = true, autoUpdate = true } = options;
  let hasChecked = false;
  return {
    event: ({ event }) => {
      if (event.type !== "session.created") return;
      if (hasChecked) return;
      const props = event.properties;
      if (props?.info?.parentID) return;
      hasChecked = true;
      setTimeout(() => {
        const localDevVersion = getLocalDevVersion(directory);
        if (localDevVersion) {
          if (showStartupToast) {
            showLocalDevToast(client, localDevVersion).catch(() => {
            });
          }
          logAutoUpdate("Local development mode");
          return;
        }
        runBackgroundUpdateCheck(client, directory, autoUpdate).catch((err) => {
          logAutoUpdate(`Background update check failed: ${err}`);
        });
      }, 0);
    }
  };
}
async function runBackgroundUpdateCheck(client, directory, autoUpdate) {
  const pluginInfo = findPluginEntry(directory);
  if (!pluginInfo) {
    logAutoUpdate("Plugin not found in config");
    return;
  }
  const cachedVersion = getCachedVersion();
  const currentVersion = cachedVersion ?? pluginInfo.pinnedVersion;
  if (!currentVersion) {
    logAutoUpdate("No version found (cached or pinned)");
    return;
  }
  if (currentVersion.includes("-")) {
    logAutoUpdate(
      `Prerelease version (${currentVersion}), skipping auto-update`
    );
    return;
  }
  const latestVersion = await getLatestVersion();
  if (!latestVersion) {
    logAutoUpdate("Failed to fetch latest version");
    return;
  }
  if (currentVersion === latestVersion) {
    logAutoUpdate("Already on latest version");
    return;
  }
  logAutoUpdate(`Update available: ${currentVersion} \u2192 ${latestVersion}`);
  if (!autoUpdate) {
    await showUpdateAvailableToast(client, latestVersion);
    logAutoUpdate("Auto-update disabled, notification only");
    return;
  }
  if (pluginInfo.isPinned) {
    const updated = updatePinnedVersion(
      pluginInfo.configPath,
      pluginInfo.entry,
      latestVersion
    );
    if (updated) {
      invalidatePackage(PACKAGE_NAME);
      await showAutoUpdatedToast(client, currentVersion, latestVersion);
      logAutoUpdate(
        `Config updated: ${pluginInfo.entry} \u2192 ${PACKAGE_NAME}@${latestVersion}`
      );
    } else {
      await showUpdateAvailableToast(client, latestVersion);
    }
  } else {
    invalidatePackage(PACKAGE_NAME);
    await showUpdateAvailableToast(client, latestVersion);
  }
}
async function showUpdateAvailableToast(client, latestVersion) {
  await client.tui.showToast({
    body: {
      title: `Antigravity Auth Update`,
      message: `v${latestVersion} available. Restart OpenCode to apply.`,
      variant: "info",
      duration: 8e3
    }
  }).catch(() => {
  });
  logAutoUpdate(`Update available toast shown: v${latestVersion}`);
}
async function showAutoUpdatedToast(client, oldVersion, newVersion) {
  await client.tui.showToast({
    body: {
      title: `Antigravity Auth Updated!`,
      message: `v${oldVersion} \u2192 v${newVersion}
Restart OpenCode to apply.`,
      variant: "success",
      duration: 8e3
    }
  }).catch(() => {
  });
  logAutoUpdate(`Auto-updated toast shown: v${oldVersion} \u2192 v${newVersion}`);
}
async function showLocalDevToast(client, version) {
  await client.tui.showToast({
    body: {
      title: `Antigravity Auth ${version} (dev)`,
      message: "Running in local development mode.",
      variant: "warning",
      duration: 5e3
    }
  }).catch(() => {
  });
  logAutoUpdate(`Local dev toast shown: v${version}`);
}

// src/rpc/notifications.ts
var QUEUE_CAP = 100;
var CONNECTION_TTL_MS = 3e3;
var queue = [];
var nextId = 1;
var lastDrainAtAny = 0;
var lastDrainAtBySession = /* @__PURE__ */ new Map();
function pushNotification(payload, sessionId) {
  queue.push({ id: nextId++, type: "open-dialog", payload, sessionId });
  if (queue.length > QUEUE_CAP) queue = queue.slice(queue.length - QUEUE_CAP);
}
function drainNotifications(lastReceivedId = 0, sessionId) {
  const now = Date.now();
  lastDrainAtAny = now;
  if (sessionId !== void 0) lastDrainAtBySession.set(sessionId, now);
  if (lastReceivedId > 0) {
    queue = queue.filter((notification) => {
      if (notification.id > lastReceivedId) return true;
      if (sessionId === void 0) return notification.sessionId !== void 0;
      return notification.sessionId !== sessionId;
    });
  }
  return queue.filter(
    (notification) => notification.id > lastReceivedId && (sessionId === void 0 ? notification.sessionId === void 0 : notification.sessionId === void 0 || notification.sessionId === sessionId)
  );
}
function isTuiConnected(sessionId) {
  const now = Date.now();
  if (sessionId !== void 0) {
    const lastDrainAt = lastDrainAtBySession.get(sessionId) ?? 0;
    return lastDrainAt > 0 && now - lastDrainAt < CONNECTION_TTL_MS;
  }
  return lastDrainAtAny > 0 && now - lastDrainAtAny < CONNECTION_TTL_MS;
}

// src/rpc/rpc-dir.ts
import { createHash as createHash4 } from "node:crypto";
import { homedir as homedir4, tmpdir } from "node:os";
import { isAbsolute, join as join7, resolve } from "node:path";
var RPC_DIR_ENV = "ANTIGRAVITY_AUTH_RPC_DIR";
function getRpcDir(projectDirectory) {
  const override = process.env[RPC_DIR_ENV]?.trim();
  if (override) {
    return isAbsolute(override) ? override : resolve(projectDirectory, override);
  }
  const projectHash = createHash4("sha256").update(resolve(projectDirectory)).digest("hex").slice(0, 16);
  const stateHome = process.env.XDG_STATE_HOME ?? join7(homedir4(), ".local", "state");
  return join7(stateHome, "cortexkit", "antigravity-auth", "rpc", projectHash);
}

// src/rpc/rpc-server.ts
import { randomBytes as randomBytes4, timingSafeEqual } from "node:crypto";
import { unlink as unlink4 } from "node:fs/promises";
import {
  createServer
} from "node:http";
import { join as join9 } from "node:path";

// src/rpc/port-file.ts
import { randomBytes as randomBytes3 } from "node:crypto";
import {
  chmod as chmod2,
  mkdir as mkdir4,
  readdir,
  readFile as readFile3,
  rename as rename3,
  unlink as unlink3,
  writeFile as writeFile3
} from "node:fs/promises";
import { join as join8 } from "node:path";
var DIR_MODE = 448;
var FILE_MODE = 384;
async function writePortFile(dir, entry) {
  assertPortFileEntry({ ...entry, startedAt: 0 }, entry.pid);
  await mkdir4(dir, { recursive: true, mode: DIR_MODE });
  await chmod2(dir, DIR_MODE);
  const full = { ...entry, startedAt: Date.now() };
  const target = join8(dir, `port-${entry.pid}.json`);
  const temporary = `${target}.${process.pid}.${randomBytes3(8).toString("hex")}.tmp`;
  try {
    await writeFile3(temporary, JSON.stringify(full), {
      encoding: "utf8",
      mode: FILE_MODE
    });
    await chmod2(temporary, FILE_MODE);
    await rename3(temporary, target);
  } catch (error) {
    try {
      await unlink3(temporary);
    } catch {
    }
    throw error;
  }
  return target;
}
function assertPortFileEntry(value, filenamePid) {
  if (typeof value !== "object" || value === null || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid !== filenamePid || !Number.isSafeInteger(value.port) || value.port <= 0 || value.port > 65535 || typeof value.token !== "string" || value.token.length === 0) {
    throw new Error("Invalid RPC port file");
  }
}

// src/rpc/rpc-server.ts
var LOOPBACK_HOST = "127.0.0.1";
var REQUEST_TIMEOUT_MS = 2e3;
var APPLY_TIMEOUT_MS = 12e4;
var MAX_BODY_BYTES = 1024 * 1024;
var APPLY_PATH = "/rpc/apply";
var NOTIFICATIONS_PATH = "/rpc/pending-notifications";
var HEALTH_PATH = "/health";
var COMMANDS = /* @__PURE__ */ new Set([
  "antigravity-quota",
  "antigravity-account",
  "antigravity-routing",
  "antigravity-killswitch",
  "antigravity-dump",
  "antigravity-logging"
]);
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};
async function startRpcServer(options) {
  const token = randomBytes4(32).toString("hex");
  const server = createServer((request, response) => {
    void handleRequest(request, response, token, options).catch((error) => {
      if (response.headersSent || response.writableEnded) return;
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      sendJson(response, 500, { error: "Internal RPC error" });
    });
  });
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  await new Promise((resolve3, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve3();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, LOOPBACK_HOST);
  });
  server.unref();
  const address = server.address();
  if (!address) {
    await closeServer(server);
    throw new Error("RPC server started without a TCP address");
  }
  try {
    await writePortFile(options.dir, {
      pid: process.pid,
      port: address.port,
      token
    });
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  let stopping = null;
  return {
    port: address.port,
    token,
    stop() {
      if (!stopping) {
        stopping = (async () => {
          await closeServer(server);
          try {
            await unlink4(join9(options.dir, `port-${process.pid}.json`));
          } catch (error) {
            if (!isNodeError(error, "ENOENT")) throw error;
          }
        })();
      }
      return stopping;
    }
  };
}
async function handleRequest(request, response, token, options) {
  const path5 = request.url ? new URL(request.url, "http://localhost").pathname : "";
  if (request.method === "GET" && path5 === HEALTH_PATH) {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method !== "POST" || path5 !== APPLY_PATH && path5 !== NOTIFICATIONS_PATH) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  if (!isAuthorized(request.headers.authorization, token)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }
  const body = await readJsonBody(request);
  if (path5 === APPLY_PATH) {
    const applyRequest = parseApplyRequest(body);
    const result = await withTimeout(
      Promise.resolve(options.apply(applyRequest)),
      APPLY_TIMEOUT_MS
    );
    sendJson(response, 200, result);
    return;
  }
  const pendingRequest = parsePendingRequest(body);
  const notifications = await options.drain(
    pendingRequest.lastReceivedId,
    pendingRequest.sessionId
  );
  sendJson(response, 200, { messages: notifications });
}
function isAuthorized(header, token) {
  const prefix = "Bearer ";
  const provided = header?.startsWith(prefix) ? header.slice(prefix.length) : "";
  const expectedBytes = Buffer.from(token);
  const providedBytes = Buffer.from(provided);
  const padded = Buffer.alloc(expectedBytes.length);
  providedBytes.copy(padded, 0, 0, expectedBytes.length);
  const sameLength = providedBytes.length === expectedBytes.length;
  return timingSafeEqual(padded, expectedBytes) && sameLength;
}
async function readJsonBody(request) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    request.resume();
    throw new HttpError(413, "Request body too large");
  }
  const chunks = [];
  let bytes = 0;
  await new Promise((resolve3, reject) => {
    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY_BYTES) {
        request.removeAllListeners("data");
        request.on("data", () => {
        });
        request.resume();
        reject(new HttpError(413, "Request body too large"));
        return;
      }
      chunks.push(buffer);
    });
    request.once("end", resolve3);
    request.once("error", reject);
    request.once("aborted", () => reject(new HttpError(400, "Request aborted")));
  });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
function parseApplyRequest(value) {
  if (!isRecord(value) || typeof value.command !== "string" || !COMMANDS.has(value.command) || typeof value.arguments !== "string" || value.sessionId !== void 0 && typeof value.sessionId !== "string") {
    throw new HttpError(400, "Invalid apply request");
  }
  return value;
}
function parsePendingRequest(value) {
  if (!isRecord(value) || !Number.isSafeInteger(value.lastReceivedId) || value.lastReceivedId < 0 || value.sessionId !== void 0 && typeof value.sessionId !== "string") {
    throw new HttpError(400, "Invalid pending-notifications request");
  }
  return {
    lastReceivedId: value.lastReceivedId,
    ...value.sessionId === void 0 ? {} : { sessionId: value.sessionId }
  };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}
async function withTimeout(promise, timeoutMs) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new HttpError(504, "RPC handler timed out")),
      timeoutMs
    );
    timeout.unref?.();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
function closeServer(server) {
  return new Promise((resolve3, reject) => {
    server.close((error) => {
      if (error && !isNodeError(error, "ERR_SERVER_NOT_RUNNING")) {
        reject(error);
        return;
      }
      resolve3();
    });
    server.closeAllConnections?.();
  });
}
function isNodeError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

// src/sidebar-state.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync4 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { dirname as dirname5, join as join10 } from "node:path";

// ../../node_modules/.bun/xdg-basedir@5.1.0/node_modules/xdg-basedir/index.js
import os2 from "os";
import path4 from "path";
var homeDirectory = os2.homedir();
var { env: env2 } = process;
var xdgData = env2.XDG_DATA_HOME || (homeDirectory ? path4.join(homeDirectory, ".local", "share") : void 0);
var xdgConfig = env2.XDG_CONFIG_HOME || (homeDirectory ? path4.join(homeDirectory, ".config") : void 0);
var xdgState = env2.XDG_STATE_HOME || (homeDirectory ? path4.join(homeDirectory, ".local", "state") : void 0);
var xdgCache = env2.XDG_CACHE_HOME || (homeDirectory ? path4.join(homeDirectory, ".cache") : void 0);
var xdgRuntime = env2.XDG_RUNTIME_DIR || void 0;
var xdgDataDirectories = (env2.XDG_DATA_DIRS || "/usr/local/share/:/usr/share/").split(":");
if (xdgData) {
  xdgDataDirectories.unshift(xdgData);
}
var xdgConfigDirectories = (env2.XDG_CONFIG_DIRS || "/etc/xdg").split(":");
if (xdgConfig) {
  xdgConfigDirectories.unshift(xdgConfig);
}

// src/sidebar-state.ts
var SIDEBAR_STATE_VERSION = 1;
var DEFAULT_SIDEBAR_STATE = {
  version: SIDEBAR_STATE_VERSION,
  checkedAt: 0,
  accounts: [],
  activeRouting: {},
  routingAuthoritative: false
};
var SIDEBAR_STATE_ENV = "ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE";
var SIDEBAR_STATE_DIR = "cortexkit/antigravity-auth";
var SIDEBAR_STATE_FILENAME = "sidebar-state.json";
var ACTIVE_ROUTING_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var ACTIVE_ROUTING_MAX_ENTRIES = 100;
var SIDEBAR_LOCK_NAME = "sidebar";
var SIDEBAR_LOCK_TTL_MS = 1e4;
var SIDEBAR_LOCK_TIMEOUT_MS = 2e3;
var SIDEBAR_LOCK_RETRY_BASE_MS = 25;
var SIDEBAR_LOCK_RETRY_CAP_MS = 75;
var SIDEBAR_LOCK_JITTER_MS = 25;
var SIDEBAR_STATE_DIR_MODE = 448;
var SidebarStateLockContentionError = class extends Error {
  details;
  constructor(stateFile, timeoutMs) {
    super(
      `Could not acquire sidebar-state lock at ${stateFile} within ${timeoutMs}ms`
    );
    this.name = "SidebarStateLockContentionError";
    this.details = { stateFile, timeoutMs };
  }
};
var sidebarMergeHooks = null;
async function emitMergeStep(step) {
  await sidebarMergeHooks?.onStep?.(step);
}
function getSidebarStateFile() {
  const override = process.env[SIDEBAR_STATE_ENV];
  if (override && override.trim().length > 0) return override;
  const base = xdgState ?? join10(homedir5(), ".local", "state");
  return join10(base, SIDEBAR_STATE_DIR, SIDEBAR_STATE_FILENAME);
}
function readSidebarState(path5 = getSidebarStateFile()) {
  let raw;
  try {
    raw = readFileSync4(path5, "utf-8");
  } catch {
    return { ...DEFAULT_SIDEBAR_STATE };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SIDEBAR_STATE, lastError: "malformed-json" };
  }
  return normalizeSidebarState(parsed);
}
function normalizeSidebarState(input2) {
  if (!isObject(input2)) {
    return { ...DEFAULT_SIDEBAR_STATE, lastError: "shape" };
  }
  const record = input2;
  const version = record.version;
  if (version !== SIDEBAR_STATE_VERSION) {
    return {
      ...DEFAULT_SIDEBAR_STATE,
      lastError: `unsupported-version:${stringifySafe(version)}`
    };
  }
  const accountsRaw = record.accounts;
  const accounts = Array.isArray(accountsRaw) ? accountsRaw.map((entry) => normalizeAccount(entry)).filter((entry) => entry !== null) : [];
  const routingRaw = record.activeRouting;
  const activeRouting = {};
  if (isObject(routingRaw)) {
    for (const [sessionId, entry] of Object.entries(
      routingRaw
    )) {
      const normalized = normalizeRouting(entry);
      if (normalized) activeRouting[sessionId] = normalized;
    }
  }
  const checkedAt = toFiniteNumber(record.checkedAt);
  const routingAuthoritative = record.routingAuthoritative === true;
  const quotaBackoffUntil = toFiniteNumber(record.quotaBackoffUntil);
  const lastError = typeof record.lastError === "string" ? record.lastError : void 0;
  return {
    version: SIDEBAR_STATE_VERSION,
    checkedAt: checkedAt ?? 0,
    accounts,
    activeRouting,
    routingAuthoritative,
    quotaBackoffUntil: quotaBackoffUntil ?? void 0,
    lastError
  };
}
function normalizeAccount(input2) {
  if (!isObject(input2)) return null;
  const record = input2;
  const id = typeof record.id === "string" ? record.id : null;
  const label = typeof record.label === "string" ? record.label : null;
  if (!id || !label) return null;
  const enabled = record.enabled !== false;
  const health = clampNumber(toFiniteNumber(record.health), 0, 100);
  const current = record.current === true;
  const cooldownUntil = toFiniteNumber(record.cooldownUntil) ?? void 0;
  const quotaRaw = record.quota;
  const quota = {};
  if (isObject(quotaRaw)) {
    for (const key of ["gemini", "non-gemini"]) {
      const entry = quotaRaw[key];
      const normalized = normalizeQuota(entry);
      if (normalized) quota[key] = normalized;
    }
  }
  const tier = normalizeTier(record.tier);
  return {
    id,
    label,
    enabled,
    health,
    current,
    cooldownUntil,
    quota,
    ...tier !== void 0 ? { tier } : {}
  };
}
function normalizeTier(input2) {
  if (!isObject(input2)) return void 0;
  const record = input2;
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : null;
  const capturedAt = toFiniteNumber(record.capturedAt);
  if (!id || capturedAt === null) return void 0;
  const paidId = typeof record.paidId === "string" && record.paidId.length > 0 ? record.paidId : void 0;
  return { id, ...paidId ? { paidId } : {}, capturedAt };
}
function normalizeQuota(input2) {
  if (!isObject(input2)) return null;
  const record = input2;
  const remaining = toFiniteNumber(record.remainingPercent);
  if (remaining === null) return null;
  const resetAt = toFiniteNumber(record.resetAt) ?? void 0;
  const windowsRaw = record.windows;
  let windows;
  if (Array.isArray(windowsRaw)) {
    const parsed = windowsRaw.filter(isObject).map((w) => {
      const win = w.window;
      const rp = toFiniteNumber(
        w.remainingPercent
      );
      const ra = toFiniteNumber(w.resetAt);
      if (win !== "weekly" && win !== "5h" || rp === null) return null;
      return {
        window: win,
        remainingPercent: clampNumber(rp, 0, 100),
        resetAt: ra ?? void 0
      };
    }).filter((v) => v !== null);
    if (parsed.length > 0) windows = parsed;
  }
  return {
    remainingPercent: clampNumber(remaining, 0, 100),
    resetAt,
    windows
  };
}
function normalizeRouting(input2) {
  if (!isObject(input2)) return null;
  const record = input2;
  const accountId = typeof record.accountId === "string" ? record.accountId : null;
  const modelFamily = record.modelFamily;
  const headerStyle = record.headerStyle;
  const strategy = record.strategy;
  const updatedAt = toFiniteNumber(record.updatedAt) ?? 0;
  if (!accountId || modelFamily !== "claude" && modelFamily !== "gemini" || headerStyle !== "antigravity" && headerStyle !== "gemini-cli") {
    return null;
  }
  return {
    accountId,
    modelFamily,
    headerStyle,
    strategy: strategy === "sticky" || strategy === "round-robin" || strategy === "hybrid" ? strategy : void 0,
    updatedAt
  };
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
function clampNumber(value, min, max) {
  if (value === null) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
function stringifySafe(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "unknown";
  } catch {
    return "unknown";
  }
}
function ensureSidebarStateDir(path5 = getSidebarStateFile()) {
  mkdirSync3(dirname5(path5), { recursive: true, mode: SIDEBAR_STATE_DIR_MODE });
}
function pruneActiveRouting(map, now) {
  const cutoff = now - ACTIVE_ROUTING_MAX_AGE_MS;
  const filtered = [];
  for (const [sessionId, entry] of Object.entries(map)) {
    if (entry.updatedAt >= cutoff) {
      filtered.push([sessionId, entry]);
    }
  }
  filtered.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  if (filtered.length <= ACTIVE_ROUTING_MAX_ENTRIES) {
    return Object.fromEntries(filtered);
  }
  return Object.fromEntries(filtered.slice(0, ACTIVE_ROUTING_MAX_ENTRIES));
}
function toCapturedTier(account) {
  return account.capturedTierId !== void 0 && account.capturedTierAt !== void 0 ? {
    id: account.capturedTierId,
    ...account.capturedPaidTierId !== void 0 ? { paidId: account.capturedPaidTierId } : {},
    capturedAt: account.capturedTierAt
  } : void 0;
}
function normalizeLegacyCachedQuota2(raw) {
  if (!raw) return raw;
  const hasLegacy = "gemini-pro" in raw || "gemini-flash" in raw || "claude" in raw || "gpt-oss" in raw;
  if (!hasLegacy) return raw;
  const earlierResetTime = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    return a < b ? a : b;
  };
  const minFraction = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    const fa = a.remainingFraction ?? 1;
    const fb = b.remainingFraction ?? 1;
    const winner = fa <= fb ? a : b;
    const loser = fa <= fb ? b : a;
    return {
      ...winner,
      resetTime: earlierResetTime(winner.resetTime, loser.resetTime)
    };
  };
  const gemini = minFraction(
    raw.gemini,
    minFraction(
      raw["gemini-pro"],
      raw["gemini-flash"]
    )
  ) ?? raw.gemini;
  const nonGemini = minFraction(
    raw["non-gemini"],
    minFraction(raw.claude, raw["gpt-oss"])
  ) ?? raw["non-gemini"];
  return {
    ...gemini !== void 0 ? { gemini } : {},
    ...nonGemini !== void 0 ? { "non-gemini": nonGemini } : {}
  };
}
function projectQuotaPoolForSidebar(source) {
  const fraction = source.remainingFraction;
  if (typeof fraction !== "number" || !Number.isFinite(fraction))
    return void 0;
  const remainingPercent = clampNumber(Math.round(fraction * 100), 0, 100);
  let resetAt;
  if (typeof source.resetTime === "string" && source.resetTime.length > 0) {
    const parsed = Date.parse(source.resetTime);
    if (Number.isFinite(parsed)) resetAt = parsed;
  }
  const windows = source.windows?.length ? source.windows.map((w) => ({
    window: w.window,
    remainingPercent: clampNumber(
      Math.round(w.remainingFraction * 100),
      0,
      100
    ),
    resetAt: typeof w.resetTime === "string" && w.resetTime.length > 0 ? (() => {
      const parsed = Date.parse(w.resetTime);
      return Number.isFinite(parsed) ? parsed : void 0;
    })() : void 0
  })) : void 0;
  return { remainingPercent, resetAt, windows };
}
function isAccountCurrent(index, activeIndexByFamily) {
  return index === activeIndexByFamily.claude || index === activeIndexByFamily.gemini;
}
function redactAccountForSidebar(source) {
  const id = `acct-${source.index}`;
  const label = `Account ${source.index + 1}`;
  const enabled = source.enabled !== false;
  const current = source.current === true;
  const cooldownUntil = typeof source.coolingDownUntil === "number" && Number.isFinite(source.coolingDownUntil) ? source.coolingDownUntil : void 0;
  const health = clampNumber(
    typeof source.healthScore === "number" ? source.healthScore : 100,
    0,
    100
  );
  const quota = {};
  const staleCachedQuota = typeof source.cachedQuotaAccountId === "string" && typeof source.currentQuotaAccountId === "string" && source.cachedQuotaAccountId !== source.currentQuotaAccountId;
  const cached = staleCachedQuota ? void 0 : normalizeLegacyCachedQuota2(source.cachedQuota);
  if (cached) {
    for (const key of ["gemini", "non-gemini"]) {
      const entry = cached[key];
      if (!entry) continue;
      const projected = projectQuotaPoolForSidebar(entry);
      if (projected) quota[key] = projected;
    }
  }
  return {
    id,
    label,
    enabled,
    health,
    current,
    cooldownUntil,
    quota,
    // Tier is plan metadata, not PII — it passes the redaction boundary.
    ...source.tier !== void 0 ? { tier: source.tier } : {}
  };
}
function buildSidebarMachineStateFromAccounts(accounts, options = {}) {
  return {
    checkedAt: options.checkedAt ?? Date.now(),
    accounts: accounts.map((entry) => redactAccountForSidebar(entry)),
    quotaBackoffUntil: options.quotaBackoffUntil,
    lastError: options.lastError,
    routingAuthoritative: options.routingAuthoritative
  };
}
var sidebarWriteChain = Promise.resolve();
function enqueueSidebarWrite(work) {
  const next = sidebarWriteChain.then(work, work);
  sidebarWriteChain = next.then(
    () => void 0,
    () => void 0
  );
  return next;
}
function drainSidebarWrites() {
  return sidebarWriteChain;
}
async function sleep2(ms) {
  await new Promise((resolve3) => setTimeout(resolve3, ms));
}
async function acquireSidebarLockWithRetry(stateFile) {
  const start = Date.now();
  let attempt = 0;
  while (true) {
    await emitMergeStep("await-lock");
    const lock = await acquireFencedFileLock({
      path: stateFile,
      name: SIDEBAR_LOCK_NAME,
      ttlMs: SIDEBAR_LOCK_TTL_MS,
      renew: true
    });
    if (lock) {
      await emitMergeStep("acquired-lock");
      return lock;
    }
    const elapsed = Date.now() - start;
    if (elapsed >= SIDEBAR_LOCK_TIMEOUT_MS) {
      throw new SidebarStateLockContentionError(
        stateFile,
        SIDEBAR_LOCK_TIMEOUT_MS
      );
    }
    const backoff = Math.min(
      SIDEBAR_LOCK_RETRY_CAP_MS,
      SIDEBAR_LOCK_RETRY_BASE_MS + attempt * 10
    );
    const jitter = Math.floor(Math.random() * SIDEBAR_LOCK_JITTER_MS);
    await sleep2(backoff + jitter);
    attempt++;
  }
}
async function performSidebarWrite(stateFile, merge) {
  await enqueueSidebarWrite(async () => {
    ensureSidebarStateDir(stateFile);
    const lock = await acquireSidebarLockWithRetry(stateFile);
    try {
      await lock.assertOwned();
      const existing = readSidebarState(stateFile);
      await emitMergeStep("read-state");
      const merged = merge(existing);
      await emitMergeStep("merged-state");
      await writeJsonAtomic(stateFile, merged);
      await emitMergeStep("wrote-state");
    } finally {
      await lock.release().catch(() => {
      });
    }
  });
}
function mergeMachineState(existing, next) {
  if (next.checkedAt < existing.checkedAt) {
    return {
      ...existing,
      activeRouting: pruneActiveRouting(existing.activeRouting, Date.now())
    };
  }
  return {
    version: SIDEBAR_STATE_VERSION,
    checkedAt: next.checkedAt,
    accounts: next.accounts,
    quotaBackoffUntil: next.quotaBackoffUntil,
    lastError: next.lastError,
    routingAuthoritative: existing.routingAuthoritative === true || next.routingAuthoritative === true,
    // Symmetric with the stale-write branch: every machine-write merge
    // re-prunes activeRouting so a long-running TUI session eventually
    // drops dead routes even when no fresh routing upsert lands. Cheap
    // (a single Object.entries + sort over ≤100 entries) and bounded.
    activeRouting: pruneActiveRouting(existing.activeRouting, Date.now())
  };
}
async function upsertSidebarActiveRouting(sessionId, entry, options = {}) {
  const stateFile = options.stateFile ?? getSidebarStateFile();
  await performSidebarWrite(stateFile, (existing) => {
    const activeRouting = { ...existing.activeRouting, [sessionId]: entry };
    return {
      ...existing,
      routingAuthoritative: options.authoritative === true ? true : existing.routingAuthoritative,
      activeRouting: pruneActiveRouting(activeRouting, Date.now())
    };
  });
}
async function removeSidebarActiveRouting(sessionId, options = {}) {
  const stateFile = options.stateFile ?? getSidebarStateFile();
  await performSidebarWrite(stateFile, (existing) => {
    if (!(sessionId in existing.activeRouting)) {
      return existing;
    }
    const activeRouting = { ...existing.activeRouting };
    delete activeRouting[sessionId];
    return {
      ...existing,
      activeRouting
    };
  });
}
async function setSidebarMachineState(next, options = {}) {
  const stateFile = options.stateFile ?? getSidebarStateFile();
  await performSidebarWrite(
    stateFile,
    (existing) => mergeMachineState(existing, next)
  );
}

// src/plugin/cache.ts
import { createHash as createHash5 } from "node:crypto";

// src/plugin/cache/signature-cache.ts
import {
  existsSync as existsSync4,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync5,
  renameSync as renameSync2,
  unlinkSync as unlinkSync3,
  writeFileSync as writeFileSync4
} from "node:fs";
import { homedir as homedir6, tmpdir as tmpdir2 } from "node:os";
import { dirname as dirname6, join as join11 } from "node:path";
function getConfigDir3() {
  const platform = process.platform;
  if (platform === "win32") {
    return join11(
      process.env.APPDATA || join11(homedir6(), "AppData", "Roaming"),
      "opencode"
    );
  }
  const xdgConfig2 = process.env.XDG_CONFIG_HOME || join11(homedir6(), ".config");
  return join11(xdgConfig2, "opencode");
}
function getCacheFilePath() {
  return join11(getConfigDir3(), "antigravity-signature-cache.json");
}
var SignatureCache = class {
  // In-memory cache: key -> entry with signature and optional thinking text
  cache = /* @__PURE__ */ new Map();
  // Configuration
  memoryTtlMs;
  diskTtlMs;
  writeIntervalMs;
  cacheFilePath;
  enabled;
  // State
  dirty = false;
  writeTimer = null;
  cleanupTimer = null;
  // Statistics
  stats = {
    memoryHits: 0,
    diskHits: 0,
    misses: 0,
    writes: 0
  };
  constructor(config) {
    this.enabled = config.enabled;
    this.memoryTtlMs = config.memory_ttl_seconds * 1e3;
    this.diskTtlMs = config.disk_ttl_seconds * 1e3;
    this.writeIntervalMs = config.write_interval_seconds * 1e3;
    this.cacheFilePath = getCacheFilePath();
    if (this.enabled) {
      this.loadFromDisk();
      this.startBackgroundTasks();
    }
  }
  // ===========================================================================
  // Public API
  // ===========================================================================
  /**
   * Generate a cache key from sessionId and modelId.
   */
  static makeKey(sessionId, modelId) {
    return `${sessionId}:${modelId}`;
  }
  /**
   * Store a signature in the cache.
   */
  store(key, signature) {
    if (!this.enabled) return;
    this.cache.set(key, {
      value: signature,
      timestamp: Date.now()
    });
    this.dirty = true;
  }
  /**
   * Retrieve a signature from the cache.
   * Returns null if not found or expired.
   */
  retrieve(key) {
    if (!this.enabled) return null;
    const entry = this.cache.get(key);
    if (entry) {
      const age = Date.now() - entry.timestamp;
      if (age <= this.memoryTtlMs) {
        this.stats.memoryHits++;
        return entry.value;
      }
      this.cache.delete(key);
    }
    this.stats.misses++;
    return null;
  }
  /**
   * Check if a key exists in the cache (without updating stats).
   */
  has(key) {
    if (!this.enabled) return false;
    const entry = this.cache.get(key);
    if (!entry) return false;
    const age = Date.now() - entry.timestamp;
    return age <= this.memoryTtlMs;
  }
  // ===========================================================================
  // Full Thinking Cache (ported from LLM-API-Key-Proxy)
  // ===========================================================================
  /**
   * Store full thinking content with signature.
   * This enables recovery even after thinking text is stripped by compaction.
   *
   * Port of LLM-API-Key-Proxy's _cache_thinking()
   */
  storeThinking(key, thinkingText, signature, toolIds) {
    if (!this.enabled || !thinkingText || !signature) return;
    this.cache.set(key, {
      value: signature,
      timestamp: Date.now(),
      thinkingText,
      textPreview: thinkingText.slice(0, 100),
      toolIds
    });
    this.dirty = true;
  }
  /**
   * Retrieve full thinking content by key.
   * Returns null if not found or expired.
   */
  retrieveThinking(key) {
    if (!this.enabled) return null;
    const entry = this.cache.get(key);
    if (!entry?.thinkingText) return null;
    const age = Date.now() - entry.timestamp;
    if (age > this.memoryTtlMs) {
      this.cache.delete(key);
      return null;
    }
    this.stats.memoryHits++;
    return {
      text: entry.thinkingText,
      signature: entry.value,
      toolIds: entry.toolIds
    };
  }
  /**
   * Check if full thinking content exists for a key.
   */
  hasThinking(key) {
    if (!this.enabled) return false;
    const entry = this.cache.get(key);
    if (!entry?.thinkingText) return false;
    const age = Date.now() - entry.timestamp;
    return age <= this.memoryTtlMs;
  }
  /**
   * Get cache statistics.
   */
  getStats() {
    return {
      ...this.stats,
      memoryEntries: this.cache.size,
      dirty: this.dirty,
      diskEnabled: this.enabled
    };
  }
  /**
   * Manually trigger a disk save.
   */
  async flush() {
    if (!this.enabled) return true;
    return this.saveToDisk();
  }
  /**
   * Graceful shutdown: stop timers and flush to disk.
   */
  shutdown() {
    if (this.writeTimer) {
      clearInterval(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.dirty && this.enabled) {
      this.saveToDisk();
    }
  }
  // ===========================================================================
  // Disk Operations
  // ===========================================================================
  /**
   * Load cache from disk file with TTL validation.
   */
  loadFromDisk() {
    try {
      if (!existsSync4(this.cacheFilePath)) {
        return;
      }
      const content = readFileSync5(this.cacheFilePath, "utf-8");
      const data = JSON.parse(content);
      if (data.version !== "1.0") {
        return;
      }
      const now = Date.now();
      let _loaded = 0;
      let _expired = 0;
      for (const [key, entry] of Object.entries(data.entries)) {
        const age = now - entry.timestamp;
        if (age <= this.diskTtlMs) {
          this.cache.set(key, {
            value: entry.value,
            timestamp: entry.timestamp
          });
          _loaded++;
        } else {
          _expired++;
        }
      }
    } catch {
    }
  }
  /**
   * Save cache to disk with atomic write pattern.
   * Merges with existing disk entries that haven't expired.
   */
  saveToDisk() {
    try {
      const dir = dirname6(this.cacheFilePath);
      if (!existsSync4(dir)) {
        mkdirSync4(dir, { recursive: true });
      }
      ensureGitignoreSync(dir);
      const now = Date.now();
      let existingEntries = {};
      if (existsSync4(this.cacheFilePath)) {
        try {
          const content = readFileSync5(this.cacheFilePath, "utf-8");
          const data = JSON.parse(content);
          existingEntries = data.entries || {};
        } catch {
        }
      }
      const validDiskEntries = {};
      for (const [key, entry] of Object.entries(existingEntries)) {
        const age = now - entry.timestamp;
        if (age <= this.diskTtlMs) {
          validDiskEntries[key] = entry;
        }
      }
      const mergedEntries = { ...validDiskEntries };
      for (const [key, entry] of this.cache.entries()) {
        mergedEntries[key] = {
          value: entry.value,
          timestamp: entry.timestamp
        };
      }
      const cacheData = {
        version: "1.0",
        memory_ttl_seconds: this.memoryTtlMs / 1e3,
        disk_ttl_seconds: this.diskTtlMs / 1e3,
        entries: mergedEntries,
        statistics: {
          memory_hits: this.stats.memoryHits,
          disk_hits: this.stats.diskHits,
          misses: this.stats.misses,
          writes: this.stats.writes + 1,
          last_write: now
        }
      };
      const tmpPath = join11(
        tmpdir2(),
        `antigravity-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
      );
      writeFileSync4(tmpPath, JSON.stringify(cacheData, null, 2), "utf-8");
      try {
        renameSync2(tmpPath, this.cacheFilePath);
      } catch {
        writeFileSync4(this.cacheFilePath, readFileSync5(tmpPath));
        try {
          unlinkSync3(tmpPath);
        } catch {
        }
      }
      this.stats.writes++;
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }
  // ===========================================================================
  // Background Tasks
  // ===========================================================================
  /**
   * Start background write and cleanup timers.
   */
  startBackgroundTasks() {
    this.writeTimer = setInterval(() => {
      if (this.dirty) {
        this.saveToDisk();
      }
    }, this.writeIntervalMs);
    this.cleanupTimer = setInterval(
      () => {
        this.cleanupExpired();
      },
      30 * 60 * 1e3
    );
  }
  /**
   * Remove expired entries from memory.
   */
  cleanupExpired() {
    const now = Date.now();
    let _cleaned = 0;
    for (const [key, entry] of this.cache.entries()) {
      const age = now - entry.timestamp;
      if (age > this.memoryTtlMs) {
        this.cache.delete(key);
        _cleaned++;
      }
    }
  }
};
function createSignatureCache(config) {
  if (!config?.enabled) {
    return null;
  }
  return new SignatureCache(config);
}

// src/plugin/cache.ts
var authCache = /* @__PURE__ */ new Map();
function normalizeRefreshKey(refresh) {
  const key = refresh?.trim();
  return key ? key : void 0;
}
function storeCachedAuth(auth) {
  const key = normalizeRefreshKey(auth.refresh);
  if (!key) {
    return;
  }
  authCache.set(key, auth);
}
function clearCachedAuth(refresh) {
  if (!refresh) {
    authCache.clear();
    return;
  }
  const key = normalizeRefreshKey(refresh);
  if (key) {
    authCache.delete(key);
  }
}
var signatureCache = /* @__PURE__ */ new Map();
var SIGNATURE_CACHE_TTL_MS = 60 * 60 * 1e3;
var MAX_ENTRIES_PER_SESSION = 100;
var MAX_CACHED_SESSIONS = 10;
var SIGNATURE_TEXT_HASH_HEX_LEN = 16;
var diskCache = null;
function initDiskSignatureCache(config) {
  diskCache = createSignatureCache(config);
  return diskCache;
}
async function shutdownDiskSignatureCache() {
  const cache = diskCache;
  try {
    await cache?.flush();
  } finally {
    cache?.shutdown();
    diskCache = null;
    clearCachedAuth();
    clearSignatureCache();
  }
}
function hashText(text) {
  return createHash5("sha256").update(text, "utf8").digest("hex").slice(0, SIGNATURE_TEXT_HASH_HEX_LEN);
}
function makeDiskKey(sessionId, textHash) {
  return `${sessionId}:${textHash}`;
}
function pruneSignatureSessions() {
  if (signatureCache.size <= MAX_CACHED_SESSIONS) return;
  const now = Date.now();
  for (const [sid, innerMap] of signatureCache) {
    let allExpired = true;
    for (const entry of innerMap.values()) {
      if (now - entry.timestamp <= SIGNATURE_CACHE_TTL_MS) {
        allExpired = false;
        break;
      }
    }
    if (allExpired) {
      signatureCache.delete(sid);
    }
  }
  if (signatureCache.size > MAX_CACHED_SESSIONS) {
    const sessionsByAge = [];
    for (const [sid, innerMap] of signatureCache) {
      let newestTs = 0;
      for (const entry of innerMap.values()) {
        if (entry.timestamp > newestTs) newestTs = entry.timestamp;
      }
      sessionsByAge.push({ sid, newestTs });
    }
    sessionsByAge.sort((a, b) => a.newestTs - b.newestTs);
    const toEvict = signatureCache.size - MAX_CACHED_SESSIONS;
    for (let i = 0; i < toEvict; i++) {
      const entry = sessionsByAge[i];
      if (entry) signatureCache.delete(entry.sid);
    }
  }
}
function cacheSignature(sessionId, text, signature) {
  if (!sessionId || !text || !signature) return;
  const textHash = hashText(text);
  let sessionMemCache = signatureCache.get(sessionId);
  if (!sessionMemCache) {
    pruneSignatureSessions();
    sessionMemCache = /* @__PURE__ */ new Map();
    signatureCache.set(sessionId, sessionMemCache);
  }
  if (sessionMemCache.size >= MAX_ENTRIES_PER_SESSION) {
    const now = Date.now();
    for (const [key, entry] of sessionMemCache.entries()) {
      if (now - entry.timestamp > SIGNATURE_CACHE_TTL_MS) {
        sessionMemCache.delete(key);
      }
    }
    if (sessionMemCache.size >= MAX_ENTRIES_PER_SESSION) {
      const entries = Array.from(sessionMemCache.entries()).sort(
        (a, b) => a[1].timestamp - b[1].timestamp
      );
      const toRemove = entries.slice(0, Math.floor(MAX_ENTRIES_PER_SESSION / 4));
      for (const [key] of toRemove) {
        sessionMemCache.delete(key);
      }
    }
  }
  sessionMemCache.set(textHash, { signature, timestamp: Date.now() });
  if (diskCache) {
    const diskKey = makeDiskKey(sessionId, textHash);
    diskCache.store(diskKey, signature);
  }
}
function getCachedSignature(sessionId, text) {
  if (!sessionId || !text) return void 0;
  const textHash = hashText(text);
  const sessionMemCache = signatureCache.get(sessionId);
  if (sessionMemCache) {
    const entry = sessionMemCache.get(textHash);
    if (entry) {
      if (Date.now() - entry.timestamp > SIGNATURE_CACHE_TTL_MS) {
        sessionMemCache.delete(textHash);
      } else {
        return entry.signature;
      }
    }
  }
  if (diskCache) {
    const diskKey = makeDiskKey(sessionId, textHash);
    const diskValue = diskCache.retrieve(diskKey);
    if (diskValue) {
      let memCache = signatureCache.get(sessionId);
      if (!memCache) {
        memCache = /* @__PURE__ */ new Map();
        signatureCache.set(sessionId, memCache);
      }
      memCache.set(textHash, { signature: diskValue, timestamp: Date.now() });
      return diskValue;
    }
  }
  return void 0;
}
function clearSignatureCache(sessionId) {
  if (sessionId) {
    signatureCache.delete(sessionId);
  } else {
    signatureCache.clear();
  }
}

// src/plugin/token.ts
var log6 = createLogger2("token");
function parseOAuthErrorPayload(text) {
  if (!text) {
    return {};
  }
  try {
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== "object") {
      return { description: text };
    }
    let code;
    if (typeof payload.error === "string") {
      code = payload.error;
    } else if (payload.error && typeof payload.error === "object") {
      code = payload.error.status ?? payload.error.code;
      if (!payload.error_description && payload.error.message) {
        return { code, description: payload.error.message };
      }
    }
    const description = payload.error_description;
    if (description) {
      return { code, description };
    }
    if (payload.error && typeof payload.error === "object" && payload.error.message) {
      return { code, description: payload.error.message };
    }
    return { code };
  } catch {
    return { description: text };
  }
}
var AntigravityTokenRefreshError = class extends Error {
  code;
  description;
  status;
  statusText;
  constructor(options) {
    super(options.message);
    this.name = "AntigravityTokenRefreshError";
    this.code = options.code;
    this.description = options.description;
    this.status = options.status;
    this.statusText = options.statusText;
  }
};
async function refreshAccessToken(auth, _client2, _providerId) {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return void 0;
  }
  try {
    const startTime = Date.now();
    const response = await fetchWithActiveTimeout(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: parts.refreshToken,
          client_id: ANTIGRAVITY_CLIENT_ID,
          client_secret: ANTIGRAVITY_CLIENT_SECRET
        })
      }
    );
    if (!response.ok) {
      let errorText;
      try {
        errorText = await response.text();
      } catch {
        errorText = void 0;
      }
      const { code, description } = parseOAuthErrorPayload(errorText);
      const details = [code, description ?? errorText].filter(Boolean).join(": ");
      const baseMessage = `Antigravity token refresh failed (${response.status} ${response.statusText})`;
      const message = details ? `${baseMessage} - ${details}` : baseMessage;
      log6.warn("Token refresh failed", {
        status: response.status,
        code,
        details
      });
      if (code === "invalid_grant") {
        log6.warn(
          "Google revoked the stored refresh token - reauthentication required"
        );
        invalidateProjectContextCache(auth.refresh);
        clearCachedAuth(auth.refresh);
      }
      throw new AntigravityTokenRefreshError({
        message,
        code,
        description: description ?? errorText,
        status: response.status,
        statusText: response.statusText
      });
    }
    const payload = await response.json();
    const refreshedParts = {
      refreshToken: payload.refresh_token ?? parts.refreshToken,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId
    };
    const updatedAuth = {
      ...auth,
      access: payload.access_token,
      expires: calculateTokenExpiry(startTime, payload.expires_in),
      refresh: formatRefreshParts(refreshedParts)
    };
    storeCachedAuth(updatedAuth);
    return updatedAuth;
  } catch (error) {
    if (error instanceof AntigravityTokenRefreshError) {
      throw error;
    }
    log6.error("Unexpected token refresh error", { error: String(error) });
    return void 0;
  }
}

// src/plugin/account-access.ts
function decodeEscapedText(input2) {
  return input2.replace(/&amp;/g, "&").replace(
    /\\u([0-9a-fA-F]{4})/g,
    (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))
  );
}
function normalizeGoogleVerificationUrl(rawUrl) {
  const normalized = decodeEscapedText(rawUrl).trim();
  if (!normalized) return void 0;
  try {
    const parsed = new URL(normalized);
    if (parsed.hostname !== "accounts.google.com") return void 0;
    return parsed.toString();
  } catch {
    return void 0;
  }
}
function selectBestVerificationUrl(urls) {
  const unique = Array.from(
    new Set(
      urls.map((url) => normalizeGoogleVerificationUrl(url)).filter(Boolean)
    )
  );
  if (unique.length === 0) return void 0;
  const score = (value) => {
    let total = 0;
    if (value.includes("plt=")) total += 4;
    if (value.includes("/signin/continue")) total += 3;
    if (value.includes("continue=")) total += 2;
    if (value.includes("service=cloudcode")) total += 1;
    return total;
  };
  unique.sort((a, b) => score(b) - score(a));
  return unique[0];
}
function extractAccountAccessErrorDetails(bodyText) {
  const decodedBody = decodeEscapedText(bodyText);
  const lowerBody = decodedBody.toLowerCase();
  let validationRequired = lowerBody.includes("validation_required");
  const ineligiblePattern = /(^|[^a-z0-9_])account_ineligible([^a-z0-9_]|$)/i;
  let accountIneligible = ineligiblePattern.test(decodedBody);
  let message;
  const verificationUrls = /* @__PURE__ */ new Set();
  const collectUrlsFromText = (text) => {
    for (const match of text.matchAll(
      /https:\/\/accounts\.google\.com\/[^\s"'<>]+/gi
    )) {
      if (match[0]) verificationUrls.add(match[0]);
    }
  };
  collectUrlsFromText(decodedBody);
  const payloads = [];
  const trimmed = decodedBody.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      payloads.push(JSON.parse(trimmed));
    } catch {
    }
  }
  for (const rawLine of decodedBody.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payloadText = line.slice(5).trim();
    if (!payloadText || payloadText === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(payloadText));
    } catch {
      collectUrlsFromText(payloadText);
    }
  }
  const visited = /* @__PURE__ */ new Set();
  const walk = (value, key) => {
    if (typeof value === "string") {
      const normalizedValue = decodeEscapedText(value);
      const lowerValue = normalizedValue.toLowerCase();
      const lowerKey = key?.toLowerCase() ?? "";
      if (lowerValue.includes("validation_required")) {
        validationRequired = true;
      }
      if (ineligiblePattern.test(normalizedValue)) {
        accountIneligible = true;
      }
      if (!message && (lowerKey.includes("message") || lowerKey.includes("detail") || lowerKey.includes("description"))) {
        message = normalizedValue;
      }
      if (lowerKey.includes("validation_url") || lowerKey.includes("verify_url") || lowerKey.includes("verification_url") || lowerKey === "url") {
        verificationUrls.add(normalizedValue);
      }
      collectUrlsFromText(normalizedValue);
      return;
    }
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    for (const [childKey, childValue] of Object.entries(
      value
    )) {
      walk(childValue, childKey);
    }
  };
  for (const payload of payloads) walk(payload);
  if (!validationRequired) {
    validationRequired = lowerBody.includes("verification required") || lowerBody.includes("verify your account") || lowerBody.includes("account verification");
  }
  if (!message) {
    message = decodedBody.split("\n").map((line) => line.trim()).find(
      (line) => line && !line.startsWith("data:") && /(verify|validation|required|ineligible)/i.test(line)
    );
  }
  return {
    validationRequired,
    accountIneligible,
    message,
    verifyUrl: selectBestVerificationUrl([...verificationUrls])
  };
}
function buildAccountAccessProbeRequest(projectId) {
  const wireModel = "gemini-3.5-flash-low";
  const request = {
    contents: [{ role: "user", parts: [{ text: "ping" }] }],
    generationConfig: { maxOutputTokens: 1, temperature: 0 }
  };
  const requestMetadata = buildAgyAgentRequestMetadata(
    createAgyRequestSessionContext(""),
    request,
    wireModel
  );
  request.labels = requestMetadata.labels;
  request.sessionId = requestMetadata.sessionId;
  orderAgyRequestPayloadInPlace(request);
  return {
    project: projectId,
    requestId: requestMetadata.requestId,
    request,
    model: wireModel,
    userAgent: "antigravity",
    requestType: "agent"
  };
}
async function interpretAccountAccessProbeResponse(response) {
  if (response.ok) {
    await response.body?.cancel().catch(() => {
    });
    return { status: "ok", message: "Account verification check passed." };
  }
  let responseBody = "";
  try {
    responseBody = await response.text();
  } catch {
  }
  const extracted = extractAccountAccessErrorDetails(responseBody);
  if (response.status === 403 && extracted.accountIneligible) {
    return {
      status: "ineligible",
      message: extracted.message ?? "Google marked this account as ineligible for Antigravity."
    };
  }
  if (response.status === 403 && extracted.validationRequired) {
    return {
      status: "verification-required",
      message: extracted.message ?? "Google requires additional account verification.",
      verifyUrl: extracted.verifyUrl
    };
  }
  return {
    status: "error",
    message: extracted.message ?? `Request failed (${response.status} ${response.statusText}).`
  };
}
function markStoredAccountVerificationRequired(account, reason, verifyUrl) {
  let changed = false;
  const wasVerificationRequired = account.verificationRequired === true;
  const timestamp = Date.now();
  if (!wasVerificationRequired) {
    account.verificationRequired = true;
    changed = true;
  }
  if (!wasVerificationRequired || account.verificationRequiredAt === void 0) {
    account.verificationRequiredAt = timestamp;
    changed = true;
  }
  if (account.accountIneligible === true || account.accountIneligibleAt !== void 0 || account.accountIneligibleReason !== void 0) {
    account.accountIneligible = false;
    account.accountIneligibleAt = void 0;
    account.accountIneligibleReason = void 0;
    account.eligibilityStateUpdatedAt = timestamp;
    changed = true;
  }
  if (account.accountIneligible === void 0) {
    account.accountIneligible = false;
    changed = true;
  }
  const normalizedReason = reason.trim();
  if (account.verificationRequiredReason !== normalizedReason) {
    account.verificationRequiredReason = normalizedReason;
    changed = true;
  }
  const normalizedUrl = verifyUrl?.trim();
  if (normalizedUrl && account.verificationUrl !== normalizedUrl) {
    account.verificationUrl = normalizedUrl;
    changed = true;
  }
  if (account.enabled !== false) {
    account.enabled = false;
    changed = true;
  }
  return changed;
}
function markStoredAccountIneligible(account, reason) {
  const timestamp = Date.now();
  const normalizedReason = reason.trim() || "Google marked this account as ineligible.";
  const changed = account.accountIneligible !== true || account.accountIneligibleReason !== normalizedReason || account.verificationRequired === true || account.verificationRequiredAt !== void 0 || account.verificationRequiredReason !== void 0 || account.verificationUrl !== void 0 || account.enabled !== false;
  account.accountIneligible = true;
  account.accountIneligibleAt = timestamp;
  account.accountIneligibleReason = normalizedReason;
  account.eligibilityStateUpdatedAt = timestamp;
  account.verificationRequired = false;
  account.verificationRequiredAt = void 0;
  account.verificationRequiredReason = void 0;
  account.verificationUrl = void 0;
  account.enabled = false;
  return changed;
}
function clearStoredAccountAccessBlocks(account, enableIfBlocked = false) {
  const wasVerificationRequired = account.verificationRequired === true;
  const wasIneligible = account.accountIneligible === true;
  const wasAccessBlocked = wasVerificationRequired || wasIneligible;
  let changed = false;
  if (account.verificationRequired !== false) {
    account.verificationRequired = false;
    changed = true;
  }
  if (account.verificationRequiredAt !== void 0) {
    account.verificationRequiredAt = void 0;
    changed = true;
  }
  if (account.verificationRequiredReason !== void 0) {
    account.verificationRequiredReason = void 0;
    changed = true;
  }
  if (account.verificationUrl !== void 0) {
    account.verificationUrl = void 0;
    changed = true;
  }
  if (account.accountIneligible !== false) {
    account.accountIneligible = false;
    changed = true;
  }
  if (account.accountIneligibleAt !== void 0) {
    account.accountIneligibleAt = void 0;
    changed = true;
  }
  if (account.accountIneligibleReason !== void 0) {
    account.accountIneligibleReason = void 0;
    changed = true;
  }
  if (wasIneligible || account.eligibilityStateUpdatedAt !== void 0) {
    account.eligibilityStateUpdatedAt = Date.now();
    changed = true;
  }
  if (enableIfBlocked && wasAccessBlocked && account.enabled === false) {
    account.enabled = true;
    changed = true;
  }
  return { changed, wasAccessBlocked };
}
function findAccountIndex(storage, identity) {
  if (identity.refreshToken) {
    const tokenIndex = storage.accounts.findIndex(
      (account) => account.refreshToken === identity.refreshToken
    );
    if (tokenIndex !== -1) return tokenIndex;
  }
  if (identity.email) {
    return storage.accounts.findIndex(
      (account) => account.email === identity.email
    );
  }
  return -1;
}
function createAccountAccessService({
  client,
  providerId,
  store,
  openBrowser,
  prompt,
  dependencies
}) {
  const refresh = dependencies?.refreshAccessToken ?? refreshAccessToken;
  const transport = dependencies?.transport ?? fetchWithAgyCliTransport;
  const verifyAccount = async (account) => {
    const parsed = parseRefreshParts(account.refreshToken);
    if (!parsed.refreshToken) {
      return {
        status: "error",
        message: "Missing refresh token for selected account."
      };
    }
    const auth = {
      type: "oauth",
      refresh: formatRefreshParts({
        refreshToken: parsed.refreshToken,
        projectId: parsed.projectId ?? account.projectId,
        managedProjectId: parsed.managedProjectId ?? account.managedProjectId
      }),
      access: "",
      expires: 0
    };
    let refreshedAuth;
    try {
      refreshedAuth = await refresh(auth, client, providerId);
    } catch (error) {
      if (error instanceof AntigravityTokenRefreshError) {
        return { status: "error", message: error.message };
      }
      return {
        status: "error",
        message: `Token refresh failed: ${String(error)}`
      };
    }
    if (!refreshedAuth?.access) {
      return {
        status: "error",
        message: "Could not refresh access token for this account."
      };
    }
    const projectId = parsed.managedProjectId ?? parsed.projectId ?? account.managedProjectId ?? account.projectId ?? ANTIGRAVITY_DEFAULT_PROJECT_ID;
    const fingerprintHeaders = buildFingerprintHeaders(getSessionFingerprint());
    const headers = {
      "User-Agent": fingerprintHeaders["User-Agent"] ?? getSessionFingerprint().userAgent,
      Authorization: `Bearer ${refreshedAuth.access}`,
      "Content-Type": "application/json",
      "Accept-Encoding": "gzip"
    };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2e4);
    try {
      const response = await transport(
        `${ANTIGRAVITY_ENDPOINT_PROD}/v1internal:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(buildAccountAccessProbeRequest(projectId))
        },
        { signal: controller.signal }
      );
      return interpretAccountAccessProbeResponse(response);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { status: "error", message: "Verification check timed out." };
      }
      return {
        status: "error",
        message: `Verification check failed: ${String(error)}`
      };
    } finally {
      clearTimeout(timeoutId);
    }
  };
  return {
    loadAccounts: () => store.load(),
    mutateAccounts: (mutate) => store.mutate(mutate),
    clearAccounts: () => store.clear(),
    persistAccountPool: (results, replaceAll) => store.persistAccountPool(results, replaceAll),
    verifyAccount,
    async applyVerificationResult(identity, result) {
      if (result.status !== "verification-required" && result.status !== "ineligible") {
        return;
      }
      await store.mutate((current) => {
        const index = findAccountIndex(current, identity);
        const account = current.accounts[index];
        if (!account) return current;
        if (result.status === "verification-required") {
          markStoredAccountVerificationRequired(
            account,
            result.message,
            result.verifyUrl
          );
        } else {
          markStoredAccountIneligible(account, result.message);
        }
        return current;
      });
    },
    async clearAccessBlocks(identity, enableIfBlocked = false) {
      let outcome = { changed: false, wasAccessBlocked: false };
      await store.mutate((current) => {
        const index = findAccountIndex(current, identity);
        const account = current.accounts[index];
        if (!account) return current;
        outcome = clearStoredAccountAccessBlocks(account, enableIfBlocked);
        return current;
      });
      return outcome;
    },
    selectAccount: (accounts) => prompt.selectAccount(accounts),
    async openVerificationUrl(url) {
      if (!await prompt.confirmOpenVerificationUrl()) return false;
      return openBrowser(url);
    }
  };
}
async function promptAccountIndexForVerification(accounts) {
  const { createInterface: createInterface2 } = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = createInterface2({ input: stdin, output: stdout });
  try {
    console.log("\nSelect an account to verify:");
    for (const account of accounts) {
      const label = account.email || `Account ${account.index + 1}`;
      console.log(`  ${account.index + 1}. ${label}`);
    }
    console.log("");
    while (true) {
      const answer = (await rl.question("Account number (leave blank to cancel): ")).trim();
      if (!answer) return void 0;
      const parsedIndex = Number(answer);
      if (!Number.isInteger(parsedIndex)) {
        console.log("Please enter a valid account number.");
        continue;
      }
      const normalizedIndex = parsedIndex - 1;
      const selected = accounts.find(
        (account) => account.index === normalizedIndex
      );
      if (!selected) {
        console.log("Please enter a number from the list above.");
        continue;
      }
      return selected.index;
    }
  } finally {
    rl.close();
  }
}
async function promptOpenVerificationUrl() {
  const { createInterface: createInterface2 } = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = createInterface2({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question("Open verification URL in your browser now? [Y/n]: ")).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// src/plugin/oauth-methods.ts
import { exec } from "node:child_process";
import { readFileSync as readFileSync8 } from "node:fs";

// src/plugin/auth-drift.ts
function isAccountEnabled(account) {
  return account.enabled !== false;
}
function selectRestorableAccount(storage) {
  if (!storage || storage.accounts.length === 0) {
    return void 0;
  }
  const activeAccount = storage.accounts[storage.activeIndex];
  if (activeAccount && isAccountEnabled(activeAccount)) {
    return activeAccount;
  }
  return storage.accounts.find(isAccountEnabled);
}
function buildAuthFromStoredAccount(account) {
  return {
    type: "oauth",
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId
    }),
    access: "",
    expires: 0
  };
}
function detectAuthStorageDrift(auth, storage) {
  if (!storage || storage.accounts.length === 0) {
    return {
      status: "unavailable",
      reason: "no-account-storage"
    };
  }
  const restorableAccount = selectRestorableAccount(storage);
  if (!restorableAccount) {
    return {
      status: "unavailable",
      reason: "no-enabled-accounts"
    };
  }
  if (!auth) {
    return {
      status: "restorable",
      reason: "missing-opencode-auth",
      account: restorableAccount
    };
  }
  if (!isOAuthAuth(auth)) {
    return {
      status: "restorable",
      reason: "non-oauth-opencode-auth",
      account: restorableAccount
    };
  }
  const authRefreshToken = parseRefreshParts(auth.refresh).refreshToken;
  const matchedAccount = storage.accounts.find(
    (account) => account.refreshToken === authRefreshToken
  );
  if (matchedAccount) {
    return {
      status: "healthy",
      reason: "auth-matches-storage",
      account: matchedAccount
    };
  }
  return {
    status: "drifted",
    reason: "refresh-token-not-in-storage",
    account: restorableAccount
  };
}

// src/plugin/auth-doctor.ts
function isEnabled(account) {
  return account.enabled !== false;
}
function statusFromFindings(findings) {
  if (findings.some((finding) => finding.repair && finding.severity === "error")) {
    return "repairable";
  }
  if (findings.some((finding) => finding.severity === "error")) {
    return "error";
  }
  if (findings.some((finding) => finding.severity === "warning")) {
    return "warning";
  }
  return "ok";
}
function summaryFromStatus(status) {
  switch (status) {
    case "ok":
      return "OpenCode auth and Antigravity account storage are in sync.";
    case "repairable":
      return "Auth drift detected. One or more safe repairs are available.";
    case "warning":
      return "Auth is usable, but one or more accounts need attention.";
    case "error":
      return "Auth state is not usable and no safe automatic repair is available.";
  }
}
function createAuthDoctorReport(input2) {
  const findings = [];
  const drift = detectAuthStorageDrift(input2.auth, input2.storage);
  switch (drift.reason) {
    case "auth-matches-storage":
      findings.push({
        code: "auth-matches-storage",
        severity: "info",
        message: "OpenCode OAuth refresh token exists in Antigravity account storage.",
        accountEmail: drift.account?.email
      });
      break;
    case "missing-opencode-auth":
      findings.push({
        code: "missing-opencode-auth",
        severity: "error",
        message: "OpenCode auth.json has no Google OAuth entry, but Antigravity account storage has a restorable account.",
        repair: "restore-opencode-auth",
        accountEmail: drift.account?.email
      });
      break;
    case "non-oauth-opencode-auth":
      findings.push({
        code: "non-oauth-opencode-auth",
        severity: "error",
        message: "OpenCode Google auth is not OAuth, but Antigravity account storage has a restorable OAuth account.",
        repair: "restore-opencode-auth",
        accountEmail: drift.account?.email
      });
      break;
    case "refresh-token-not-in-storage":
      findings.push({
        code: "refresh-token-not-in-storage",
        severity: "error",
        message: "OpenCode Google OAuth refresh token does not match any stored Antigravity account.",
        repair: "restore-opencode-auth",
        accountEmail: drift.account?.email
      });
      break;
    case "no-account-storage":
      findings.push({
        code: "no-account-storage",
        severity: "error",
        message: "No Antigravity account storage was found."
      });
      break;
    case "no-enabled-accounts":
      findings.push({
        code: "no-enabled-accounts",
        severity: "error",
        message: "Antigravity account storage exists, but all accounts are disabled."
      });
      break;
  }
  const storage = input2.storage;
  if (storage && storage.accounts.length > 0) {
    if (!Number.isInteger(storage.activeIndex) || storage.activeIndex < 0 || storage.activeIndex >= storage.accounts.length) {
      findings.push({
        code: "active-index-out-of-range",
        severity: "error",
        message: `Active account index ${storage.activeIndex} is outside the stored account range.`,
        repair: "clamp-active-index"
      });
    } else {
      const activeAccount = storage.accounts[storage.activeIndex];
      if (activeAccount && !isEnabled(activeAccount) && storage.accounts.some(isEnabled)) {
        findings.push({
          code: "active-account-disabled",
          severity: "error",
          message: "The active account is disabled while another enabled account is available.",
          repair: "select-enabled-account",
          accountEmail: activeAccount.email
        });
      }
    }
    for (const account of storage.accounts) {
      if (account.accountIneligible) {
        findings.push({
          code: "account-ineligible",
          severity: "warning",
          message: account.accountIneligibleReason ?? "Google marked this account as ineligible for Antigravity.",
          repair: "verify-account",
          accountEmail: account.email
        });
      }
      if (account.verificationRequired) {
        findings.push({
          code: "verification-required",
          severity: "warning",
          message: account.verificationRequiredReason ?? "Account requires Google verification before it can be used.",
          repair: "verify-account",
          accountEmail: account.email
        });
      }
    }
  }
  const status = statusFromFindings(findings);
  return {
    status,
    summary: summaryFromStatus(status),
    findings,
    runtime: input2.runtime
  };
}
function formatAuthDoctorReport(report) {
  const lines = [
    "Antigravity auth doctor",
    `Status: ${report.status}`,
    report.summary,
    ""
  ];
  if (report.runtime) {
    lines.push(
      `Antigravity version: ${report.runtime.antigravityVersion} (${report.runtime.antigravityVersionSource})`
    );
    lines.push("");
  }
  for (const finding of report.findings) {
    const repair = finding.repair ? ` | repair: ${finding.repair}` : "";
    const account = finding.accountEmail ? ` | account: ${finding.accountEmail}` : "";
    lines.push(`- [${finding.severity}] ${finding.code}${account}${repair}`);
    lines.push(`  ${finding.message}`);
  }
  return lines.join("\n");
}

// src/plugin/cli.ts
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

// src/plugin/config/updater.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync5, readFileSync as readFileSync6, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir as homedir7 } from "node:os";
import { dirname as dirname7, join as join12 } from "node:path";
var PLUGIN_NAME = "@cortexkit/opencode-antigravity-auth@latest";
var SCHEMA_URL = "https://opencode.ai/config.json";
var OPENCODE_JSON_FILENAME = "opencode.json";
var OPENCODE_JSONC_FILENAME = "opencode.jsonc";
function stripJsonCommentsAndTrailingCommas(json) {
  return json.replace(
    /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g,
    (match, group) => group ? "" : match
  ).replace(/,(\s*[}\]])/g, "$1");
}
function getOpencodeConfigDir() {
  const xdgConfig2 = process.env.XDG_CONFIG_HOME || join12(homedir7(), ".config");
  return join12(xdgConfig2, "opencode");
}
function getOpencodeConfigPath() {
  const configDir = getOpencodeConfigDir();
  const jsoncPath = join12(configDir, OPENCODE_JSONC_FILENAME);
  const jsonPath = join12(configDir, OPENCODE_JSON_FILENAME);
  if (existsSync5(jsoncPath)) {
    return jsoncPath;
  }
  if (existsSync5(jsonPath)) {
    return jsonPath;
  }
  return jsonPath;
}
async function updateOpencodeConfig(options = {}) {
  const configPath = options.configPath ?? getOpencodeConfigPath();
  try {
    let config;
    if (existsSync5(configPath)) {
      const content = readFileSync6(configPath, "utf-8");
      config = JSON.parse(
        stripJsonCommentsAndTrailingCommas(content)
      );
    } else {
      config = {
        $schema: SCHEMA_URL,
        plugin: [],
        provider: {}
      };
    }
    if (!config.$schema) {
      config.$schema = SCHEMA_URL;
    }
    if (!Array.isArray(config.plugin)) {
      config.plugin = [];
    }
    const hasPlugin = config.plugin.some(
      (p) => p.includes("opencode-antigravity-auth")
    );
    if (!hasPlugin) {
      config.plugin.push(PLUGIN_NAME);
    }
    if (!config.provider) {
      config.provider = {};
    }
    if (!config.provider.google) {
      config.provider.google = {};
    }
    config.provider.google.models = { ...OPENCODE_MODEL_DEFINITIONS };
    config.provider.google.whitelist = getAntigravityOpencodeModelIds();
    const configDir = dirname7(configPath);
    if (!existsSync5(configDir)) {
      mkdirSync5(configDir, { recursive: true });
    }
    writeFileSync5(configPath, JSON.stringify(config, null, 2), "utf-8");
    return {
      success: true,
      configPath
    };
  } catch (error) {
    return {
      success: false,
      configPath,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// src/plugin/ui/ansi.ts
var ANSI = {
  // Cursor control
  hide: "\x1B[?25l",
  show: "\x1B[?25h",
  up: (n = 1) => `\x1B[${n}A`,
  down: (n = 1) => `\x1B[${n}B`,
  clearLine: "\x1B[2K",
  clearScreen: "\x1B[2J",
  moveTo: (row, col) => `\x1B[${row};${col}H`,
  // Styles
  cyan: "\x1B[36m",
  green: "\x1B[32m",
  red: "\x1B[31m",
  yellow: "\x1B[33m",
  dim: "\x1B[2m",
  bold: "\x1B[1m",
  reset: "\x1B[0m",
  inverse: "\x1B[7m"
};
function parseKey(data) {
  const s = data.toString();
  if (s === "\x1B[A" || s === "\x1BOA") return "up";
  if (s === "\x1B[B" || s === "\x1BOB") return "down";
  if (s === "\r" || s === "\n") return "enter";
  if (s === "") return "escape";
  if (s === "\x1B") return "escape-start";
  return null;
}
function isTTY() {
  return Boolean(process.stdin.isTTY);
}

// src/plugin/ui/select.ts
var ESCAPE_TIMEOUT_MS = 50;
var ANSI_REGEX = /\x1b\[[0-9;]*m/g;
var ANSI_LEADING_REGEX = /^\x1b\[[0-9;]*m/;
function stripAnsi(input2) {
  return input2.replace(ANSI_REGEX, "");
}
function truncateAnsi(input2, maxVisibleChars) {
  if (maxVisibleChars <= 0) return "";
  const visible = stripAnsi(input2);
  if (visible.length <= maxVisibleChars) return input2;
  const suffix = maxVisibleChars >= 3 ? "..." : ".".repeat(maxVisibleChars);
  const keep = Math.max(0, maxVisibleChars - suffix.length);
  let out = "";
  let i = 0;
  let kept = 0;
  while (i < input2.length && kept < keep) {
    if (input2[i] === "\x1B") {
      const m = input2.slice(i).match(ANSI_LEADING_REGEX);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += input2[i];
    i += 1;
    kept += 1;
  }
  if (out.includes("\x1B[")) {
    return `${out}${ANSI.reset}${suffix}`;
  }
  return out + suffix;
}
function getColorCode(color) {
  switch (color) {
    case "red":
      return ANSI.red;
    case "green":
      return ANSI.green;
    case "yellow":
      return ANSI.yellow;
    case "cyan":
      return ANSI.cyan;
    default:
      return "";
  }
}
async function select(items, options) {
  if (!isTTY()) {
    throw new Error("Interactive select requires a TTY terminal");
  }
  if (items.length === 0) {
    throw new Error("No menu items provided");
  }
  const isSelectable = (i) => !i.disabled && !i.separator && i.kind !== "heading";
  const enabledItems = items.filter(isSelectable);
  if (enabledItems.length === 0) {
    throw new Error("All items disabled");
  }
  if (enabledItems.length === 1) {
    return enabledItems[0].value;
  }
  const { message, subtitle } = options;
  const { stdin, stdout } = process;
  let cursor = items.findIndex(isSelectable);
  if (cursor === -1) cursor = 0;
  let escapeTimeout = null;
  let isCleanedUp = false;
  let renderedLines = 0;
  const render = () => {
    const columns = stdout.columns ?? 80;
    const rows = stdout.rows ?? 24;
    const shouldClearScreen = options.clearScreen === true;
    const previousRenderedLines = renderedLines;
    if (shouldClearScreen) {
      stdout.write(ANSI.clearScreen + ANSI.moveTo(1, 1));
    } else if (previousRenderedLines > 0) {
      stdout.write(ANSI.up(previousRenderedLines));
    }
    let linesWritten = 0;
    const writeLine = (line) => {
      stdout.write(`${ANSI.clearLine}${line}
`);
      linesWritten += 1;
    };
    const subtitleLines = subtitle ? 3 : 0;
    const fixedLines = 1 + subtitleLines + 2;
    const maxVisibleItems = Math.max(
      1,
      Math.min(items.length, rows - fixedLines - 1)
    );
    let windowStart = 0;
    let windowEnd = items.length;
    if (items.length > maxVisibleItems) {
      windowStart = cursor - Math.floor(maxVisibleItems / 2);
      windowStart = Math.max(
        0,
        Math.min(windowStart, items.length - maxVisibleItems)
      );
      windowEnd = windowStart + maxVisibleItems;
    }
    const visibleItems = items.slice(windowStart, windowEnd);
    const headerMessage = truncateAnsi(message, Math.max(1, columns - 4));
    writeLine(`${ANSI.dim}\u250C  ${ANSI.reset}${headerMessage}`);
    if (subtitle) {
      writeLine(`${ANSI.dim}\u2502${ANSI.reset}`);
      const sub = truncateAnsi(subtitle, Math.max(1, columns - 4));
      writeLine(`${ANSI.cyan}\u25C6${ANSI.reset}  ${sub}`);
      writeLine("");
    }
    for (let i = 0; i < visibleItems.length; i++) {
      const itemIndex = windowStart + i;
      const item = visibleItems[i];
      if (!item) continue;
      if (item.separator) {
        writeLine(`${ANSI.dim}\u2502${ANSI.reset}`);
        continue;
      }
      if (item.kind === "heading") {
        const heading = truncateAnsi(
          `${ANSI.dim}${ANSI.bold}${item.label}${ANSI.reset}`,
          Math.max(1, columns - 6)
        );
        writeLine(`${ANSI.cyan}\u2502${ANSI.reset}  ${heading}`);
        continue;
      }
      const isSelected = itemIndex === cursor;
      const colorCode = getColorCode(item.color);
      let labelText;
      if (item.disabled) {
        labelText = `${ANSI.dim}${item.label} (unavailable)${ANSI.reset}`;
      } else if (isSelected) {
        labelText = colorCode ? `${colorCode}${item.label}${ANSI.reset}` : item.label;
        if (item.hint) labelText += ` ${ANSI.dim}${item.hint}${ANSI.reset}`;
      } else {
        labelText = colorCode ? `${ANSI.dim}${colorCode}${item.label}${ANSI.reset}` : `${ANSI.dim}${item.label}${ANSI.reset}`;
        if (item.hint) labelText += ` ${ANSI.dim}${item.hint}${ANSI.reset}`;
      }
      labelText = truncateAnsi(labelText, Math.max(1, columns - 8));
      if (isSelected) {
        writeLine(
          `${ANSI.cyan}\u2502${ANSI.reset}  ${ANSI.green}\u25CF${ANSI.reset} ${labelText}`
        );
      } else {
        writeLine(
          `${ANSI.cyan}\u2502${ANSI.reset}  ${ANSI.dim}\u25CB${ANSI.reset} ${labelText}`
        );
      }
    }
    const windowHint = items.length > visibleItems.length ? ` (${windowStart + 1}-${windowEnd}/${items.length})` : "";
    const helpText = options.help ?? `Up/Down to select | Enter: confirm | Esc: back${windowHint}`;
    const help = truncateAnsi(helpText, Math.max(1, columns - 6));
    writeLine(`${ANSI.cyan}\u2502${ANSI.reset}  ${ANSI.dim}${help}${ANSI.reset}`);
    writeLine(`${ANSI.cyan}\u2514${ANSI.reset}`);
    if (!shouldClearScreen && previousRenderedLines > linesWritten) {
      const extra = previousRenderedLines - linesWritten;
      for (let i = 0; i < extra; i++) {
        writeLine("");
      }
    }
    renderedLines = linesWritten;
  };
  return new Promise((resolve3) => {
    const wasRaw = stdin.isRaw ?? false;
    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      if (escapeTimeout) {
        clearTimeout(escapeTimeout);
        escapeTimeout = null;
      }
      try {
        stdin.removeListener("data", onKey);
        stdin.setRawMode(wasRaw);
        stdin.pause();
        stdout.write(ANSI.show);
      } catch {
      }
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    };
    const onSignal = () => {
      cleanup();
      resolve3(null);
    };
    const finishWithValue = (value) => {
      cleanup();
      resolve3(value);
    };
    const findNextSelectable = (from, direction) => {
      if (items.length === 0) return from;
      let next = from;
      do {
        next = (next + direction + items.length) % items.length;
      } while (items[next]?.disabled || items[next]?.separator || items[next]?.kind === "heading");
      return next;
    };
    const onKey = (data) => {
      if (escapeTimeout) {
        clearTimeout(escapeTimeout);
        escapeTimeout = null;
      }
      const action = parseKey(data);
      switch (action) {
        case "up":
          cursor = findNextSelectable(cursor, -1);
          render();
          return;
        case "down":
          cursor = findNextSelectable(cursor, 1);
          render();
          return;
        case "enter":
          finishWithValue(items[cursor]?.value ?? null);
          return;
        case "escape":
          finishWithValue(null);
          return;
        case "escape-start":
          escapeTimeout = setTimeout(() => {
            finishWithValue(null);
          }, ESCAPE_TIMEOUT_MS);
          return;
        default:
          return;
      }
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      stdin.setRawMode(true);
    } catch {
      cleanup();
      resolve3(null);
      return;
    }
    stdin.resume();
    stdout.write(ANSI.hide);
    render();
    stdin.on("data", onKey);
  });
}

// src/plugin/ui/confirm.ts
async function confirm(message, defaultYes = false) {
  const items = defaultYes ? [
    { label: "Yes", value: true },
    { label: "No", value: false }
  ] : [
    { label: "No", value: false },
    { label: "Yes", value: true }
  ];
  const result = await select(items, { message });
  return result ?? false;
}

// src/plugin/ui/quota-status.ts
function formatWaitDuration(ms) {
  if (ms < 1e3) return `${ms}ms`;
  const seconds = Math.ceil(ms / 1e3);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
function classifyGroupStatus(group) {
  if (!group) {
    return { label: "READY" };
  }
  const remaining = group.remainingFraction;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) {
    return { label: "READY" };
  }
  if (remaining <= 0) {
    const waitMs = parseResetTimeToMs(group.resetTime);
    if (waitMs !== null && waitMs > 0) {
      return { label: "EXHAUSTED", waitMs };
    }
    return { label: "READY" };
  }
  if (remaining < 0.2) {
    return { label: "LOW" };
  }
  return { label: "READY" };
}
function parseResetTimeToMs(resetTime) {
  if (!resetTime) return null;
  const timestamp = Date.parse(resetTime);
  if (!Number.isFinite(timestamp)) return null;
  const ms = timestamp - Date.now();
  return ms > 0 ? ms : null;
}
function buildCooldownStatus(cooldownMs, reason) {
  return {
    label: "COOLDOWN",
    waitMs: cooldownMs > 0 ? cooldownMs : void 0,
    cooldownReason: reason
  };
}
function formatQuotaStatusBadge(status) {
  switch (status.label) {
    case "READY":
      return `${ANSI.green}[READY]${ANSI.reset}`;
    case "LOW":
      return `${ANSI.yellow}[LOW]${ANSI.reset}`;
    case "WAIT": {
      const suffix = status.waitMs ? ` ${formatWaitDuration(status.waitMs)}` : "";
      return `${ANSI.yellow}[WAIT${suffix}]${ANSI.reset}`;
    }
    case "EXHAUSTED": {
      const suffix = status.waitMs ? ` resets in ${formatWaitDuration(status.waitMs)}` : "";
      return `${ANSI.red}[EXHAUSTED${suffix}]${ANSI.reset}`;
    }
    case "COOLDOWN": {
      const parts = ["COOLDOWN"];
      if (status.cooldownReason) {
        parts.push(status.cooldownReason);
      }
      if (status.waitMs) {
        parts.push(formatWaitDuration(status.waitMs));
      }
      return `${ANSI.red}[${parts.join(" ")}]${ANSI.reset}`;
    }
  }
}
function formatQuotaStatusPlain(status) {
  switch (status.label) {
    case "READY":
      return "READY";
    case "LOW":
      return "LOW";
    case "WAIT": {
      const suffix = status.waitMs ? ` ${formatWaitDuration(status.waitMs)}` : "";
      return `WAIT${suffix}`;
    }
    case "EXHAUSTED": {
      const suffix = status.waitMs ? ` resets in ${formatWaitDuration(status.waitMs)}` : "";
      return `EXHAUSTED${suffix}`;
    }
    case "COOLDOWN": {
      const parts = ["COOLDOWN"];
      if (status.cooldownReason) {
        parts.push(status.cooldownReason);
      }
      if (status.waitMs) {
        parts.push(formatWaitDuration(status.waitMs));
      }
      return parts.join(" ");
    }
  }
}
function classifyOverallQuotaHealth(cachedQuota) {
  if (!cachedQuota) {
    return { health: "unknown" };
  }
  const QUOTA_KEYS2 = ["gemini", "non-gemini"];
  let groupsWithData = 0;
  let exhaustedCount = 0;
  let maxResetMs;
  for (const key of QUOTA_KEYS2) {
    const value = cachedQuota[key]?.remainingFraction;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    groupsWithData++;
    if (value <= 0) {
      const resetMs = parseResetTimeToMs(cachedQuota[key]?.resetTime);
      if (resetMs !== null && resetMs > 0) {
        exhaustedCount++;
        if (maxResetMs === void 0 || resetMs > maxResetMs) {
          maxResetMs = resetMs;
        }
      }
    }
  }
  if (groupsWithData === 0) return { health: "unknown" };
  if (exhaustedCount === groupsWithData)
    return { health: "exhausted", maxResetMs };
  if (exhaustedCount > 0) return { health: "partial", maxResetMs };
  return { health: "available" };
}
function formatCachedQuotaWithStatus(cachedQuota) {
  if (!cachedQuota) {
    return void 0;
  }
  const overall = classifyOverallQuotaHealth(cachedQuota);
  if (overall.health === "exhausted") {
    return void 0;
  }
  const entries = [
    { key: "gemini", label: "Gemini" },
    { key: "non-gemini", label: "Non-Gemini" }
  ].flatMap(({ key, label }) => {
    const value = cachedQuota[key]?.remainingFraction;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return [];
    }
    const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
    const status = classifyGroupStatus(cachedQuota[key]);
    if (status.label === "READY" && pct >= 100) {
      return [];
    }
    if (status.label === "READY") {
      return [`${label} ${pct}%`];
    }
    if (status.label === "EXHAUSTED") {
      return [`${label} ${formatQuotaStatusPlain(status).toLowerCase()}`];
    }
    return [`${label} ${formatQuotaStatusPlain(status).toLowerCase()} ${pct}%`];
  });
  return entries.length > 0 ? entries.join(", ") : void 0;
}

// src/plugin/ui/auth-menu.ts
function formatRelativeTime(timestamp) {
  if (!timestamp) return "never";
  const days = Math.floor((Date.now() - timestamp) / 864e5);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(timestamp).toLocaleDateString();
}
function formatDate(timestamp) {
  if (!timestamp) return "unknown";
  return new Date(timestamp).toLocaleDateString();
}
function getStatusBadge(status, account) {
  if (account?.cooldownMs !== void 0 && account.cooldownMs > 0) {
    const cooldownStatus = buildCooldownStatus(
      account.cooldownMs,
      account.cooldownReason
    );
    return ` ${formatQuotaStatusBadge(cooldownStatus)}`;
  }
  if (status === "active" && account?.cachedQuota) {
    const overall = classifyOverallQuotaHealth(account.cachedQuota);
    if (overall.health === "exhausted") {
      const suffix = overall.maxResetMs ? ` resets in ${formatWaitDuration(overall.maxResetMs)}` : "";
      return ` ${ANSI.red}[exhausted${suffix}]${ANSI.reset}`;
    }
    if (overall.health === "partial") {
      return ` ${ANSI.yellow}[limited]${ANSI.reset}`;
    }
  }
  switch (status) {
    case "active":
      return ` ${ANSI.green}[active]${ANSI.reset}`;
    case "rate-limited":
      return ` ${ANSI.yellow}[rate-limited]${ANSI.reset}`;
    case "expired":
      return ` ${ANSI.red}[expired]${ANSI.reset}`;
    case "verification-required":
      return ` ${ANSI.red}[needs verification]${ANSI.reset}`;
    case "ineligible":
      return ` ${ANSI.red}[ineligible]${ANSI.reset}`;
    default:
      return "";
  }
}
function getAccountTier(acc) {
  if (acc.isCurrentAccount) return 0;
  if (acc.enabled === false) return 6;
  if (acc.status === "active") {
    const overall = classifyOverallQuotaHealth(acc.cachedQuota);
    if (overall.health === "exhausted") return 3;
    if (overall.health === "partial") return 2;
    return 1;
  }
  if (acc.status === "rate-limited") return 4;
  return 5;
}
function getHealthLabel(acc) {
  if (acc.enabled === false) return "disabled";
  if (acc.status === "active") {
    const overall = classifyOverallQuotaHealth(acc.cachedQuota);
    if (overall.health === "exhausted") return "exhausted";
    if (overall.health === "partial") return "limited";
    return "active";
  }
  if (acc.status === "rate-limited") return "rate-limited";
  if (acc.status === "expired") return "expired";
  return "other";
}
var QUOTA_KEYS = [
  { key: "gemini", label: "Gemini" },
  { key: "non-gemini", label: "Non-Gemini" }
];
function parseResetTimeToMs2(resetTime) {
  if (!resetTime) return null;
  const timestamp = Date.parse(resetTime);
  if (!Number.isFinite(timestamp)) return null;
  const ms = timestamp - Date.now();
  return ms > 0 ? ms : null;
}
function buildModelBreakdown(accounts) {
  const results = [];
  for (const { key, label } of QUOTA_KEYS) {
    let availableCount = 0;
    let exhaustedCount = 0;
    let maxResetMs;
    for (const acc of accounts) {
      if (acc.enabled === false) continue;
      if (acc.cachedPerModelQuota && acc.cachedPerModelQuota.length > 0) {
        const modelsInGroup = acc.cachedPerModelQuota.filter(
          (m) => m.group === key
        );
        if (modelsInGroup.length === 0) continue;
        const allExhausted = modelsInGroup.every(
          (m) => m.remainingFraction <= 0
        );
        if (allExhausted) {
          const freshExhausted = modelsInGroup.some((m) => {
            const resetMs = parseResetTimeToMs2(m.resetTime);
            return resetMs !== null && resetMs > 0;
          });
          if (freshExhausted) {
            exhaustedCount++;
            for (const m of modelsInGroup) {
              const resetMs = parseResetTimeToMs2(m.resetTime);
              if (resetMs !== null && resetMs > 0 && (maxResetMs === void 0 || resetMs > maxResetMs)) {
                maxResetMs = resetMs;
              }
            }
          } else {
            availableCount++;
          }
        } else {
          availableCount++;
        }
      } else {
        const group = acc.cachedQuota?.[key];
        if (!group || typeof group.remainingFraction !== "number") continue;
        if (group.remainingFraction <= 0) {
          const resetMs = parseResetTimeToMs2(group.resetTime);
          if (resetMs !== null && resetMs > 0) {
            exhaustedCount++;
            if (maxResetMs === void 0 || resetMs > maxResetMs) {
              maxResetMs = resetMs;
            }
          } else {
            availableCount++;
          }
        } else {
          availableCount++;
        }
      }
    }
    if (exhaustedCount > 0 || availableCount > 0) {
      const parts = [];
      if (availableCount > 0) parts.push(`${availableCount} available`);
      if (exhaustedCount > 0) {
        const resetSuffix = maxResetMs !== void 0 ? ` ~${formatWaitDuration(maxResetMs)}` : "";
        parts.push(`${exhaustedCount} exhausted${resetSuffix}`);
      }
      results.push(`${label}: ${parts.join(", ")}`);
    }
  }
  return results;
}
function buildAccountSummary(accounts) {
  const counts = {};
  for (const acc of accounts) {
    const label = getHealthLabel(acc);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  const order = [
    "active",
    "limited",
    "exhausted",
    "rate-limited",
    "expired",
    "disabled",
    "other"
  ];
  const parts = order.filter((label) => (counts[label] ?? 0) > 0).map((label) => `${counts[label]} ${label}`);
  const modelBreakdown = buildModelBreakdown(accounts);
  const countsLine = parts.length > 0 ? `Accounts (${parts.join(", ")})` : "Accounts";
  const modelLine = modelBreakdown.length > 0 ? modelBreakdown.join(", ") : "";
  return { countsLine, modelLine };
}
function buildAccountHint(account) {
  if (account.quotaSummary) {
    const overall = classifyOverallQuotaHealth(account.cachedQuota);
    if (overall.health === "partial") {
      return account.quotaSummary.replace(/\s*resets in \S+/g, "");
    }
    return account.quotaSummary;
  }
  if (account.lastUsed) {
    return `used ${formatRelativeTime(account.lastUsed)}`;
  }
  return "";
}
function buildAccountMenuItems(accounts) {
  const sorted = accounts.slice().sort((a, b) => getAccountTier(a) - getAccountTier(b));
  const items = [];
  let prevTier = -1;
  for (let i = 0; i < sorted.length; i++) {
    const account = sorted[i];
    const tier = getAccountTier(account);
    if (prevTier !== -1 && tier !== prevTier) {
      items.push({ label: "", value: { type: "cancel" }, separator: true });
    }
    prevTier = tier;
    const displayNum = i + 1;
    const statusBadge = account.isCurrentAccount ? "" : getStatusBadge(account.status, account);
    const currentBadge = account.isCurrentAccount ? ` ${ANSI.cyan}[current]${ANSI.reset}` : "";
    const disabledBadge = account.enabled === false ? ` ${ANSI.red}[disabled]${ANSI.reset}` : "";
    const baseLabel = account.email || `Account ${displayNum}`;
    const numbered = `${displayNum}. ${baseLabel}`;
    const fullLabel = `${numbered}${currentBadge}${statusBadge}${disabledBadge}`;
    items.push({
      label: fullLabel,
      hint: buildAccountHint(account),
      value: { type: "select-account", account }
    });
  }
  return items;
}
async function showAuthMenu(accounts) {
  const items = [
    { label: "Actions", value: { type: "cancel" }, kind: "heading" },
    { label: "Add account", value: { type: "add" }, color: "cyan" },
    { label: "Auth current", value: { type: "current" }, color: "cyan" },
    { label: "Check quotas", value: { type: "check" }, color: "cyan" },
    { label: "Repair auth", value: { type: "repair" }, color: "yellow" },
    { label: "Auth doctor", value: { type: "doctor" }, color: "cyan" },
    { label: "Verify one account", value: { type: "verify" }, color: "cyan" },
    {
      label: "Verify all accounts",
      value: { type: "verify-all" },
      color: "cyan"
    },
    {
      label: "Configure models in opencode.json",
      value: { type: "configure-models" },
      color: "cyan"
    },
    { label: "", value: { type: "cancel" }, separator: true },
    ...(() => {
      const { countsLine, modelLine } = buildAccountSummary(accounts);
      const lines = [
        { label: countsLine, value: { type: "cancel" }, kind: "heading" }
      ];
      if (modelLine) {
        lines.push({
          label: modelLine,
          value: { type: "cancel" },
          kind: "heading"
        });
      }
      return lines;
    })(),
    ...buildAccountMenuItems(accounts),
    { label: "", value: { type: "cancel" }, separator: true },
    { label: "Danger zone", value: { type: "cancel" }, kind: "heading" },
    {
      label: "Delete all accounts",
      value: { type: "delete-all" },
      color: "red"
    }
  ];
  while (true) {
    const result = await select(items, {
      message: "Google accounts (Antigravity)",
      subtitle: "Select an action or account",
      clearScreen: true
    });
    if (!result) return { type: "cancel" };
    if (result.type === "delete-all") {
      const confirmed = await confirm(
        "Delete ALL accounts? This cannot be undone."
      );
      if (!confirmed) continue;
    }
    return result;
  }
}
function formatFingerprintReason(reason) {
  switch (reason) {
    case "initial":
      return "initial";
    case "regenerated":
      return "regenerated";
    case "restored":
      return "restored";
  }
}
async function showFingerprintHistory(history, accountLabel) {
  const items = [
    { label: "Back", value: null },
    { label: "", value: null, separator: true },
    { label: "Fingerprint history", value: null, kind: "heading" },
    ...history.map((entry, index) => {
      const deviceShort = entry.fingerprint.deviceId.slice(0, 8);
      const reasonBadge = `${ANSI.dim}[${formatFingerprintReason(entry.reason)}]${ANSI.reset}`;
      const label = `${index + 1}. ${deviceShort}... ${reasonBadge}`;
      const hint = formatRelativeTime(entry.timestamp);
      return {
        label,
        hint,
        value: index,
        color: "cyan"
      };
    })
  ];
  const result = await select(items, {
    message: `Restore fingerprint \u2014 ${accountLabel}`,
    subtitle: "Select a previous fingerprint to restore",
    clearScreen: true
  });
  return result ?? null;
}
async function showAccountDetails(account) {
  const label = account.email || `Account ${account.index + 1}`;
  const badge = getStatusBadge(account.status, account);
  const disabledBadge = account.enabled === false ? ` ${ANSI.red}[disabled]${ANSI.reset}` : "";
  const header = `${label}${badge}${disabledBadge}`;
  const subtitleParts = [
    `Added: ${formatDate(account.addedAt)}`,
    `Last used: ${formatRelativeTime(account.lastUsed)}`
  ];
  const hasHistory = (account.fingerprintHistory?.length ?? 0) > 0;
  while (true) {
    const menuItems = [
      { label: "Back", value: "back" }
    ];
    if (!account.isCurrentAccount) {
      menuItems.push({
        label: "Switch to this account",
        value: "switch-account",
        color: "green"
      });
    }
    menuItems.push(
      {
        label: "Verify account access",
        value: "verify",
        color: "cyan"
      },
      {
        label: account.enabled === false ? "Enable account" : "Disable account",
        value: "toggle",
        color: account.enabled === false ? "green" : "yellow"
      },
      { label: "Refresh token", value: "refresh", color: "cyan" }
    );
    if (hasHistory) {
      menuItems.push({
        label: `Restore fingerprint (${account.fingerprintHistory?.length} saved)`,
        value: "restore-fingerprint",
        color: "cyan"
      });
    }
    menuItems.push({
      label: "Delete this account",
      value: "delete",
      color: "red"
    });
    const result = await select(menuItems, {
      message: header,
      subtitle: subtitleParts.join(" | "),
      clearScreen: true
    });
    if (result === "delete") {
      const confirmed = await confirm(`Delete ${label}?`);
      if (!confirmed) continue;
    }
    if (result === "refresh") {
      const confirmed = await confirm(`Re-authenticate ${label}?`);
      if (!confirmed) continue;
    }
    return result ?? "cancel";
  }
}

// src/plugin/cli.ts
async function promptProjectId() {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      "Project ID (leave blank to use your default project): "
    );
    return answer.trim();
  } finally {
    rl.close();
  }
}
async function promptAddAnotherAccount(currentCount) {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      `Add another account? (${currentCount} added) (y/n): `
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}
async function promptLoginModeFallback(existingAccounts) {
  const rl = createInterface({ input, output });
  try {
    console.log(`
${existingAccounts.length} account(s) saved:`);
    for (const acc of existingAccounts) {
      const label = acc.email || `Account ${acc.index + 1}`;
      console.log(`  ${acc.index + 1}. ${label}`);
    }
    console.log("");
    while (true) {
      const answer = await rl.question(
        "(a)dd new, (f)resh start, (c)heck quotas, auth (d)octor, (v)erify account, (va) verify all? [a/f/c/d/v/va]: "
      );
      const normalized = answer.trim().toLowerCase();
      if (normalized === "a" || normalized === "add") {
        return { mode: "add" };
      }
      if (normalized === "f" || normalized === "fresh") {
        return { mode: "fresh" };
      }
      if (normalized === "c" || normalized === "check") {
        return { mode: "check" };
      }
      if (normalized === "d" || normalized === "doctor" || normalized === "auth-doctor") {
        return { mode: "doctor" };
      }
      if (normalized === "v" || normalized === "verify") {
        return { mode: "verify" };
      }
      if (normalized === "va" || normalized === "verify-all" || normalized === "all") {
        return { mode: "verify-all", verifyAll: true };
      }
      console.log("Please enter 'a', 'f', 'c', 'd', 'v', or 'va'.");
    }
  } finally {
    rl.close();
  }
}
async function promptLoginMode(existingAccounts) {
  if (!isTTY()) {
    return promptLoginModeFallback(existingAccounts);
  }
  const accounts = existingAccounts.map((acc) => ({
    email: acc.email,
    index: acc.index,
    addedAt: acc.addedAt,
    lastUsed: acc.lastUsed,
    status: acc.status,
    isCurrentAccount: acc.isCurrentAccount,
    enabled: acc.enabled,
    quotaSummary: acc.quotaSummary,
    cooldownMs: acc.cooldownMs,
    cooldownReason: acc.cooldownReason,
    cachedQuota: acc.cachedQuota,
    cachedPerModelQuota: acc.cachedPerModelQuota,
    fingerprintHistory: acc.fingerprintHistory
  }));
  console.log("");
  while (true) {
    const action = await showAuthMenu(accounts);
    switch (action.type) {
      case "add":
        return { mode: "add" };
      case "check":
        return { mode: "check" };
      case "doctor":
        return { mode: "doctor" };
      case "repair":
        return { mode: "repair" };
      case "current":
        return { mode: "current" };
      case "verify":
        return { mode: "verify" };
      case "verify-all":
        return { mode: "verify-all", verifyAll: true };
      case "select-account": {
        const accountAction = await showAccountDetails(action.account);
        if (accountAction === "delete") {
          return { mode: "add", deleteAccountIndex: action.account.index };
        }
        if (accountAction === "refresh") {
          return { mode: "add", refreshAccountIndex: action.account.index };
        }
        if (accountAction === "toggle") {
          return { mode: "manage", toggleAccountIndex: action.account.index };
        }
        if (accountAction === "verify") {
          return { mode: "verify", verifyAccountIndex: action.account.index };
        }
        if (accountAction === "switch-account") {
          const accountLabel = action.account.email || `Account ${action.account.index + 1}`;
          console.log(
            `
\u2713 Switched to ${accountLabel}. Restart OpenCode for changes to take effect.
`
          );
          return {
            mode: "switch-account",
            switchAccountIndex: action.account.index
          };
        }
        if (accountAction === "restore-fingerprint") {
          const history = action.account.fingerprintHistory;
          if (!history || history.length === 0) continue;
          const accountLabel = action.account.email || `Account ${action.account.index + 1}`;
          const historyIndex = await showFingerprintHistory(
            history,
            accountLabel
          );
          if (historyIndex === null) continue;
          return {
            mode: "restore-fingerprint",
            restoreFingerprintAccountIndex: action.account.index,
            restoreFingerprintHistoryIndex: historyIndex
          };
        }
        continue;
      }
      case "delete-all":
        return { mode: "fresh", deleteAll: true };
      case "configure-models": {
        const result = await updateOpencodeConfig();
        if (result.success) {
          console.log(`
\u2713 Models configured in ${result.configPath}
`);
        } else {
          console.log(`
\u2717 Failed to configure models: ${result.error}
`);
        }
        continue;
      }
      case "cancel":
        return { mode: "cancel" };
    }
  }
}

// src/plugin/oauth-login.ts
function expectedState(authorizationUrl) {
  try {
    return new URL(authorizationUrl).searchParams.get("state") ?? "";
  } catch {
    return "";
  }
}
function callbackParams(callbackUrl, expected) {
  const code = callbackUrl.searchParams.get("code");
  const state = callbackUrl.searchParams.get("state");
  if (!code || !state) throw new Error("Missing code or state in callback URL");
  if (expected && state !== expected) throw new Error("OAuth state mismatch");
  return { code, state };
}
async function performOAuthLogin(request, deps) {
  const listener = await deps.startListener();
  try {
    const authorization = await deps.authorize(request.projectId ?? "");
    if (!request.noBrowser && !request.isHeadless) {
      await deps.openBrowser(authorization.url);
    }
    const params = callbackParams(
      await listener.waitForCallback(),
      expectedState(authorization.url)
    );
    const result = await deps.exchange(params.code, params.state);
    if (result.type === "failed") throw new Error(result.error);
    await deps.upsert(result);
    request.accounts.push(result);
    return result;
  } finally {
    await listener.close().catch(() => {
    });
  }
}

// src/plugin/quota.ts
var log7 = createLogger2("quota");
function createOpenCodeQuotaManager(client, providerId = ANTIGRAVITY_PROVIDER_ID, options = {}) {
  const fetchAccountQuota = makeFetchAccountQuota(
    client,
    providerId,
    options.fetchVia
  );
  const manager = createQuotaManager({
    fetchAccountQuota,
    keyOf: options.keyOf ?? defaultKeyOf,
    baseBackoffMs: options.baseBackoffMs,
    maxBackoffMs: options.maxBackoffMs,
    fetchTimeoutMs: options.fetchTimeoutMs
  });
  const originalRefreshAccount = manager.refreshAccount;
  const originalRefreshAccounts = manager.refreshAccounts;
  const getAccountsForSidebar = options.getAccountsForSidebar;
  const getActiveIndexByFamily = options.getActiveIndexByFamily;
  let disposed = false;
  const inFlight = /* @__PURE__ */ new Set();
  const pushAfterRefresh = async (account) => {
    if (!getAccountsForSidebar) return;
    await pushSidebarQuotaSnapshot(
      getAccountsForSidebar,
      manager.getBackoffUntil(account),
      getActiveIndexByFamily
    ).catch(() => {
    });
  };
  const track = (operation) => {
    inFlight.add(operation);
    void operation.then(
      () => inFlight.delete(operation),
      () => inFlight.delete(operation)
    );
    return operation;
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await manager.dispose();
    await Promise.allSettled(inFlight);
  };
  return {
    ...manager,
    async refreshAccount(account, refreshOptions) {
      const shouldPush = !disposed;
      return track(
        (async () => {
          const result = await originalRefreshAccount(account, refreshOptions);
          if (shouldPush) await pushAfterRefresh(account);
          return result;
        })()
      );
    },
    async refreshAccounts(accounts, refreshOptions) {
      const shouldPush = !disposed;
      return track(
        (async () => {
          const results = await originalRefreshAccounts(
            accounts,
            refreshOptions
          );
          const lastAccount = accounts[accounts.length - 1];
          if (shouldPush && lastAccount) await pushAfterRefresh(lastAccount);
          return results;
        })()
      );
    },
    dispose
  };
}
async function pushSidebarQuotaSnapshot(getAccounts, backoffUntil = 0, getActiveIndexByFamily) {
  const accounts = getAccounts();
  if (!accounts || accounts.length === 0) return;
  const activeByFamily = getActiveIndexByFamily?.() ?? null;
  try {
    await setSidebarMachineState(
      buildSidebarMachineStateFromAccounts(
        accounts.map((entry) => ({
          index: entry.index,
          label: entry.label,
          enabled: entry.enabled,
          current: activeByFamily ? isAccountCurrent(entry.index, activeByFamily) : false,
          coolingDownUntil: entry.coolingDownUntil,
          cachedQuota: entry.cachedQuota,
          cachedQuotaAccountId: entry.cachedQuotaAccountId,
          currentQuotaAccountId: entry.currentQuotaAccountId,
          healthScore: getHealthTracker().getScore(entry.index),
          tier: entry.tier
        })),
        {
          checkedAt: Date.now(),
          quotaBackoffUntil: backoffUntil > 0 ? backoffUntil : void 0
        }
      )
    );
  } catch (error) {
    log7.debug("sidebar-quota-write-failed", { error: String(error) });
  }
}
async function fetchLegacyModelsFallback(options) {
  try {
    const modelsResponse = await fetchAvailableModels({
      accessToken: options.accessToken,
      projectId: options.projectId,
      endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
      userAgent: buildAntigravityHarnessUserAgent(),
      timeoutMs: 1e4,
      ...options.fetchVia ? { fetchVia: options.fetchVia } : {}
    });
    if (modelsResponse.models) {
      return aggregateQuota(modelsResponse.models);
    }
    return {
      groups: {},
      modelCount: 0,
      error: "Failed to fetch Antigravity quota (legacy fallback)"
    };
  } catch {
    return {
      groups: {},
      modelCount: 0,
      error: "Failed to fetch Antigravity quota"
    };
  }
}
function makeFetchAccountQuota(client, providerId, fetchVia) {
  return async (account, signal) => {
    const index = 0;
    const disabled = account.enabled === false;
    if (disabled) {
      return {
        index,
        email: account.email,
        status: "disabled",
        disabled: true
      };
    }
    if (signal.aborted) {
      return {
        index,
        email: account.email,
        status: "error",
        error: signal.reason instanceof Error ? signal.reason.message : "aborted"
      };
    }
    let auth = buildAuthFromAccount(account);
    let rotatedRefresh;
    try {
      if (accessTokenExpired(auth)) {
        const refreshed = await refreshAccessToken(
          auth,
          client,
          providerId
        );
        if (!refreshed) {
          throw new Error("Token refresh failed");
        }
        if (refreshed.refresh !== auth.refresh) {
          rotatedRefresh = refreshed.refresh;
        }
        auth = refreshed;
      }
      const projectContext = await ensureProjectContext(auth);
      auth = projectContext.auth;
      const updatedAccount = applyAccountUpdates(
        account,
        auth,
        projectContext.capturedTier
      );
      if (rotatedRefresh && client) {
        await persistRotatedRefresh(client, providerId, auth).catch(() => {
        });
      }
      let quotaResult;
      let fellBackToLegacy = false;
      const authParts = parseRefreshParts(auth.refresh);
      const managedProjectId = authParts.managedProjectId ?? account.managedProjectId;
      const fetchSummaryPayload = (async () => {
        try {
          const summaryResult = await fetchQuotaSummary({
            accessToken: auth.access ?? "",
            managedProjectId,
            projectId: projectContext.effectiveProjectId,
            endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
            userAgent: buildAntigravityHarnessUserAgent(),
            timeoutMs: 1e4,
            ...fetchVia ? { fetchVia } : {}
          });
          return {
            result: aggregateQuotaSummary(summaryResult.summary),
            fellBackToLegacy: summaryResult.fellBackToLegacy ?? false
          };
        } catch {
          return {
            result: await fetchLegacyModelsFallback({
              accessToken: auth.access ?? "",
              projectId: projectContext.effectiveProjectId,
              fetchVia
            }),
            fellBackToLegacy: true
          };
        }
      })();
      let geminiCliFetchError;
      const fetchGeminiCliPayload = fetchGeminiCliQuota({
        accessToken: auth.access ?? "",
        projectId: projectContext.effectiveProjectId,
        endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
        userAgent: buildGeminiCliUserAgent(),
        timeoutMs: 1e4,
        ...fetchVia ? { fetchVia } : {}
      }).catch((error) => {
        geminiCliFetchError = error instanceof Error ? error.message : String(error);
        log7.debug("fetchGeminiCliQuota failed", { error: geminiCliFetchError });
        return { buckets: void 0 };
      });
      const [summary, geminiCliResponse] = await Promise.all([
        fetchSummaryPayload,
        fetchGeminiCliPayload
      ]);
      quotaResult = summary.result;
      fellBackToLegacy = summary.fellBackToLegacy;
      const geminiCliQuotaResult = aggregateGeminiCliQuota(geminiCliResponse);
      const annotated = geminiCliResponse.buckets === void 0 || geminiCliResponse.buckets.length === 0 ? {
        ...geminiCliQuotaResult,
        error: (
          // A real fetch exception is a transient failure, not a
          // "no CLI configured" scenario — propagate the actual message.
          geminiCliFetchError ?? (geminiCliQuotaResult.models.length === 0 ? "No Gemini CLI quota available" : void 0)
        )
      } : geminiCliQuotaResult;
      for (const [family, groupQuota] of Object.entries(quotaResult.groups)) {
        const remainingPercent = (groupQuota.remainingFraction ?? 0) * 100;
        logQuotaStatus(account.email, index, remainingPercent, family);
      }
      const legacyTag = fellBackToLegacy ? " legacy=1" : "";
      logQuotaFetch("complete", 1, `ok=1 errors=0${legacyTag}`);
      return {
        index,
        email: account.email,
        status: "ok",
        disabled: false,
        quota: quotaResult,
        geminiCliQuota: annotated,
        updatedAccount
      };
    } catch (error) {
      logQuotaFetch(
        "error",
        void 0,
        `account=${account.email ?? index} error=${error instanceof Error ? error.message : String(error)}`
      );
      return {
        index,
        email: account.email,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        disabled: false
      };
    }
  };
}
function buildAuthFromAccount(account) {
  return {
    type: "oauth",
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId
    }),
    access: void 0,
    expires: void 0
  };
}
function applyAccountUpdates(account, auth, capturedTier) {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return void 0;
  }
  const updated = {
    ...account,
    refreshToken: parts.refreshToken,
    projectId: parts.projectId ?? account.projectId,
    managedProjectId: parts.managedProjectId ?? account.managedProjectId,
    // Persist the captured tier alongside the project-context write. Only
    // present when the loadCodeAssist payload returned a non-empty currentTier.id.
    ...capturedTier ? {
      capturedTierId: capturedTier.id,
      ...capturedTier.paidId !== void 0 ? { capturedPaidTierId: capturedTier.paidId } : {},
      capturedTierAt: capturedTier.capturedAt
    } : {}
  };
  const changed = updated.refreshToken !== account.refreshToken || updated.projectId !== account.projectId || updated.managedProjectId !== account.managedProjectId || updated.capturedTierId !== account.capturedTierId || updated.capturedPaidTierId !== account.capturedPaidTierId || // capturedAt represents when the tier was LAST CONFIRMED, not when it
  // changed -- always update it on a successful observation so consumers
  // can gate staleness on that timestamp even when the id stays the same.
  capturedTier !== void 0 && updated.capturedTierAt !== account.capturedTierAt;
  return changed ? updated : void 0;
}
async function persistRotatedRefresh(client, providerId, auth) {
  await client.auth.set({
    path: { id: providerId },
    body: {
      type: "oauth",
      refresh: auth.refresh,
      access: auth.access ?? "",
      expires: auth.expires ?? 0
    }
  });
}
function makeTierLoader(client, providerId) {
  return async (account) => {
    try {
      let auth = buildAuthFromAccount(account);
      if (accessTokenExpired(auth)) {
        const refreshed = await refreshAccessToken(
          auth,
          client,
          providerId
        );
        if (!refreshed) return null;
        auth = refreshed;
      }
      const accessToken = auth.access;
      if (!accessToken) return null;
      const payload = await loadManagedProject(accessToken);
      if (!payload?.currentTier?.id) return null;
      const paidTierId = typeof payload.paidTier === "string" ? payload.paidTier : payload.paidTier?.id;
      return {
        id: payload.currentTier.id,
        ...paidTierId ? { paidId: paidTierId } : {},
        capturedAt: Date.now()
      };
    } catch {
      return null;
    }
  };
}

// src/plugin/server.ts
import { existsSync as existsSync6, readFileSync as readFileSync7 } from "node:fs";
import { createServer as createServer2 } from "node:http";
var redirectUri = new URL(ANTIGRAVITY_REDIRECT_URI);
var callbackPath = redirectUri.pathname || "/";
function isOrbStackDockerHost() {
  if (!existsSync6("/.dockerenv")) {
    return false;
  }
  try {
    if (existsSync6("/proc/version")) {
      const version = readFileSync7("/proc/version", "utf8").toLowerCase();
      if (version.includes("orbstack")) {
        return true;
      }
    }
    const hostname = process.env.HOSTNAME || "";
    if (hostname.startsWith("orbstack-") || hostname.endsWith(".orb") || hostname === "orbstack") {
      return true;
    }
    if (existsSync6("/etc/resolv.conf")) {
      const resolv = readFileSync7("/etc/resolv.conf", "utf8");
      if (resolv.includes("orb.local") || resolv.includes("orbstack")) {
        return true;
      }
    }
    if (process.platform === "linux" && existsSync6("/.dockerenv")) {
      if (existsSync6("/run/host-services")) {
        return true;
      }
    }
  } catch {
  }
  return false;
}
function isWSL() {
  if (process.platform !== "linux") return false;
  try {
    const release = readFileSync7("/proc/version", "utf8").toLowerCase();
    return release.includes("microsoft") || release.includes("wsl");
  } catch {
    return false;
  }
}
function isRemoteEnvironment() {
  if (process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return true;
  }
  if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) {
    return true;
  }
  return false;
}
function getBindAddress() {
  const envBind = process.env.OPENCODE_ANTIGRAVITY_OAUTH_BIND;
  if (envBind) {
    return envBind;
  }
  if (isOrbStackDockerHost()) {
    return "127.0.0.1";
  }
  if (isWSL() || isRemoteEnvironment()) {
    return "0.0.0.0";
  }
  return "127.0.0.1";
}
async function startOAuthListener({
  timeoutMs = 5 * 60 * 1e3
} = {}) {
  const port = redirectUri.port ? Number.parseInt(redirectUri.port, 10) : redirectUri.protocol === "https:" ? 443 : 80;
  const origin = `${redirectUri.protocol}//${redirectUri.host}`;
  let settled = false;
  let resolveCallback;
  let rejectCallback;
  let timeoutHandle;
  const callbackPromise = new Promise((resolve3, reject) => {
    resolveCallback = (url) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve3(url);
    };
    rejectCallback = (error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(error);
    };
  });
  const successResponse = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Authentication Successful</title>
    <style>
      :root {
        --bg: #FAFAFA;
        --card-bg: #FFFFFF;
        --text-primary: #1F2937;
        --text-secondary: #6B7280;
        --accent: #2563EB;
        --success: #10B981;
        --border: #E5E7EB;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #111827;
          --card-bg: #1F2937;
          --text-primary: #F9FAFB;
          --text-secondary: #9CA3AF;
          --accent: #3B82F6;
          --success: #34D399;
          --border: #374151;
        }
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        background: var(--bg);
        color: var(--text-primary);
        padding: 1rem;
      }
      .card {
        background: var(--card-bg);
        border-radius: 16px;
        padding: 3rem 2rem;
        width: 100%;
        max-width: 400px;
        text-align: center;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        border: 1px solid var(--border);
      }
      .icon-wrapper {
        width: 64px;
        height: 64px;
        background: rgba(16, 185, 129, 0.1);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        margin: 0 auto 1.5rem;
      }
      .icon {
        width: 32px;
        height: 32px;
        color: var(--success);
      }
      h1 {
        font-size: 1.5rem;
        font-weight: 600;
        margin: 0 0 0.5rem;
        letter-spacing: -0.025em;
      }
      p {
        color: var(--text-secondary);
        font-size: 0.95rem;
        line-height: 1.5;
        margin: 0 0 2rem;
      }
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: var(--text-primary);
        color: var(--card-bg);
        font-weight: 500;
        padding: 0.75rem 1.5rem;
        border-radius: 8px;
        text-decoration: none;
        transition: opacity 0.2s;
        font-size: 0.95rem;
        border: none;
        cursor: pointer;
        width: 100%;
        box-sizing: border-box;
      }
      .btn:hover {
        opacity: 0.9;
      }
      .sub-text {
        margin-top: 1rem;
        font-size: 0.8rem;
        color: var(--text-secondary);
      }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="icon-wrapper">
        <svg class="icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h1>All set!</h1>
      <p>You've successfully authenticated with Antigravity. You can now return to Opencode.</p>
      <button class="btn" onclick="closeWindow()">Close this tab</button>
      <div class="sub-text">Usage Tip: Most browsers block auto-closing. If the button doesn't work, please close the tab manually.</div>
    </div>
    <script>
      function closeWindow() {
        window.close();
        // Fallback if window.close() is blocked
        document.querySelector('.btn').textContent = "Tab cannot be closed automatically";
        document.querySelector('.btn').style.opacity = "0.5";
        document.querySelector('.btn').style.cursor = "default";
      }
    </script>
  </body>
</html>`;
  timeoutHandle = setTimeout(() => {
    rejectCallback(new Error("Timed out waiting for OAuth callback"));
  }, timeoutMs);
  timeoutHandle.unref?.();
  const server = createServer2((request, response) => {
    if (!request.url) {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Invalid request");
      return;
    }
    const url = new URL(request.url, origin);
    if (url.pathname !== callbackPath) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(successResponse);
    resolveCallback(url);
    setImmediate(() => {
      server.close();
    });
  });
  const bindAddress = getBindAddress();
  await new Promise((resolve3, reject) => {
    const handleError = (error) => {
      server.off("error", handleError);
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. Another process is occupying this port. Please terminate the process or try again later.`
          )
        );
        return;
      }
      reject(error);
    };
    server.once("error", handleError);
    server.listen(port, bindAddress, () => {
      server.off("error", handleError);
      resolve3();
    });
  });
  server.on("error", (error) => {
    rejectCallback(error instanceof Error ? error : new Error(String(error)));
  });
  return {
    waitForCallback: () => callbackPromise,
    close: () => new Promise((resolve3, reject) => {
      server.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
          return;
        }
        if (!settled) {
          rejectCallback(new Error("OAuth listener closed before callback"));
        }
        resolve3();
      });
    })
  };
}

// src/plugin/oauth-methods.ts
function toV1AuthCallbackResult(result) {
  if (result.type === "failed") {
    return { type: "failed" };
  }
  return {
    type: "success",
    refresh: result.refresh,
    access: result.access ?? "",
    expires: result.expires ?? 0
  };
}
var MAX_OAUTH_ACCOUNTS = 10;
var log8 = createLogger2("oauth-methods");
async function reportPersistenceFailure(error, client, log18) {
  const message = error instanceof AccountStorageUnreadableError ? `Account storage at ${error.details.path} is unreadable (${error.details.reason}: ${error.details.detail}).${error.details.backupPath ? ` A backup was written to ${error.details.backupPath}. Repair or remove the existing file before retrying.` : " A backup could not be written; repair or remove the existing file before retrying."}` : error instanceof Error ? error.message : String(error);
  log18.error("OAuth login persistence failed; aborting login", {
    error: message
  });
  try {
    await client.tui.showToast({
      body: {
        message: `Login failed: ${message}`,
        variant: "error"
      }
    });
  } catch {
  }
  return { type: "failed", error: message };
}
function isWSL2() {
  if (process.platform !== "linux") return false;
  try {
    const release = readFileSync8("/proc/version", "utf8").toLowerCase();
    return release.includes("microsoft") || release.includes("wsl");
  } catch {
    return false;
  }
}
function isWSL22() {
  if (!isWSL2()) return false;
  try {
    const version = readFileSync8("/proc/version", "utf8").toLowerCase();
    return version.includes("wsl2") || version.includes("microsoft-standard");
  } catch {
    return false;
  }
}
function isRemoteEnvironment2() {
  if (process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return true;
  }
  if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) return true;
  return process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !isWSL2();
}
function defaultShouldSkipLocalServer() {
  return isWSL22() || isRemoteEnvironment2();
}
async function openBrowserWithSystem(url) {
  try {
    if (process.platform === "darwin") {
      exec(`open "${url}"`);
      return true;
    }
    if (process.platform === "win32") {
      exec(`start "" "${url}"`);
      return true;
    }
    if (isWSL2()) {
      exec(`wslview "${url}"`);
      return true;
    }
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
    exec(`xdg-open "${url}"`);
    return true;
  } catch {
    return false;
  }
}
async function defaultPromptCallback(message) {
  const { createInterface: createInterface2 } = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = createInterface2({ input: stdin, output: stdout });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}
function getStateFromAuthorizationUrl(authorizationUrl) {
  try {
    return new URL(authorizationUrl).searchParams.get("state") ?? "";
  } catch {
    return "";
  }
}
function extractOAuthCallbackParams(url, expectedState2) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return { error: "Missing code or state in callback URL" };
  if (expectedState2 && state !== expectedState2) {
    return { error: "OAuth state mismatch" };
  }
  return { code, state };
}
function parseOAuthCallbackInput(value, fallbackState) {
  const trimmed = value.trim();
  if (!trimmed) return { error: "Missing authorization code" };
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? fallbackState;
    if (!code) return { error: "Missing code in callback URL" };
    if (!state) return { error: "Missing state in callback URL" };
    if (fallbackState && state !== fallbackState) {
      return { error: "OAuth state mismatch" };
    }
    return { code, state };
  } catch {
    if (!fallbackState) {
      return {
        error: "Missing state. Paste the full redirect URL instead of only the code."
      };
    }
    return { code: trimmed, state: fallbackState };
  }
}
function buildAuthSuccessFromStoredAccount(account) {
  return {
    type: "success",
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId
    }),
    access: "",
    expires: 0,
    email: account.email,
    label: account.label,
    projectId: account.projectId ?? ""
  };
}
function formatCachedQuotaSummary(account) {
  return account.cachedQuota ? formatCachedQuotaWithStatus(account.cachedQuota) : void 0;
}
function formatWaitTime(ms) {
  if (ms < 1e3) return `${ms}ms`;
  const seconds = Math.ceil(ms / 1e3);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
function createOAuthMethods({
  client,
  providerId,
  config: _config,
  lifecycle,
  accountAccess,
  quotaManager: injectedQuotaManager,
  getAuth = null,
  dependencies
}) {
  const deps = {
    authorize: dependencies?.authorize ?? authorizeAntigravity,
    exchange: dependencies?.exchange ?? exchangeAntigravity,
    startListener: dependencies?.startListener ?? startOAuthListener,
    promptProjectId: dependencies?.promptProjectId ?? promptProjectId,
    promptAddAnotherAccount: dependencies?.promptAddAnotherAccount ?? promptAddAnotherAccount,
    promptLoginMode: dependencies?.promptLoginMode ?? promptLoginMode,
    promptCallback: dependencies?.promptCallback ?? defaultPromptCallback,
    openBrowser: dependencies?.openBrowser ?? openBrowserWithSystem,
    shouldSkipLocalServer: dependencies?.shouldSkipLocalServer ?? defaultShouldSkipLocalServer,
    isHeadless: dependencies?.isHeadless ?? (() => Boolean(
      process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.OPENCODE_HEADLESS
    )),
    confirmOpenVerificationUrl: dependencies?.confirmOpenVerificationUrl ?? (async () => {
      const answer = (await defaultPromptCallback(
        "Open verification URL in your browser now? [Y/n]: "
      )).trim().toLowerCase();
      return answer === "" || answer === "y" || answer === "yes";
    })
  };
  const quotaManager = injectedQuotaManager ?? createOpenCodeQuotaManager(client, providerId, {
    // Bind to the live AccountManager so the menu `check` action's
    // `refreshAccounts` pushes the refreshed percentages into the
    // sidebar. The lifecycle reference is stable for the lifetime of
    // the plugin so this closure is safe to capture.
    getAccountsForSidebar: () => {
      const manager = lifecycle.getAccountManager();
      if (!manager) return null;
      return manager.getAccounts().map((entry) => ({
        index: entry.index,
        label: entry.label,
        enabled: entry.enabled,
        coolingDownUntil: entry.coolingDownUntil,
        cachedQuota: entry.cachedQuota
      }));
    }
  });
  if (!injectedQuotaManager) {
    lifecycle.register({ dispose: () => quotaManager.dispose() });
  }
  const cachedGetAuth = getAuth;
  const loadAccounts2 = () => accountAccess.loadAccounts();
  const clearAccounts2 = () => accountAccess.clearAccounts();
  const persistAccountPool2 = accountAccess.persistAccountPool.bind(accountAccess);
  const mutateAccountByRefreshToken = async (refreshToken, mutate) => {
    let changed = false;
    await accountAccess.mutateAccounts((current) => {
      const account = current.accounts.find(
        (candidate) => candidate.refreshToken === refreshToken
      );
      if (account) changed = mutate(account);
      return current;
    });
    return changed;
  };
  const verifyAccountAccess = accountAccess.verifyAccount.bind(accountAccess);
  const promptAccountIndexForVerification2 = accountAccess.selectAccount.bind(accountAccess);
  const promptOpenVerificationUrl2 = deps.confirmOpenVerificationUrl;
  const openBrowser = deps.openBrowser;
  const shouldSkipLocalServer = deps.shouldSkipLocalServer;
  const startOAuthListener2 = deps.startListener;
  const promptOAuthCallbackValue = deps.promptCallback;
  const promptManualOAuthInput = async (fallbackState) => {
    console.log(
      "1. Open the URL above in your browser and complete Google sign-in."
    );
    console.log(
      "2. After approving, copy the full redirected localhost URL from the address bar."
    );
    console.log("3. Paste it back here.\n");
    const callbackInput = await promptOAuthCallbackValue(
      "Paste the redirect URL (or just the code) here: "
    );
    const params = parseOAuthCallbackInput(callbackInput, fallbackState);
    if ("error" in params) return { type: "failed", error: params.error };
    return deps.exchange(params.code, params.state);
  };
  const authorizeAntigravity2 = deps.authorize;
  const exchangeAntigravity2 = deps.exchange;
  const promptProjectId2 = deps.promptProjectId;
  const promptAddAnotherAccount2 = deps.promptAddAnotherAccount;
  const promptLoginMode2 = deps.promptLoginMode;
  return [
    {
      label: "OAuth with Google (Antigravity)",
      type: "oauth",
      authorize: async (inputs) => {
        const isHeadless = deps.isHeadless();
        if (inputs) {
          const accounts = [];
          const noBrowser = inputs.noBrowser === "true" || inputs["no-browser"] === "true";
          const useManualMode = noBrowser || shouldSkipLocalServer();
          let startFresh = true;
          let refreshAccountIndex;
          const existingStorage2 = await loadAccounts2();
          if (existingStorage2 && existingStorage2.accounts.length > 0) {
            let menuResult;
            while (true) {
              const now = Date.now();
              const existingAccounts = existingStorage2.accounts.map(
                (acc, idx) => {
                  let status = "unknown";
                  if (acc.accountIneligible) {
                    status = "ineligible";
                  } else if (acc.verificationRequired) {
                    status = "verification-required";
                  } else {
                    const rateLimits = acc.rateLimitResetTimes;
                    if (rateLimits) {
                      const isRateLimited = Object.values(rateLimits).some(
                        (resetTime) => typeof resetTime === "number" && resetTime > now
                      );
                      if (isRateLimited) {
                        status = "rate-limited";
                      } else {
                        status = "active";
                      }
                    } else {
                      status = "active";
                    }
                    if (acc.coolingDownUntil && acc.coolingDownUntil > now) {
                      status = "rate-limited";
                    }
                  }
                  const cooldownMs = acc.coolingDownUntil && acc.coolingDownUntil > now ? acc.coolingDownUntil - now : void 0;
                  const DISPLAY_QUOTA_MAX_AGE_MS = 60 * 60 * 1e3;
                  const quotaIsStale = acc.cachedQuotaUpdatedAt == null || now - acc.cachedQuotaUpdatedAt > DISPLAY_QUOTA_MAX_AGE_MS;
                  const displayQuota = quotaIsStale ? void 0 : acc.cachedQuota;
                  const displayPerModelQuota = quotaIsStale ? void 0 : acc.cachedPerModelQuota;
                  if (status === "active" && displayQuota) {
                    const groups = Object.values(displayQuota);
                    const allExhausted = groups.length > 0 && groups.every(
                      (group) => typeof group.remainingFraction === "number" && group.remainingFraction <= 0
                    );
                    if (allExhausted) {
                      status = "rate-limited";
                    }
                  }
                  return {
                    email: acc.email,
                    index: idx,
                    addedAt: acc.addedAt,
                    lastUsed: acc.lastUsed,
                    status,
                    isCurrentAccount: idx === (existingStorage2.activeIndex ?? 0),
                    enabled: acc.enabled !== false,
                    quotaSummary: quotaIsStale ? void 0 : formatCachedQuotaSummary(acc),
                    cooldownMs,
                    cooldownReason: cooldownMs ? acc.cooldownReason : void 0,
                    cachedQuota: displayQuota,
                    cachedPerModelQuota: displayPerModelQuota,
                    fingerprintHistory: acc.fingerprintHistory
                  };
                }
              );
              menuResult = await promptLoginMode2(existingAccounts);
              if (menuResult.mode === "check") {
                console.log("\n\u{1F4CA} Checking quotas for all accounts...\n");
                clearProvisionFailedKeys();
                const results = await quotaManager.refreshAccounts(
                  existingStorage2.accounts,
                  {
                    indexFor: (account) => existingStorage2.accounts.indexOf(account),
                    force: true
                  }
                );
                const quotaUpdates = /* @__PURE__ */ new Map();
                for (const res of results) {
                  const label = res.email || `Account ${res.index + 1}`;
                  const disabledStr = res.disabled ? " (disabled)" : "";
                  console.log(
                    `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`
                  );
                  console.log(`  ${label}${disabledStr}`);
                  console.log(
                    `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`
                  );
                  if (res.status === "error") {
                    console.log(`  \u274C Error: ${res.error}
`);
                    continue;
                  }
                  const colors = {
                    red: "\x1B[31m",
                    orange: "\x1B[33m",
                    // Yellow/orange
                    green: "\x1B[32m",
                    reset: "\x1B[0m"
                  };
                  const getColor = (remaining) => {
                    if (typeof remaining !== "number") return colors.reset;
                    if (remaining < 0.2) return colors.red;
                    if (remaining < 0.6) return colors.orange;
                    return colors.green;
                  };
                  const createProgressBar = (remaining, width = 20) => {
                    if (typeof remaining !== "number")
                      return `${"\u2591".repeat(width)} ???`;
                    const filled = Math.round(remaining * width);
                    const empty = width - filled;
                    const color = getColor(remaining);
                    const bar = `${color}${"\u2588".repeat(filled)}${colors.reset}${"\u2591".repeat(empty)}`;
                    const pct = `${color}${Math.round(remaining * 100)}%${colors.reset}`.padStart(
                      4 + color.length + colors.reset.length
                    );
                    return `${bar} ${pct}`;
                  };
                  const formatReset = (resetTime, remainingFraction) => {
                    if (!resetTime) return "";
                    const ms = Date.parse(resetTime) - Date.now();
                    if (ms <= 0) {
                      return remainingFraction !== void 0 && remainingFraction <= 0 ? " (paid only)" : " (resetting...)";
                    }
                    const hours = ms / (1e3 * 60 * 60);
                    if (hours >= 24) {
                      const days = Math.floor(hours / 24);
                      const remainingHours = Math.floor(hours % 24);
                      if (remainingHours > 0) {
                        return ` (resets in ${days}d ${remainingHours}h)`;
                      }
                      return ` (resets in ${days}d)`;
                    }
                    return ` (resets in ${formatWaitTime(ms)})`;
                  };
                  const hasGeminiCli = res.geminiCliQuota && res.geminiCliQuota.models.length > 0;
                  console.log(`
  \u250C\u2500 Gemini CLI Quota`);
                  if (!hasGeminiCli) {
                    const errorMsg = res.geminiCliQuota?.error || "No Gemini CLI quota available";
                    console.log(`  \u2502  \u2514\u2500 ${errorMsg}`);
                  } else {
                    const models = res.geminiCliQuota.models;
                    models.forEach((model, idx) => {
                      const isLast = idx === models.length - 1;
                      const connector = isLast ? "\u2514\u2500" : "\u251C\u2500";
                      const bar = createProgressBar(model.remainingFraction);
                      const reset = formatReset(
                        model.resetTime,
                        model.remainingFraction
                      );
                      const status = classifyGroupStatus({
                        remainingFraction: model.remainingFraction,
                        resetTime: model.resetTime,
                        modelCount: 1
                      });
                      const badge = formatQuotaStatusBadge(status);
                      const modelName = model.modelId.padEnd(29);
                      console.log(
                        `  \u2502  ${connector} ${modelName} ${bar} ${badge}${reset}`
                      );
                    });
                  }
                  const hasAntigravity = res.quota && Object.keys(res.quota.groups).length > 0;
                  console.log(`  \u2502`);
                  console.log(`  \u2514\u2500 Antigravity Quota`);
                  if (!hasAntigravity) {
                    const errorMsg = res.quota?.error || "No quota information available";
                    console.log(`     \u2514\u2500 ${errorMsg}`);
                  } else {
                    const groups = res.quota.groups;
                    const groupEntries = [
                      { name: "Non-Gemini", data: groups["non-gemini"] },
                      { name: "Gemini", data: groups.gemini }
                    ].filter((g) => g.data);
                    groupEntries.forEach((g, idx) => {
                      const isLast = idx === groupEntries.length - 1;
                      const connector = isLast ? "\u2514\u2500" : "\u251C\u2500";
                      const bar = createProgressBar(g.data.remainingFraction);
                      const reset = formatReset(
                        g.data.resetTime,
                        g.data.remainingFraction
                      );
                      const status = classifyGroupStatus(g.data);
                      const badge = formatQuotaStatusBadge(status);
                      const modelName = g.name.padEnd(29);
                      console.log(
                        `     ${connector} ${modelName} ${bar} ${badge}${reset}`
                      );
                    });
                  }
                  console.log("");
                  const targetRefreshToken = existingStorage2.accounts[res.index]?.refreshToken;
                  if (!targetRefreshToken) continue;
                  const updatedAt = Date.now();
                  const existing = quotaUpdates.get(targetRefreshToken);
                  quotaUpdates.set(targetRefreshToken, {
                    quota: res.quota?.groups,
                    perModel: res.quota?.perModel,
                    updatedAccount: res.updatedAccount,
                    updatedAt: existing && existing.updatedAt > updatedAt ? existing.updatedAt : updatedAt
                  });
                }
                if (quotaUpdates.size > 0) {
                  await accountAccess.mutateAccounts((current) => {
                    let changed = false;
                    for (const [refreshToken, update] of quotaUpdates) {
                      const idx = current.accounts.findIndex(
                        (acc) => acc.refreshToken === refreshToken
                      );
                      if (idx === -1) continue;
                      const target = current.accounts[idx];
                      if (!target) continue;
                      current.accounts[idx] = {
                        ...target,
                        ...update.updatedAccount ?? {},
                        cachedQuota: update.quota,
                        cachedPerModelQuota: update.perModel,
                        cachedQuotaUpdatedAt: update.updatedAt
                      };
                      changed = true;
                    }
                    return changed ? current : current;
                  });
                }
                console.log("");
                continue;
              }
              if (menuResult.mode === "doctor") {
                const auth = cachedGetAuth ? await cachedGetAuth().catch(() => void 0) : void 0;
                const versionResolution = getAntigravityVersionResolution();
                const report = createAuthDoctorReport({
                  auth,
                  storage: existingStorage2,
                  runtime: {
                    antigravityVersion: versionResolution.version,
                    antigravityVersionSource: versionResolution.source
                  }
                });
                console.log(`
${formatAuthDoctorReport(report)}
`);
                continue;
              }
              if (menuResult.mode === "manage") {
                if (menuResult.toggleAccountIndex !== void 0) {
                  const acc = existingStorage2.accounts[menuResult.toggleAccountIndex];
                  if (acc) {
                    const shouldEnable = acc.enabled === false;
                    if (shouldEnable && acc.accountIneligible) {
                      console.log(
                        `
${acc.email || `Account ${menuResult.toggleAccountIndex + 1}`} remains disabled. Use Verify accounts to recheck eligibility.
`
                      );
                      continue;
                    }
                    if (acc.refreshToken) {
                      await mutateAccountByRefreshToken(
                        acc.refreshToken,
                        (target) => {
                          target.enabled = shouldEnable;
                          return true;
                        }
                      );
                    }
                    lifecycle.getAccountManager()?.setAccountEnabled(
                      menuResult.toggleAccountIndex,
                      shouldEnable
                    );
                    console.log(
                      `
Account ${acc.email || menuResult.toggleAccountIndex + 1} ${shouldEnable ? "enabled" : "disabled"}.
`
                    );
                  }
                }
                continue;
              }
              if (menuResult.mode === "verify" || menuResult.mode === "verify-all") {
                const verifyAll = menuResult.mode === "verify-all" || menuResult.verifyAll === true;
                if (verifyAll) {
                  if (existingStorage2.accounts.length === 0) {
                    console.log("\nNo accounts available to verify.\n");
                    continue;
                  }
                  console.log(
                    `
Checking verification status for ${existingStorage2.accounts.length} account(s)...
`
                  );
                  let okCount = 0;
                  let blockedCount = 0;
                  let ineligibleCount = 0;
                  let errorCount = 0;
                  const blockedResults = [];
                  for (let i = 0; i < existingStorage2.accounts.length; i++) {
                    const account2 = existingStorage2.accounts[i];
                    if (!account2) continue;
                    const label2 = account2.email || `Account ${i + 1}`;
                    process.stdout.write(
                      `- [${i + 1}/${existingStorage2.accounts.length}] ${label2} ... `
                    );
                    const verification2 = await verifyAccountAccess(account2);
                    if (verification2.status === "ok") {
                      const wasAccessBlocked = account2.verificationRequired === true || account2.accountIneligible === true;
                      if (account2.refreshToken) {
                        await mutateAccountByRefreshToken(
                          account2.refreshToken,
                          (acc) => clearStoredAccountAccessBlocks(acc, true).changed
                        );
                      }
                      lifecycle.getAccountManager()?.clearAccountAccessBlocks(i, wasAccessBlocked);
                      okCount += 1;
                      console.log("ok");
                      continue;
                    }
                    if (verification2.status === "verification-required") {
                      if (account2.refreshToken) {
                        await mutateAccountByRefreshToken(
                          account2.refreshToken,
                          (acc) => markStoredAccountVerificationRequired(
                            acc,
                            verification2.message,
                            verification2.verifyUrl
                          )
                        );
                      }
                      lifecycle.getAccountManager()?.markAccountVerificationRequired(
                        i,
                        verification2.message,
                        verification2.verifyUrl
                      );
                      blockedCount += 1;
                      console.log("needs verification");
                      const verifyUrl = verification2.verifyUrl ?? account2.verificationUrl;
                      blockedResults.push({
                        label: label2,
                        message: verification2.message,
                        verifyUrl
                      });
                      continue;
                    }
                    if (verification2.status === "ineligible") {
                      if (account2.refreshToken) {
                        await mutateAccountByRefreshToken(
                          account2.refreshToken,
                          (acc) => markStoredAccountIneligible(
                            acc,
                            verification2.message
                          )
                        );
                      }
                      lifecycle.getAccountManager()?.markAccountIneligible(i, verification2.message);
                      ineligibleCount += 1;
                      console.log("ineligible");
                      continue;
                    }
                    errorCount += 1;
                    console.log(`error (${verification2.message})`);
                  }
                  console.log(
                    `
Verification summary: ${okCount} ready, ${blockedCount} need verification, ${ineligibleCount} ineligible, ${errorCount} errors.`
                  );
                  if (blockedResults.length > 0) {
                    console.log("\nAccounts needing verification:");
                    for (const result of blockedResults) {
                      console.log(`
- ${result.label}`);
                      console.log(`  ${result.message}`);
                      if (result.verifyUrl) {
                        console.log(`  URL: ${result.verifyUrl}`);
                      } else {
                        console.log("  URL: not provided by API response");
                      }
                    }
                    console.log("");
                  } else {
                    console.log("");
                  }
                  continue;
                }
                let verifyAccountIndex = menuResult.verifyAccountIndex;
                if (verifyAccountIndex === void 0) {
                  verifyAccountIndex = await promptAccountIndexForVerification2(existingAccounts);
                }
                if (verifyAccountIndex === void 0) {
                  console.log("\nVerification cancelled.\n");
                  continue;
                }
                const account = existingStorage2.accounts[verifyAccountIndex];
                if (!account) {
                  console.log(
                    `
Account ${verifyAccountIndex + 1} not found.
`
                  );
                  continue;
                }
                const label = account.email || `Account ${verifyAccountIndex + 1}`;
                console.log(`
Checking verification status for ${label}...
`);
                const verification = await verifyAccountAccess(account);
                if (verification.status === "ok") {
                  const wasAccessBlocked = account.verificationRequired === true || account.accountIneligible === true;
                  if (account.refreshToken) {
                    await mutateAccountByRefreshToken(
                      account.refreshToken,
                      (acc) => clearStoredAccountAccessBlocks(acc, true).changed
                    );
                  }
                  lifecycle.getAccountManager()?.clearAccountAccessBlocks(
                    verifyAccountIndex,
                    wasAccessBlocked
                  );
                  if (wasAccessBlocked) {
                    console.log(
                      `\u2713 ${label} is ready for requests and has been re-enabled.
`
                    );
                  } else {
                    console.log(`\u2713 ${label} is ready for requests.
`);
                  }
                  continue;
                }
                if (verification.status === "verification-required") {
                  if (account.refreshToken) {
                    await mutateAccountByRefreshToken(
                      account.refreshToken,
                      (acc) => markStoredAccountVerificationRequired(
                        acc,
                        verification.message,
                        verification.verifyUrl
                      )
                    );
                  }
                  lifecycle.getAccountManager()?.markAccountVerificationRequired(
                    verifyAccountIndex,
                    verification.message,
                    verification.verifyUrl
                  );
                  const verifyUrl = verification.verifyUrl ?? account.verificationUrl;
                  console.log(
                    `\u26A0 ${label} needs Google verification before it can be used.`
                  );
                  if (verification.message) {
                    console.log(verification.message);
                  }
                  console.log(
                    `${label} has been disabled until verification is completed.`
                  );
                  if (verifyUrl) {
                    console.log(`
Verification URL:
${verifyUrl}
`);
                    if (await promptOpenVerificationUrl2()) {
                      const opened = await openBrowser(verifyUrl);
                      if (opened) {
                        console.log(
                          "Opened verification URL in your browser.\n"
                        );
                      } else {
                        console.log(
                          "Could not open browser automatically. Please open the URL manually.\n"
                        );
                      }
                    }
                  } else {
                    console.log(
                      "No verification URL was returned. Try re-authenticating this account.\n"
                    );
                  }
                  continue;
                }
                if (verification.status === "ineligible") {
                  if (account.refreshToken) {
                    await mutateAccountByRefreshToken(
                      account.refreshToken,
                      (acc) => markStoredAccountIneligible(acc, verification.message)
                    );
                  }
                  lifecycle.getAccountManager()?.markAccountIneligible(
                    verifyAccountIndex,
                    verification.message
                  );
                  console.log(
                    `\u26A0 ${label} is not eligible for Antigravity and has been disabled.`
                  );
                  console.log(`${verification.message}
`);
                  continue;
                }
                console.log(`\u2717 ${label}: ${verification.message}
`);
                continue;
              }
              break;
            }
            if (menuResult.mode === "cancel") {
              return {
                url: "",
                instructions: "Authentication cancelled",
                method: "auto",
                callback: async () => toV1AuthCallbackResult({
                  type: "failed",
                  error: "Authentication cancelled"
                })
              };
            }
            if (menuResult.deleteAccountIndex !== void 0) {
              const targetRefreshToken = existingStorage2.accounts[menuResult.deleteAccountIndex]?.refreshToken;
              const nextStorage = await accountAccess.mutateAccounts(
                (current) => ({
                  ...current,
                  accounts: targetRefreshToken ? current.accounts.filter(
                    (account) => account.refreshToken !== targetRefreshToken
                  ) : current.accounts.filter(
                    (_, index) => index !== menuResult.deleteAccountIndex
                  ),
                  activeIndex: 0,
                  activeIndexByFamily: { claude: 0, gemini: 0 }
                })
              );
              const updatedAccounts = nextStorage.accounts;
              lifecycle.getAccountManager()?.removeAccountByIndex(menuResult.deleteAccountIndex);
              console.log("\nAccount deleted.\n");
              if (updatedAccounts.length > 0) {
                const fallbackAccount = updatedAccounts[0];
                if (fallbackAccount?.refreshToken) {
                  const fallbackResult = buildAuthSuccessFromStoredAccount(fallbackAccount);
                  try {
                    await client.auth.set({
                      path: { id: providerId },
                      body: {
                        type: "oauth",
                        refresh: fallbackResult.refresh,
                        access: "",
                        expires: 0
                      }
                    });
                  } catch (storeError) {
                    log8.error(
                      "Failed to update stored Antigravity OAuth credentials",
                      { error: String(storeError) }
                    );
                  }
                  const label = fallbackAccount.email || `Account ${1}`;
                  return {
                    url: "",
                    instructions: `Account deleted. Using ${label} for future requests.`,
                    method: "auto",
                    callback: async () => toV1AuthCallbackResult(fallbackResult)
                  };
                }
              }
              try {
                await client.auth.set({
                  path: { id: providerId },
                  body: {
                    type: "oauth",
                    refresh: "",
                    access: "",
                    expires: 0
                  }
                });
              } catch (storeError) {
                log8.error(
                  "Failed to clear stored Antigravity OAuth credentials",
                  { error: String(storeError) }
                );
              }
              return {
                url: "",
                instructions: "All accounts deleted. Run `opencode auth login` to reauthenticate.",
                method: "auto",
                callback: async () => toV1AuthCallbackResult({
                  type: "failed",
                  error: "All accounts deleted. Reauthentication required."
                })
              };
            }
            if (menuResult.refreshAccountIndex !== void 0) {
              refreshAccountIndex = menuResult.refreshAccountIndex;
              const refreshEmail = existingStorage2.accounts[refreshAccountIndex]?.email;
              console.log(
                `
Re-authenticating ${refreshEmail || "account"}...
`
              );
              startFresh = false;
            }
            if (menuResult.deleteAll) {
              await clearAccounts2();
              console.log("\nAll accounts deleted.\n");
              startFresh = true;
              try {
                await client.auth.set({
                  path: { id: providerId },
                  body: {
                    type: "oauth",
                    refresh: "",
                    access: "",
                    expires: 0
                  }
                });
              } catch (storeError) {
                log8.error(
                  "Failed to clear stored Antigravity OAuth credentials",
                  { error: String(storeError) }
                );
              }
            } else {
              startFresh = menuResult.mode === "fresh";
            }
            if (startFresh && !menuResult.deleteAll) {
              console.log(
                "\nStarting fresh - existing accounts will be replaced.\n"
              );
            } else if (!startFresh) {
              console.log("\nAdding to existing accounts.\n");
            }
          }
          while (accounts.length < MAX_OAUTH_ACCOUNTS) {
            console.log(
              `
=== Antigravity OAuth (Account ${accounts.length + 1}) ===`
            );
            const projectId2 = await promptProjectId2();
            let persistedBySharedService = false;
            const loginRequest = {
              projectId: projectId2,
              noBrowser,
              isHeadless,
              refreshAccountIndex,
              accounts: [...accounts],
              startFresh
            };
            const result = await (async () => {
              if (!useManualMode && refreshAccountIndex === void 0) {
                try {
                  return await performOAuthLogin(loginRequest, {
                    authorize: authorizeAntigravity2,
                    exchange: exchangeAntigravity2,
                    startListener: startOAuthListener2,
                    openBrowser: async (url) => {
                      await openBrowser(url);
                    },
                    upsert: async (loginResult) => {
                      await persistAccountPool2(
                        [loginResult],
                        accounts.length === 0 && startFresh
                      );
                      persistedBySharedService = true;
                    }
                  });
                } catch (error) {
                  return {
                    type: "failed",
                    error: error instanceof Error ? error.message : String(error)
                  };
                }
              }
              const authorization2 = await authorizeAntigravity2(projectId2);
              const fallbackState2 = getStateFromAuthorizationUrl(
                authorization2.url
              );
              console.log(`
OAuth URL:
${authorization2.url}
`);
              if (useManualMode) {
                const browserOpened = await openBrowser(authorization2.url);
                if (!browserOpened) {
                  console.log("Could not open browser automatically.");
                  console.log(
                    "Please open the URL above manually in your local browser.\n"
                  );
                }
                return promptManualOAuthInput(fallbackState2);
              }
              let listener2 = null;
              if (!isHeadless) {
                try {
                  listener2 = await startOAuthListener2();
                } catch {
                  listener2 = null;
                }
              }
              if (!isHeadless) {
                await openBrowser(authorization2.url);
              }
              if (listener2) {
                try {
                  const SOFT_TIMEOUT_MS = 3e4;
                  const callbackPromise = listener2.waitForCallback();
                  const timeoutPromise = new Promise(
                    (_, reject) => setTimeout(
                      () => reject(new Error("SOFT_TIMEOUT")),
                      SOFT_TIMEOUT_MS
                    )
                  );
                  let callbackUrl;
                  try {
                    callbackUrl = await Promise.race([
                      callbackPromise,
                      timeoutPromise
                    ]);
                  } catch (err) {
                    if (err instanceof Error && err.message === "SOFT_TIMEOUT") {
                      console.log(
                        "\n\u23F3 Automatic callback not received after 30 seconds."
                      );
                      console.log(
                        "You can paste the redirect URL manually.\n"
                      );
                      console.log("OAuth URL (in case you need it again):");
                      console.log(`${authorization2.url}
`);
                      try {
                        await listener2.close();
                      } catch {
                      }
                      return promptManualOAuthInput(fallbackState2);
                    }
                    throw err;
                  }
                  const params = extractOAuthCallbackParams(
                    callbackUrl,
                    fallbackState2
                  );
                  if ("error" in params) {
                    return {
                      type: "failed",
                      error: params.error
                    };
                  }
                  return exchangeAntigravity2(params.code, params.state);
                } catch (error) {
                  if (error instanceof Error && error.message !== "SOFT_TIMEOUT") {
                    return {
                      type: "failed",
                      error: error.message
                    };
                  }
                  return {
                    type: "failed",
                    error: error instanceof Error ? error.message : "Unknown error"
                  };
                } finally {
                  try {
                    await listener2.close();
                  } catch {
                  }
                }
              }
              return promptManualOAuthInput(fallbackState2);
            })();
            if (result.type === "failed") {
              if (accounts.length === 0) {
                return {
                  url: "",
                  instructions: `Authentication failed: ${result.error}`,
                  method: "auto",
                  callback: async () => toV1AuthCallbackResult(result)
                };
              }
              console.warn(
                `[opencode-antigravity-auth] Skipping failed account ${accounts.length + 1}: ${result.error}`
              );
              break;
            }
            accounts.push(result);
            try {
              await client.tui.showToast({
                body: {
                  message: `Account ${accounts.length} authenticated${result.email ? ` (${result.email})` : ""}`,
                  variant: "success"
                }
              });
            } catch {
            }
            try {
              if (!persistedBySharedService && refreshAccountIndex !== void 0) {
                const currentStorage = await loadAccounts2();
                if (currentStorage) {
                  const targetRefreshToken = currentStorage.accounts[refreshAccountIndex]?.refreshToken;
                  const parts = parseRefreshParts(result.refresh);
                  if (targetRefreshToken && parts.refreshToken) {
                    await accountAccess.mutateAccounts((current) => {
                      const idx = current.accounts.findIndex(
                        (acc) => acc.refreshToken === targetRefreshToken
                      );
                      if (idx === -1) return current;
                      const target = current.accounts[idx];
                      if (!target) return current;
                      current.accounts[idx] = {
                        ...target,
                        email: result.email ?? target.email,
                        label: result.label ?? target.label,
                        refreshToken: parts.refreshToken,
                        projectId: parts.projectId ?? target.projectId,
                        managedProjectId: parts.managedProjectId ?? target.managedProjectId,
                        addedAt: target.addedAt ?? Date.now(),
                        lastUsed: Date.now()
                      };
                      return current;
                    });
                  }
                }
              } else if (!persistedBySharedService) {
                const isFirstAccount = accounts.length === 1;
                await persistAccountPool2([result], isFirstAccount && startFresh);
              }
            } catch (error) {
              if (error instanceof AccountStorageUnreadableError) {
                throw error;
              }
            }
            if (refreshAccountIndex !== void 0) {
              break;
            }
            if (accounts.length >= MAX_OAUTH_ACCOUNTS) {
              break;
            }
            let currentAccountCount = accounts.length;
            try {
              const currentStorage = await loadAccounts2();
              if (currentStorage) {
                currentAccountCount = currentStorage.accounts.length;
              }
            } catch {
            }
            const addAnother = await promptAddAnotherAccount2(currentAccountCount);
            if (!addAnother) {
              break;
            }
          }
          const primary = accounts[0];
          if (!primary) {
            return {
              url: "",
              instructions: "Authentication cancelled",
              method: "auto",
              callback: async () => toV1AuthCallbackResult({
                type: "failed",
                error: "Authentication cancelled"
              })
            };
          }
          let actualAccountCount = accounts.length;
          try {
            const finalStorage = await loadAccounts2();
            if (finalStorage) {
              actualAccountCount = finalStorage.accounts.length;
            }
          } catch {
          }
          const successMessage = refreshAccountIndex !== void 0 ? `Token refreshed successfully.` : `Multi-account setup complete (${actualAccountCount} account(s)).`;
          return {
            url: "",
            instructions: successMessage,
            method: "auto",
            callback: async () => primary
          };
        }
        const projectId = "";
        const existingStorage = await loadAccounts2();
        const existingCount = existingStorage?.accounts.length ?? 0;
        const useManualFlow = isHeadless || shouldSkipLocalServer();
        let listener = null;
        if (!useManualFlow) {
          try {
            listener = await startOAuthListener2();
          } catch {
            listener = null;
          }
        }
        const authorization = await authorizeAntigravity2(projectId);
        const fallbackState = getStateFromAuthorizationUrl(authorization.url);
        if (!useManualFlow) {
          const browserOpened = await openBrowser(authorization.url);
          if (!browserOpened) {
            listener?.close().catch(() => {
            });
            listener = null;
          }
        }
        if (listener) {
          return {
            url: authorization.url,
            instructions: "Complete sign-in in your browser. We'll automatically detect the redirect back to localhost.",
            method: "auto",
            callback: async () => {
              const CALLBACK_TIMEOUT_MS = 3e4;
              try {
                const callbackPromise = listener.waitForCallback();
                const timeoutPromise = new Promise(
                  (_, reject) => setTimeout(
                    () => reject(new Error("CALLBACK_TIMEOUT")),
                    CALLBACK_TIMEOUT_MS
                  )
                );
                let callbackUrl;
                try {
                  callbackUrl = await Promise.race([
                    callbackPromise,
                    timeoutPromise
                  ]);
                } catch (err) {
                  if (err instanceof Error && err.message === "CALLBACK_TIMEOUT") {
                    return {
                      type: "failed",
                      error: "Callback timeout - please use CLI with --no-browser flag for manual input"
                    };
                  }
                  throw err;
                }
                const params = extractOAuthCallbackParams(
                  callbackUrl,
                  fallbackState
                );
                if ("error" in params) {
                  return {
                    type: "failed",
                    error: params.error
                  };
                }
                const result = await exchangeAntigravity2(
                  params.code,
                  params.state
                );
                if (result.type === "success") {
                  try {
                    await persistAccountPool2([result], false);
                  } catch (persistError) {
                    return await reportPersistenceFailure(
                      persistError,
                      client,
                      log8
                    );
                  }
                  const newTotal = existingCount + 1;
                  const toastMessage = existingCount > 0 ? `Added account${result.email ? ` (${result.email})` : ""} - ${newTotal} total` : `Authenticated${result.email ? ` (${result.email})` : ""}`;
                  try {
                    await client.tui.showToast({
                      body: {
                        message: toastMessage,
                        variant: "success"
                      }
                    });
                  } catch {
                  }
                }
                return result;
              } catch (error) {
                return {
                  type: "failed",
                  error: error instanceof Error ? error.message : "Unknown error"
                };
              } finally {
                try {
                  await listener.close();
                } catch {
                }
              }
            }
          };
        }
        return {
          url: authorization.url,
          instructions: "Visit the URL above, complete OAuth, then paste either the full redirect URL or the authorization code.",
          method: "code",
          callback: async (codeInput) => {
            const params = parseOAuthCallbackInput(codeInput, fallbackState);
            if ("error" in params) {
              return { type: "failed", error: params.error };
            }
            const result = await exchangeAntigravity2(params.code, params.state);
            if (result.type === "success") {
              try {
                await persistAccountPool2([result], false);
              } catch (persistError) {
                return await reportPersistenceFailure(persistError, client, log8);
              }
              const newTotal = existingCount + 1;
              const toastMessage = existingCount > 0 ? `Added account${result.email ? ` (${result.email})` : ""} - ${newTotal} total` : `Authenticated${result.email ? ` (${result.email})` : ""}`;
              try {
                await client.tui.showToast({
                  body: {
                    message: toastMessage,
                    variant: "success"
                  }
                });
              } catch {
              }
            }
            return result;
          }
        };
      }
    },
    {
      label: "Manually enter API Key",
      type: "api"
    }
  ];
}

// src/plugin/account-command-oauth.ts
var OAUTH_PENDING_TTL_MS = 10 * 60 * 1e3;
var OAUTH_PENDING_CAP = 50;
function createAccountCommandOAuthService(options) {
  const pendingBySession = /* @__PURE__ */ new Map();
  const now = options.now ?? (() => Date.now());
  const cleanupExpired = () => {
    const current = now();
    for (const [sessionId, entry] of pendingBySession) {
      if (current - entry.createdAt > OAUTH_PENDING_TTL_MS) {
        pendingBySession.delete(sessionId);
      }
    }
  };
  const takePending = (sessionId) => {
    cleanupExpired();
    const entry = pendingBySession.get(sessionId);
    if (!entry || now() - entry.createdAt > OAUTH_PENDING_TTL_MS) {
      pendingBySession.delete(sessionId);
      return void 0;
    }
    pendingBySession.delete(sessionId);
    return entry;
  };
  const safeListAccounts = async () => {
    try {
      return await options.listAccounts();
    } catch {
      return [];
    }
  };
  return {
    async start(sessionId) {
      const authorization = await options.authorize();
      const url = new URL(authorization.url);
      const state = url.searchParams.get("state");
      const redirectUri2 = url.searchParams.get("redirect_uri");
      if (!state || !redirectUri2) {
        throw new Error("OAuth authorization URL is missing required state");
      }
      cleanupExpired();
      if (pendingBySession.size >= OAUTH_PENDING_CAP) {
        const oldest = [...pendingBySession.entries()].reduce(
          (previous, current) => current[1].createdAt < previous[1].createdAt ? current : previous
        );
        pendingBySession.delete(oldest[0]);
      }
      pendingBySession.set(sessionId, {
        state,
        verifier: authorization.verifier,
        redirectUri: redirectUri2,
        createdAt: now()
      });
      return { url: authorization.url, accounts: await safeListAccounts() };
    },
    async finish(sessionId, callbackInput, label) {
      const pending = takePending(sessionId);
      if (!pending) {
        return {
          text: "OAuth session expired. Please start again.",
          accounts: await safeListAccounts()
        };
      }
      let callback;
      try {
        callback = parseOAuthCallbackInput(callbackInput, pending.state);
      } catch {
        return {
          text: "OAuth authentication failed: could not parse the callback. Please start a new OAuth flow.",
          accounts: await safeListAccounts()
        };
      }
      if ("error" in callback) {
        return {
          text: `OAuth authentication failed: ${callback.error}. Please start a new OAuth flow.`,
          accounts: await safeListAccounts()
        };
      }
      let result;
      try {
        result = await options.exchange(callback.code, callback.state);
      } catch {
        return {
          text: "OAuth exchange failed due to a network error. Please start a new OAuth flow.",
          accounts: await safeListAccounts()
        };
      }
      if (result.type === "failed") {
        return {
          text: "OAuth authentication failed. Please start a new OAuth flow and try again.",
          accounts: await safeListAccounts()
        };
      }
      const persisted = {
        ...result,
        label: label || result.label
      };
      try {
        await options.persist(persisted);
      } catch {
        return {
          text: "OAuth account could not be saved to disk. Please start a new OAuth flow.",
          accounts: await safeListAccounts()
        };
      }
      try {
        await options.onAfterPersist?.(persisted);
      } catch {
      }
      let accounts;
      try {
        accounts = await options.listAccounts();
      } catch {
        return {
          text: "OAuth account added.",
          accounts: []
        };
      }
      return {
        text: "OAuth account added.",
        accounts
      };
    },
    dispose() {
      pendingBySession.clear();
    }
  };
}

// src/plugin/auth-loader.ts
import { createHash as createHash6 } from "node:crypto";

// src/plugin/accounts.ts
var openCodeStore = {
  load: async () => loadAccounts(),
  saveMerged: async (_path, next) => {
    await saveAccounts(next);
    return next;
  },
  mutate: async (_path, fn) => {
    const current = await loadAccounts() ?? {
      version: 4,
      accounts: [],
      activeIndex: 0
    };
    const next = await fn(current) ?? current;
    await saveAccountsReplace(next);
    return next;
  },
  clear: async () => {
  }
};
var AccountManager2 = class _AccountManager extends AccountManager {
  constructor(authFallback, stored, options = {}) {
    super(authFallback, stored, {
      store: options.store ?? openCodeStore,
      storagePath: options.storagePath ?? getStoragePath(),
      now: options.now,
      random: options.random,
      pid: options.pid ?? process.pid,
      onDiagnostic: options.onDiagnostic ?? ((message, fields) => debugLogToFile(
        fields ? `${message} ${JSON.stringify(fields)}` : message
      ))
    });
  }
  static async loadFromDisk(authFallback) {
    return new _AccountManager(authFallback, await loadAccounts());
  }
};

// src/plugin/refresh-queue.ts
var log9 = createLogger2("refresh-queue");
var DEFAULT_PROACTIVE_REFRESH_CONFIG = {
  enabled: true,
  bufferSeconds: 1800,
  // 30 minutes
  checkIntervalSeconds: 300
  // 5 minutes
};
var ProactiveRefreshQueue = class {
  config;
  client;
  providerId;
  accountManager = null;
  inflightRefresh = null;
  state = {
    isRunning: false,
    intervalHandle: null,
    initialTimeoutHandle: null,
    isRefreshing: false,
    lastCheckTime: 0,
    lastRefreshTime: 0,
    refreshCount: 0,
    errorCount: 0
  };
  constructor(client, providerId, config) {
    this.client = client;
    this.providerId = providerId;
    this.config = {
      ...DEFAULT_PROACTIVE_REFRESH_CONFIG,
      ...config
    };
  }
  /**
   * Set the account manager to use for refresh operations.
   * Must be called before start().
   */
  setAccountManager(manager) {
    this.accountManager = manager;
  }
  /**
   * Check if a token needs proactive refresh.
   * Returns true if the token expires within the buffer period.
   */
  needsRefresh(account) {
    if (!account.expires) {
      return false;
    }
    const now = Date.now();
    const bufferMs = this.config.bufferSeconds * 1e3;
    const refreshThreshold = now + bufferMs;
    return account.expires <= refreshThreshold;
  }
  /**
   * Check if a token is already expired.
   */
  isExpired(account) {
    if (!account.expires) {
      return false;
    }
    return account.expires <= Date.now();
  }
  /**
   * Get all accounts that need proactive refresh.
   */
  getAccountsNeedingRefresh() {
    if (!this.accountManager) {
      return [];
    }
    return this.accountManager.getAccounts().filter((account) => {
      if (account.enabled === false) {
        return false;
      }
      if (this.isExpired(account)) {
        return false;
      }
      return this.needsRefresh(account);
    });
  }
  /**
   * Perform a single refresh check iteration.
   * This is called periodically by the background interval.
   */
  runRefreshCheck() {
    if (this.inflightRefresh) {
      return this.inflightRefresh;
    }
    this.inflightRefresh = this.performRefreshCheck().finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }
  async performRefreshCheck() {
    if (this.state.isRefreshing) {
      return;
    }
    if (!this.accountManager) {
      return;
    }
    this.state.isRefreshing = true;
    this.state.lastCheckTime = Date.now();
    try {
      const accountsToRefresh = this.getAccountsNeedingRefresh();
      if (accountsToRefresh.length === 0) {
        return;
      }
      log9.debug("Found accounts needing refresh", {
        count: accountsToRefresh.length
      });
      for (const account of accountsToRefresh) {
        if (!this.state.isRunning) {
          break;
        }
        try {
          const auth = this.accountManager.toAuthDetails(account);
          const refreshed = await this.refreshToken(auth, account);
          if (refreshed) {
            this.accountManager.updateFromAuth(account, refreshed);
            this.state.refreshCount++;
            this.state.lastRefreshTime = Date.now();
            try {
              await this.accountManager.saveToDisk();
            } catch {
            }
          }
        } catch (error) {
          this.state.errorCount++;
          log9.warn("Failed to refresh account", {
            accountIndex: account.index,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } finally {
      this.state.isRefreshing = false;
    }
  }
  /**
   * Refresh a single token.
   */
  async refreshToken(auth, account) {
    const minutesUntilExpiry = account.expires ? Math.round((account.expires - Date.now()) / 6e4) : "unknown";
    log9.debug("Proactively refreshing token", {
      accountIndex: account.index,
      email: account.email ?? "unknown",
      minutesUntilExpiry
    });
    return refreshAccessToken(auth, this.client, this.providerId);
  }
  /**
   * Start the background refresh queue.
   */
  start() {
    if (this.state.isRunning) {
      return;
    }
    if (!this.config.enabled) {
      log9.debug("Proactive refresh disabled by config");
      return;
    }
    this.state.isRunning = true;
    const intervalMs = this.config.checkIntervalSeconds * 1e3;
    log9.debug("Started proactive refresh queue", {
      checkIntervalSeconds: this.config.checkIntervalSeconds,
      bufferSeconds: this.config.bufferSeconds
    });
    this.state.initialTimeoutHandle = setTimeout(() => {
      this.state.initialTimeoutHandle = null;
      if (this.state.isRunning) {
        this.runRefreshCheck().catch((error) => {
          log9.error("Initial check failed", {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }, 5e3);
    this.state.intervalHandle = setInterval(() => {
      this.runRefreshCheck().catch((error) => {
        log9.error("Check failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, intervalMs);
  }
  /**
   * Stop the background refresh queue.
   */
  stop() {
    if (!this.state.isRunning) {
      return;
    }
    this.state.isRunning = false;
    if (this.state.intervalHandle) {
      clearInterval(this.state.intervalHandle);
      this.state.intervalHandle = null;
    }
    if (this.state.initialTimeoutHandle) {
      clearTimeout(this.state.initialTimeoutHandle);
      this.state.initialTimeoutHandle = null;
    }
    log9.debug("Stopped proactive refresh queue", {
      refreshCount: this.state.refreshCount,
      errorCount: this.state.errorCount
    });
  }
  async dispose() {
    this.stop();
    await this.inflightRefresh;
  }
  /**
   * Get current queue statistics.
   */
  getStats() {
    return { ...this.state };
  }
  /**
   * Check if the queue is currently running.
   */
  isRunning() {
    return this.state.isRunning;
  }
};
function createProactiveRefreshQueue(client, providerId, config) {
  return new ProactiveRefreshQueue(client, providerId, config);
}

// src/plugin/auth-loader.ts
var log10 = createLogger2("auth-loader");
function refreshTokenIdentity(refreshToken) {
  return createHash6("sha256").update(refreshToken).digest("hex").slice(0, 16);
}
function createAuthLoader({
  client,
  providerId,
  config,
  lifecycle,
  createFetch,
  onGetAuth,
  dependencies
}) {
  const deps = {
    loadAccounts: dependencies?.loadAccounts ?? loadAccounts,
    clearAccounts: dependencies?.clearAccounts ?? clearAccounts,
    loadAccountManager: dependencies?.loadAccountManager ?? ((auth) => AccountManager2.loadFromDisk(auth)),
    createRefreshQueue: dependencies?.createRefreshQueue ?? createProactiveRefreshQueue,
    isDebugEnabled: dependencies?.isDebugEnabled ?? isDebugEnabled,
    getLogFilePath: dependencies?.getLogFilePath ?? getLogFilePath
  };
  let fetchRuntime = null;
  let reloadChain = Promise.resolve();
  lifecycle.register(
    {
      async dispose() {
        const runtime = fetchRuntime;
        fetchRuntime = null;
        await runtime?.dispose();
      }
    },
    "producer"
  );
  let reloadRuntime = async () => {
  };
  const installRuntime = async (accountManager, getAuth) => {
    if (accountManager.getAccountCount() > 0) {
      accountManager.requestSaveToDisk();
    }
    let refreshQueue = null;
    if (config.proactive_token_refresh && accountManager.getAccountCount() > 0) {
      refreshQueue = deps.createRefreshQueue(client, providerId, {
        enabled: config.proactive_token_refresh,
        bufferSeconds: config.proactive_refresh_buffer_seconds,
        checkIntervalSeconds: config.proactive_refresh_check_interval_seconds
      });
      refreshQueue.setAccountManager(accountManager);
    }
    await lifecycle.replaceAccountRuntime(accountManager, refreshQueue);
    refreshQueue?.start();
    const previousRuntime = fetchRuntime;
    fetchRuntime = createFetch({ accountManager, getAuth });
    await previousRuntime?.dispose();
    await setSidebarMachineState(
      buildSidebarMachineStateFromAccounts(
        accountManager.getAccounts().map((entry) => {
          const activeByFamily = accountManager.getActiveIndexByFamily();
          return {
            index: entry.index,
            label: entry.label,
            enabled: entry.enabled,
            current: isAccountCurrent(entry.index, activeByFamily),
            coolingDownUntil: entry.coolingDownUntil,
            healthScore: getHealthTracker().getScore(entry.index),
            cachedQuota: entry.cachedQuota,
            // Stamp the sidebar snapshot so the projection can detect a
            // stale cache that landed on the wrong account (the manager's
            // `cachedQuotaAccountId` is keyed to whatever account actually
            // produced the snapshot — the live refresh-token hash is the
            // expected identity at this slot).
            cachedQuotaAccountId: entry.cachedQuotaAccountId,
            currentQuotaAccountId: refreshTokenIdentity(
              entry.parts.refreshToken
            ),
            tier: toCapturedTier(entry)
          };
        })
      )
    );
  };
  async function runLoader(getAuth, provider) {
    onGetAuth?.(getAuth);
    let auth = await getAuth();
    if (!isOAuthAuth(auth)) {
      let storedAccounts;
      try {
        storedAccounts = await deps.loadAccounts();
      } catch (error) {
        if (error instanceof AccountStorageUnreadableError) {
          log10.error("Refusing to start: account storage is unreadable", {
            path: error.details.path,
            reason: error.details.reason,
            backupPath: error.details.backupPath
          });
          try {
            await client.tui.showToast({
              body: {
                message: `Account storage at ${error.details.path} is unreadable (${error.details.reason}). The plugin will not start until the file is repaired or removed.${error.details.backupPath ? ` A backup was written to ${error.details.backupPath}.` : ""}`,
                variant: "error",
                duration: 3e4
              }
            });
          } catch {
          }
        }
        throw error;
      }
      const drift = detectAuthStorageDrift(auth, storedAccounts);
      if (drift.status === "restorable" && drift.account) {
        auth = buildAuthFromStoredAccount(drift.account);
        try {
          await client.auth.set({
            path: { id: providerId },
            body: {
              type: "oauth",
              refresh: auth.refresh,
              access: auth.access ?? "",
              expires: auth.expires ?? 0
            }
          });
          log10.info("Restored Antigravity OAuth auth from account storage", {
            reason: drift.reason,
            email: drift.account.email
          });
        } catch (error) {
          log10.warn(
            "Failed to restore Antigravity OAuth auth from account storage",
            { error: String(error) }
          );
        }
      }
    }
    if (!isOAuthAuth(auth)) {
      try {
        await deps.clearAccounts();
      } catch {
      }
      return {};
    }
    const accountManager = await deps.loadAccountManager(auth);
    await installRuntime(accountManager, getAuth);
    if (deps.isDebugEnabled()) {
      const logPath = deps.getLogFilePath();
      if (logPath) {
        try {
          await client.tui.showToast({
            body: { message: `Debug log: ${logPath}`, variant: "info" }
          });
        } catch {
        }
      }
    }
    if (provider.models) {
      for (const model of Object.values(provider.models)) {
        if (model) model.cost = { input: 0, output: 0 };
      }
    }
    return {
      apiKey: "",
      // Return a stable delegating wrapper that reads `fetchRuntime`
      // at CALL time. A direct `fetchRuntime!.fetch` reference would
      // capture the current runtime; the host keeps that reference
      // across `reload()` calls, so a captured fetch would still route
      // through the OLD interceptor after an OAuth add. The wrapper
      // matches the host's `LoaderResult.fetch` signature exactly
      // (no `this` binding) so behavior is preserved.
      fetch: (input2, init) => fetchRuntime.fetch(input2, init)
    };
  }
  reloadRuntime = async (getAuth) => {
    const auth = await getAuth();
    if (!isOAuthAuth(auth)) return;
    const nextManager = await deps.loadAccountManager(auth);
    await installRuntime(nextManager, getAuth);
  };
  async function authLoaderCallable(getAuth, provider) {
    return runLoader(getAuth, provider);
  }
  async function reload(getAuth) {
    const next = reloadChain.then(() => reloadRuntime(getAuth));
    reloadChain = next.catch(() => {
    });
    return next;
  }
  const authLoader = Object.assign(authLoaderCallable, {
    reload,
    load: authLoaderCallable
  });
  return authLoader;
}

// src/plugin/background-quota-refresh.ts
import { createHash as createHash7 } from "node:crypto";
function quotaAccountIdentity2(refreshToken) {
  return createHash7("sha256").update(refreshToken).digest("hex").slice(0, 16);
}
var MIN_INTERVAL_MS = 6e4;
var STARTUP_JITTER_MS = 3e4;
var ERROR_JITTER_MS = 15e3;
var POLL_LOCK_TTL_MS = 6e4;
var TIER_STALENESS_TTL_MS = 24 * 60 * 60 * 1e3;
var CAPTURED_TIER_SCHEMA_VERSION = 1;
var BackgroundQuotaRefresh = class {
  intervalMs;
  sidebarStateFile;
  getAccountManager;
  quotaManager;
  loadAccountTier;
  now;
  random;
  acquireLock;
  timer = null;
  /** Resolves when the currently-running tick completes (or immediately if none). */
  inFlight = null;
  disposed = false;
  constructor(options) {
    this.intervalMs = options.intervalMs;
    this.sidebarStateFile = options.sidebarStateFile;
    this.getAccountManager = options.getAccountManager;
    this.quotaManager = options.quotaManager;
    this.loadAccountTier = options.loadAccountTier;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.acquireLock = options.acquireLock ?? acquireFencedFileLock;
  }
  /** Start the background timer. Idempotent: a second call is a no-op. */
  start() {
    if (this.disposed || this.timer !== null) return;
    this.scheduleNext(this.jitteredStartDelay());
  }
  /** Stop the timer and await any in-flight tick. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }
  // ── internals ─────────────────────────────────────────────────────────────
  jitteredStartDelay() {
    return Math.floor(this.random() * STARTUP_JITTER_MS);
  }
  jitteredInterval(extraJitterMs = 0) {
    const jitter = Math.floor(this.random() * this.intervalMs * 0.1);
    return this.intervalMs + jitter + extraJitterMs;
  }
  scheduleNext(delayMs) {
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.inFlight !== null) return;
      this.inFlight = this.runTick().catch(() => {
        this.scheduleNext(this.jitteredInterval(ERROR_JITTER_MS));
      }).finally(() => {
        this.inFlight = null;
      });
    }, delayMs);
    if (this.timer.unref) this.timer.unref();
  }
  async runTick() {
    const freshnessThresholdMs = Math.max(
      this.intervalMs - MIN_INTERVAL_MS,
      Math.floor(this.intervalMs / 2)
    );
    const state = readSidebarState(this.sidebarStateFile);
    const ageMs = this.now() - state.checkedAt;
    let lock = null;
    try {
      lock = await this.acquireLock({
        path: this.sidebarStateFile,
        name: "bg-quota-poll",
        ttlMs: POLL_LOCK_TTL_MS
      });
    } catch {
      this.scheduleNext(this.jitteredInterval(ERROR_JITTER_MS));
      return;
    }
    if (lock === null) {
      this.scheduleNext(this.jitteredInterval());
      return;
    }
    try {
      if (ageMs >= freshnessThresholdMs) await this.refresh();
      else await this.refreshTierSlot();
    } finally {
      await lock.release().catch(() => {
      });
    }
    if (!this.disposed) {
      this.scheduleNext(this.jitteredInterval());
    }
  }
  async refresh() {
    const refreshedQuota = await this.refreshQuota();
    await this.refreshTierSlot();
    if (refreshedQuota) await this.pushSnapshot();
  }
  async refreshQuota() {
    if (this.disposed) return false;
    const manager = this.getAccountManager();
    if (!manager) return false;
    const accounts = manager.getAccountsForQuotaCheck();
    if (accounts.length === 0) return false;
    let results;
    try {
      results = await this.quotaManager.refreshAccounts(accounts, {
        indexFor: (account) => accounts.indexOf(account),
        // Do not force: the quota manager's per-account dedup and backoff
        // apply — an account that already refreshed recently is skipped.
        force: false
      });
    } catch {
      return false;
    }
    if (this.disposed) return false;
    const liveAccounts = manager.getAccounts();
    const liveIndexByToken = /* @__PURE__ */ new Map();
    for (const entry of liveAccounts) {
      liveIndexByToken.set(entry.parts.refreshToken, entry.index);
    }
    let anyUpdated = false;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result?.status !== "ok" || !result.quota?.groups) continue;
      const candidateTokens = [
        result.updatedAccount?.refreshToken,
        accounts[i]?.refreshToken
      ].filter((token) => Boolean(token));
      const liveIndex = candidateTokens.map((token) => liveIndexByToken.get(token)).find((index) => index !== void 0);
      if (liveIndex === void 0) continue;
      const liveToken = liveAccounts[liveIndex]?.parts.refreshToken;
      if (!liveToken) continue;
      manager.updateQuotaCache(liveIndex, result.quota.groups, liveToken);
      const uaTier = toCapturedTier(result.updatedAccount ?? {});
      if (uaTier !== void 0) {
        manager.applyUpdatedAccount(
          liveIndex,
          {
            capturedTierId: uaTier.id,
            ...uaTier.paidId !== void 0 ? { capturedPaidTierId: uaTier.paidId } : {},
            capturedTierAt: uaTier.capturedAt,
            capturedTierSchemaVersion: CAPTURED_TIER_SCHEMA_VERSION
          },
          liveToken
        );
      }
      anyUpdated = true;
    }
    if (anyUpdated) manager.requestSaveToDisk();
    return true;
  }
  async refreshTierSlot() {
    if (this.disposed || !this.loadAccountTier) return;
    const manager = this.getAccountManager();
    if (!manager) return;
    const liveAccounts = manager.getAccounts();
    const accounts = manager.getAccountsForQuotaCheck();
    const accountByToken = new Map(
      accounts.map((account) => [account.refreshToken, account])
    );
    const now = this.now();
    let stalestEntry;
    for (const entry of liveAccounts) {
      const needsPaidTierBackfill = entry.capturedPaidTierId === void 0 && entry.capturedTierSchemaVersion !== CAPTURED_TIER_SCHEMA_VERSION;
      const isTierStale = entry.capturedTierAt === void 0 || now - entry.capturedTierAt >= TIER_STALENESS_TTL_MS || needsPaidTierBackfill;
      if (isTierStale && (stalestEntry === void 0 || (entry.capturedTierAt ?? 0) < (stalestEntry.capturedTierAt ?? 0))) {
        stalestEntry = entry;
      }
    }
    if (stalestEntry === void 0) return;
    const refreshToken = stalestEntry.parts.refreshToken;
    const accountForTier = accountByToken.get(refreshToken);
    if (!accountForTier) return;
    try {
      const tier = await this.loadAccountTier(accountForTier);
      if (tier === null || this.disposed) return;
      const liveEntry = manager.getAccounts().find((entry) => entry.parts.refreshToken === refreshToken);
      if (!liveEntry) return;
      manager.applyUpdatedAccount(
        liveEntry.index,
        {
          capturedTierId: tier.id,
          ...tier.paidId !== void 0 ? { capturedPaidTierId: tier.paidId } : {},
          capturedTierAt: tier.capturedAt,
          capturedTierSchemaVersion: CAPTURED_TIER_SCHEMA_VERSION
        },
        refreshToken
      );
      manager.requestSaveToDisk();
    } catch {
    }
  }
  async pushSnapshot() {
    const getAccounts = () => {
      const m = this.getAccountManager();
      return m ? m.getAccounts() : null;
    };
    await pushSidebarQuotaSnapshot(
      () => {
        const accts = getAccounts();
        if (!accts) return null;
        return accts.map((entry) => ({
          index: entry.index,
          label: entry.label,
          enabled: entry.enabled,
          coolingDownUntil: entry.coolingDownUntil,
          cachedQuota: entry.cachedQuota,
          cachedQuotaAccountId: entry.cachedQuotaAccountId,
          // Derive current identity from the LIVE refresh token, independent
          // of whatever stamp the cached snapshot carries. Mirrors index.ts's
          // two correct call sites so the sidebar can detect a stale snapshot
          // after an account reorder.
          currentQuotaAccountId: quotaAccountIdentity2(entry.parts.refreshToken),
          tier: toCapturedTier(entry)
        }));
      },
      0,
      () => {
        const m = this.getAccountManager();
        return m ? m.getActiveIndexByFamily() : null;
      }
    ).catch(() => {
    });
  }
};

// src/plugin/gemini-dump.ts
import { createHash as createHash8 } from "node:crypto";
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync6, writeFileSync as writeFileSync6 } from "node:fs";
import { tmpdir as tmpdir3 } from "node:os";
import { join as join13 } from "node:path";
var GEMINI_DUMP_COMMAND_NAME = "gemini-dump";
var DUMP_STATUS_TITLE = "## Gemini Dump Status";
var DUMP_ENABLED_TITLE = "## Gemini Dump Enabled";
var DUMP_DISABLED_TITLE = "## Gemini Dump Disabled";
var DUMP_USAGE_TITLE = "## Gemini Dump Usage";
var DUMP_USAGE = "Usage: `/gemini-dump`, `/gemini-dump on`, or `/gemini-dump off`.";
var DUMP_DIR_ENV = "OPENCODE_ANTIGRAVITY_GEMINI_DUMP_DIR";
var DEFAULT_DUMP_DIR = join13(tmpdir3(), "opencode-antigravity-gemini-dumps");
var DUMP_DIR_MODE = 448;
var DUMP_FILE_MODE = 384;
var dumpEnabled = process.env.OPENCODE_ANTIGRAVITY_GEMINI_DUMP === "1";
var nextDumpId = 0;
function setGeminiDumpEnabled(enabled) {
  dumpEnabled = enabled;
}
function getGeminiDumpDirectory() {
  return process.env[DUMP_DIR_ENV] || DEFAULT_DUMP_DIR;
}
function parseGeminiDumpCommandAction(argumentsText) {
  const normalized = argumentsText.trim().split(/\s+/).filter(Boolean);
  if (normalized.length === 0) return { type: "status" };
  if (normalized.length === 1 && normalized[0] === "on")
    return { type: "enable" };
  if (normalized.length === 1 && normalized[0] === "off")
    return { type: "disable" };
  return { type: "usage" };
}
function buildGeminiDumpStatusSummary(input2) {
  const enabled = input2?.enabled ?? dumpEnabled;
  return [
    DUMP_STATUS_TITLE,
    "",
    `- Enabled: ${enabled ? "enabled" : "disabled"}`,
    `- Directory: ${getGeminiDumpDirectory()}`,
    "- Captures: final Antigravity request body plus raw response SSE/text chunks",
    "- Warning: dumps contain prompt/session content; turn this off after debugging"
  ].join("\n");
}
function executeGeminiDumpCommand(input2) {
  const action = parseGeminiDumpCommandAction(input2.argumentsText);
  const enabled = input2.enabled ?? dumpEnabled;
  if (action.type === "status") return buildGeminiDumpStatusSummary({ enabled });
  if (action.type === "enable") {
    return [
      DUMP_ENABLED_TITLE,
      "",
      buildGeminiDumpStatusSummary({ enabled: true })
    ].join("\n");
  }
  if (action.type === "disable") {
    return [
      DUMP_DISABLED_TITLE,
      "",
      buildGeminiDumpStatusSummary({ enabled: false })
    ].join("\n");
  }
  return [
    DUMP_USAGE_TITLE,
    "",
    DUMP_USAGE,
    "",
    buildGeminiDumpStatusSummary({ enabled })
  ].join("\n");
}
function hashText2(value) {
  return createHash8("sha256").update(value).digest("hex");
}
function maskIdentifier(value) {
  if (typeof value !== "string" || value.length === 0) return void 0;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}
function redactProjectId(value) {
  return maskIdentifier(value);
}
function redactSessionId(value) {
  return maskIdentifier(value);
}
function redactForDump(value) {
  if (Array.isArray(value)) return value.map(redactForDump);
  if (value == null || typeof value !== "object") return value;
  const redacted = {};
  for (const [key, entry] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key" || lower === "cookie" || lower === "set-cookie") {
      redacted[key] = "[redacted]";
      continue;
    }
    if (lower === "user-agent") {
      redacted[key] = typeof entry === "string" ? maskIdentifier(entry) : entry;
      continue;
    }
    redacted[key] = redactForDump(entry);
  }
  return redacted;
}
function headersToRecord2(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const record = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}
function parseBody(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function collectToolNames(value) {
  const names = [];
  const walk = (entry) => {
    if (Array.isArray(entry)) {
      for (const item of entry) walk(item);
      return;
    }
    if (!entry || typeof entry !== "object") return;
    const record = entry;
    const declarations = record.functionDeclarations;
    if (Array.isArray(declarations)) {
      for (const declaration of declarations) {
        if (declaration && typeof declaration === "object") {
          const name = declaration.name;
          if (typeof name === "string") names.push(name);
        }
      }
    }
    for (const item of Object.values(record)) walk(item);
  };
  walk(value);
  return names;
}
function bodyStructureSummary(bodyText) {
  const parsed = parseBody(bodyText);
  if (!parsed) return { parseable: false };
  const request = parsed.request && typeof parsed.request === "object" ? parsed.request : void 0;
  const contents = Array.isArray(request?.contents) ? request.contents : [];
  const toolNames = collectToolNames(request ?? parsed);
  return {
    parseable: true,
    model: typeof parsed.model === "string" ? parsed.model : void 0,
    requestId: typeof parsed.requestId === "string" ? parsed.requestId : void 0,
    requestType: typeof parsed.requestType === "string" ? parsed.requestType : void 0,
    contentsCount: contents.length,
    toolsCount: toolNames.length,
    toolsHash: hashText2(toolNames.join("\n")),
    toolsFirst: toolNames.slice(0, 20),
    toolsLast: toolNames.slice(-10),
    bodyHash: hashText2(bodyText),
    bodyBytes: bodyText.length
  };
}
function writeJson(path5, value) {
  writeFileSync6(path5, `${JSON.stringify(value, null, 2)}
`, {
    encoding: "utf8",
    mode: DUMP_FILE_MODE
  });
}
function updateMetadata(context, patch) {
  context.metadata = {
    ...context.metadata,
    ...patch,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  writeJson(context.files.metadata, context.metadata);
}
function dumpGeminiRequest(input2) {
  if (!dumpEnabled) return null;
  if (typeof input2.body !== "string") return null;
  nextDumpId += 1;
  const id = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-${String(nextDumpId).padStart(5, "0")}-${input2.streaming ? "stream" : "json"}`;
  const dumpDir = getGeminiDumpDirectory();
  const prefix = join13(dumpDir, id);
  mkdirSync6(dumpDir, { recursive: true, mode: DUMP_DIR_MODE });
  const context = {
    id,
    files: {
      request: `${prefix}.request.json`,
      response: `${prefix}.response.raw`,
      metadata: `${prefix}.meta.json`
    },
    metadata: {
      id,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      originalUrl: input2.originalUrl,
      resolvedUrl: input2.resolvedUrl,
      method: input2.method,
      streaming: input2.streaming,
      requestedModel: input2.requestedModel,
      effectiveModel: input2.effectiveModel,
      sessionId: redactSessionId(input2.sessionId),
      projectId: redactProjectId(input2.projectId),
      headers: redactForDump(headersToRecord2(input2.headers)),
      request: bodyStructureSummary(input2.body),
      files: {
        request: `${prefix}.request.json`,
        response: `${prefix}.response.raw`,
        metadata: `${prefix}.meta.json`
      }
    }
  };
  writeFileSync6(context.files.request, redactJsonBodyString(input2.body), {
    encoding: "utf8",
    mode: DUMP_FILE_MODE
  });
  writeFileSync6(context.files.response, "", {
    encoding: "utf8",
    mode: DUMP_FILE_MODE
  });
  writeJson(context.files.metadata, context.metadata);
  return context;
}
function noteGeminiDumpResponse(context, response) {
  if (!context) return;
  updateMetadata(context, {
    responseStatus: response.status,
    responseStatusText: response.statusText,
    responseHeaders: redactForDump(headersToRecord2(response.headers))
  });
}
function appendGeminiDumpResponseText(context, text) {
  if (!context) return;
  appendFileSync2(context.files.response, text, "utf8");
  updateMetadata(context, {
    responseBytes: text.length,
    responseHash: hashText2(text)
  });
}
function createGeminiDumpResponseTransform(context) {
  if (!context) return null;
  return new TransformStream({
    transform(chunk, controller) {
      appendFileSync2(context.files.response, Buffer.from(chunk));
      controller.enqueue(chunk);
    }
  });
}

// src/plugin/operator-settings.ts
import { readFileSync as readFileSync10 } from "node:fs";
import { z as z3 } from "zod";

// src/plugin/config/operator-settings-schema.ts
import { z } from "zod";
var OperatorSettingsSchema = z.object({
  routing: z.object({
    cli_first: z.boolean(),
    quota_style_fallback: z.boolean()
  }),
  killswitch: z.object({
    enabled: z.boolean(),
    minimum_remaining_percent: z.number().min(0).max(100),
    accounts: z.record(z.string(), z.number().min(0).max(100)).optional()
  }),
  log_level: z.enum(["error", "warn", "info", "debug", "trace"])
});
function emptyOperatorSettings() {
  return {
    routing: { cli_first: false, quota_style_fallback: false },
    killswitch: { enabled: false, minimum_remaining_percent: 5 },
    log_level: "info"
  };
}

// src/plugin/config/writer.ts
import { existsSync as existsSync7, readFileSync as readFileSync9 } from "node:fs";
import { z as z2 } from "zod";
async function writeOperatorConfig(options) {
  const operator = OperatorSettingsSchema.parse(options.operator);
  const target = existsSync7(options.projectConfigPath) ? options.projectConfigPath : options.userConfigPath;
  const lock = await acquireFencedFileLock({
    path: target,
    name: "antigravity-operator",
    ttlMs: 5e3,
    renew: false
  });
  if (!lock) {
    throw new Error(
      `Could not acquire operator-config lock at ${target} (already held by another writer).`
    );
  }
  try {
    const existing = readExistingConfig(target);
    const merged = mergeOperator(existing, operator);
    await writeJsonAtomic(target, merged);
  } finally {
    await lock.release().catch(() => {
    });
  }
}
function readExistingConfig(target) {
  if (!existsSync7(target)) return {};
  try {
    const raw = readFileSync9(target, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}
function mergeOperator(existing, operator) {
  const next = { ...existing };
  next.operator = operator;
  return next;
}

// src/plugin/operator-settings.ts
var PartialOperatorSettingsSchema = z3.object({
  routing: z3.object({
    cli_first: z3.boolean().optional(),
    quota_style_fallback: z3.boolean().optional()
  }).optional(),
  killswitch: z3.object({
    enabled: z3.boolean().optional(),
    minimum_remaining_percent: z3.number().min(0).max(100).optional(),
    accounts: z3.record(z3.string(), z3.number().min(0).max(100)).optional()
  }).optional(),
  log_level: z3.enum(["error", "warn", "info", "debug", "trace"]).optional()
});
function createOperatorSettingsController(options) {
  let cached = null;
  let disposed = false;
  let pending = null;
  const loadFromDisk = () => {
    const existing = readOperatorFile(options.projectConfigPath);
    if (existing) return existing;
    const fromUser = readOperatorFile(options.userConfigPath);
    if (fromUser) return fromUser;
    return emptyOperatorSettings();
  };
  const persist = async (next) => {
    if (pending) await pending;
    pending = writeOperatorConfig({
      projectConfigPath: options.projectConfigPath,
      userConfigPath: options.userConfigPath,
      operator: next
    });
    try {
      await pending;
    } finally {
      pending = null;
    }
  };
  return {
    get() {
      if (!cached) cached = loadFromDisk();
      return cached;
    },
    async update(mutator) {
      if (disposed) throw new Error("OperatorSettingsController is disposed");
      const current = cached ?? loadFromDisk();
      const draft = JSON.parse(
        JSON.stringify(current)
      );
      mutator(draft);
      const validated = OperatorSettingsSchema.parse(draft);
      cached = validated;
      await persist(validated);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (pending) {
        try {
          await pending;
        } catch {
        }
      }
    }
  };
}
function readOperatorFile(path5) {
  try {
    const raw = readFileSync10(path5, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || !("operator" in parsed)) {
      return null;
    }
    const partial = PartialOperatorSettingsSchema.safeParse(
      parsed.operator
    );
    if (!partial.success) return null;
    return mergeWithDefaults(partial.data);
  } catch {
    return null;
  }
}
function mergeWithDefaults(partial) {
  const defaults = emptyOperatorSettings();
  return {
    routing: { ...defaults.routing, ...partial.routing ?? {} },
    killswitch: {
      ...defaults.killswitch,
      ...partial.killswitch ?? {},
      accounts: {
        ...defaults.killswitch.accounts ?? {},
        ...partial.killswitch?.accounts ?? {}
      }
    },
    log_level: partial.log_level ?? defaults.log_level
  };
}

// src/plugin/prompt-context.ts
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}
function extractMessages(response) {
  if (Array.isArray(response)) return response;
  if (isRecord2(response) && Array.isArray(response.data)) return response.data;
  return [];
}
function getRole(message) {
  if (!isRecord2(message) || !isRecord2(message.info)) return void 0;
  return typeof message.info.role === "string" ? message.info.role : void 0;
}
function extractFromMessage(message) {
  if (!isRecord2(message) || !isRecord2(message.info)) return null;
  const info = message.info;
  const modelInfo = isRecord2(info.model) ? info.model : void 0;
  const agent = typeof info.agent === "string" ? info.agent : void 0;
  const providerID = typeof modelInfo?.providerID === "string" ? modelInfo.providerID : typeof info.providerID === "string" ? info.providerID : void 0;
  const modelID = typeof modelInfo?.modelID === "string" ? modelInfo.modelID : typeof info.modelID === "string" ? info.modelID : void 0;
  const variant = typeof modelInfo?.variant === "string" ? modelInfo.variant : typeof info.variant === "string" ? info.variant : void 0;
  if (!agent && (!providerID || !modelID) && !variant) return null;
  const context = {};
  if (agent) context.agent = agent;
  if (providerID && modelID) context.model = { providerID, modelID };
  if (variant) context.variant = variant;
  return context;
}
function mergeContexts(base, patch) {
  return {
    agent: base.agent ?? patch.agent,
    model: base.model ?? patch.model,
    variant: base.variant ?? patch.variant
  };
}
function isComplete(context) {
  return Boolean(context.agent && context.model && context.variant);
}
async function resolvePromptContext(client, sessionId) {
  if (!client || !sessionId) return null;
  const typedClient = client;
  if (typeof typedClient.session?.messages !== "function") return null;
  let messages = [];
  try {
    messages = extractMessages(
      await Promise.resolve(
        typedClient.session.messages({
          path: { id: sessionId },
          query: { limit: 100 }
        })
      )
    );
  } catch {
    return null;
  }
  if (messages.length === 0) return null;
  let result = {};
  for (let index = messages.length - 1; index >= 0; index--) {
    if (getRole(messages[index]) !== "assistant") continue;
    const context = extractFromMessage(messages[index]);
    if (!context) continue;
    result = mergeContexts(result, context);
    if (isComplete(result)) return result;
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    const context = extractFromMessage(messages[index]);
    if (!context) continue;
    result = mergeContexts(result, context);
    if (isComplete(result)) return result;
  }
  if (!result.agent && !result.model && !result.variant) return null;
  return result;
}

// src/plugin/commands.ts
var log11 = createLogger2("commands");
var ANTIGRAVITY_QUOTA_COMMAND_NAME = "antigravity-quota";
var ANTIGRAVITY_ACCOUNT_COMMAND_NAME = "antigravity-account";
var ANTIGRAVITY_ROUTING_COMMAND_NAME = "antigravity-routing";
var ANTIGRAVITY_KILLSWITCH_COMMAND_NAME = "antigravity-killswitch";
var ANTIGRAVITY_DUMP_COMMAND_NAME = "antigravity-dump";
var ANTIGRAVITY_LOGGING_COMMAND_NAME = "antigravity-logging";
var MODAL_COMMANDS = [
  ANTIGRAVITY_QUOTA_COMMAND_NAME,
  ANTIGRAVITY_ACCOUNT_COMMAND_NAME,
  ANTIGRAVITY_ROUTING_COMMAND_NAME,
  ANTIGRAVITY_KILLSWITCH_COMMAND_NAME,
  ANTIGRAVITY_DUMP_COMMAND_NAME,
  ANTIGRAVITY_LOGGING_COMMAND_NAME
];
var HANDLED_COMMAND_SENTINEL = "ANTIGRAVITY_COMMAND_HANDLED";
async function sendIgnoredMessage(client, sessionID, text) {
  const session = client.session;
  const promptContext = await resolvePromptContext(client, sessionID);
  const request = {
    path: { id: sessionID },
    body: {
      noReply: true,
      parts: [{ type: "text", text, ignored: true }],
      ...promptContext?.agent ? { agent: promptContext.agent } : {},
      ...promptContext?.model ? { model: promptContext.model } : {},
      ...promptContext?.variant ? { variant: promptContext.variant } : {}
    }
  };
  if (typeof session?.promptAsync === "function") {
    await session.promptAsync(request);
    return;
  }
  if (typeof session?.prompt === "function") {
    await Promise.resolve(session.prompt(request));
    return;
  }
  throw new Error(
    "OpenCode session prompt API is unavailable for ignored replies."
  );
}
function throwHandledCommandSentinel() {
  throw new Error(HANDLED_COMMAND_SENTINEL);
}
async function buildDialogPayload(command, argumentsText, context) {
  switch (command) {
    case "antigravity-quota": {
      const action = argumentsText.trim().toLowerCase();
      const accounts = context.commandData ? await context.commandData.listAccounts() : [];
      if (context.commandData) {
        void context.commandData.refreshQuotaRespectingBackoff().catch(() => {
        });
      }
      return {
        command,
        text: "Antigravity quota",
        knobs: {
          mode: action === "refresh" ? "refresh" : "status",
          accounts
        }
      };
    }
    case "antigravity-account": {
      const action = argumentsText.trim().toLowerCase();
      const accounts = context.commandData ? await context.commandData.listAccounts() : [];
      return {
        command,
        text: "Antigravity accounts",
        knobs: {
          action: action === "add" || action === "refresh" || action === "remove" || action === "list" ? action : "list",
          accounts
        }
      };
    }
    case "antigravity-routing": {
      const settings = context.settings.get();
      const parsed = parseToggleArguments(argumentsText);
      const currentMode = settings.account_selection_strategy || "main-first";
      return {
        command,
        text: `Google routing (${currentMode})`,
        knobs: {
          mode: currentMode,
          cli_first: parsed.cli_first ?? settings.routing.cli_first,
          quota_style_fallback: parsed.quota_style_fallback ?? settings.routing.quota_style_fallback,
          timeoutMs: 2e3
        }
      };
    }
    case "antigravity-killswitch": {
      const settings = context.settings.get();
      const parsed = parseKillswitchArguments(argumentsText);
      return {
        command,
        text: "Antigravity killswitch",
        knobs: {
          enabled: parsed.enabled ?? settings.killswitch.enabled,
          minimum_remaining_percent: parsed.minimum_remaining_percent ?? settings.killswitch.minimum_remaining_percent,
          accounts: settings.killswitch.accounts ?? {},
          timeoutMs: 2e3
        }
      };
    }
    case "antigravity-dump": {
      const action = parseGeminiDumpCommandAction(argumentsText);
      return {
        command,
        text: "Antigravity wire dump",
        knobs: {
          mode: action.type === "usage" ? "status" : action.type
        }
      };
    }
    case "antigravity-logging": {
      const level = parseLoggingLevel(argumentsText);
      return {
        command,
        text: "Antigravity logging",
        knobs: { log_level: level }
      };
    }
    default: {
      const exhaustiveCheck = command;
      throw new Error(`Unknown command ${exhaustiveCheck}`);
    }
  }
}
function parseToggleArguments(input2) {
  const result = {};
  for (const part of input2.split(/\s+/).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim().toLowerCase();
    if (key === "cli_first" || key === "cli-first") {
      result.cli_first = value === "true" || value === "1" || value === "on";
    } else if (key === "quota_style_fallback" || key === "quota-style-fallback") {
      result.quota_style_fallback = value === "true" || value === "1" || value === "on";
    }
  }
  return result;
}
function parseKillswitchArguments(input2) {
  const result = {};
  for (const part of input2.split(/\s+/).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim().toLowerCase();
    if (key === "enabled") {
      result.enabled = value === "true" || value === "1" || value === "on";
    } else if (key === "minimum_remaining_percent" || key === "minimum-remaining-percent") {
      const n = Number.parseFloat(value);
      if (!Number.isNaN(n) && n >= 0 && n <= 100) {
        result.minimum_remaining_percent = n;
      }
    }
  }
  return result;
}
function parseLoggingLevel(input2) {
  const trimmed = input2.trim().toLowerCase();
  if (trimmed === "error" || trimmed === "warn" || trimmed === "info" || trimmed === "debug" || trimmed === "trace") {
    return trimmed;
  }
  return "info";
}
function parseAccountAction(input2) {
  const trimmed = input2.trim();
  if (!trimmed) return { kind: "refresh" };
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const head = parts[0]?.toLowerCase();
  if (head === "add") return { kind: "add" };
  if (head === "add-oauth-start" && parts.length === 1) {
    return { kind: "add-oauth-start" };
  }
  if (head === "add-oauth-finish") {
    const code = parts[1];
    if (!code) return void 0;
    const labelAt = parts.indexOf("--label");
    const label = labelAt === -1 ? void 0 : parts.slice(labelAt + 1).join(" ").trim();
    return { kind: "add-oauth-finish", code, label: label || void 0 };
  }
  if (head === "refresh") return { kind: "refresh" };
  if (head === "current" || head === "toggle" || head === "remove") {
    const raw = parts[1];
    if (raw === void 0) return void 0;
    const index = Number.parseInt(raw, 10);
    if (!Number.isInteger(index) || index < 0) return void 0;
    return { kind: head, index };
  }
  return void 0;
}
async function applyCommand(request, context) {
  const result = await applyCommandInner(request, context);
  if (context.onApplied) {
    const accounts = result.knobs.accounts;
    await Promise.resolve(
      context.onApplied(
        Array.isArray(accounts) ? accounts : void 0
      )
    ).catch(() => {
    });
  }
  return result;
}
async function runAccountMutation(context, call) {
  if (!context.commandData) {
    return {
      kind: "error",
      text: "Command data service is not wired; account mutations are disabled."
    };
  }
  try {
    const rows = await call();
    if (rows == null) return { kind: "not-found" };
    return { kind: "rows", rows };
  } catch (error) {
    if (error instanceof AccountStorageUnreadableError) {
      log11.warn("account mutation: locked storage is unreadable", {
        error: error.message
      });
      return {
        kind: "error",
        text: `Account storage is unreadable: ${error.details.reason}. The mutation was not applied.`
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    log11.warn("account mutation failed", { error: message });
    return {
      kind: "error",
      text: `Account mutation failed: ${message}`
    };
  }
}
function notFoundResult(verb, index) {
  return {
    text: `Cannot ${verb}: account ${index} not found`,
    knobs: { action: verb, timeoutMs: 2e3 }
  };
}
function errorResult(verb, text) {
  return {
    text,
    knobs: { action: verb, timeoutMs: 2e3, error: true }
  };
}
async function applyCommandInner(request, context) {
  switch (request.command) {
    case "antigravity-quota": {
      const accounts = context.commandData ? await context.commandData.refreshQuota() : [];
      return {
        text: "Quota refreshed",
        knobs: { accounts, timeoutMs: 2e3 }
      };
    }
    case "antigravity-account": {
      const args = request.arguments.trim();
      const parsed = parseAccountAction(args);
      if (!parsed) {
        return {
          text: `Unknown account action: ${args}`,
          knobs: { action: "unknown", timeoutMs: 2e3 }
        };
      }
      if (parsed.kind === "add-oauth-start") {
        if (!context.accountOAuth) {
          return {
            text: "OAuth account add is unavailable.",
            knobs: { timeoutMs: 12e4, error: true }
          };
        }
        const result = await context.accountOAuth.start(context.sessionID);
        return {
          text: `Open this URL in your browser:
${result.url}`,
          knobs: {
            oauthUrl: result.url,
            accounts: result.accounts,
            timeoutMs: 12e4
          }
        };
      }
      if (parsed.kind === "add-oauth-finish") {
        if (!context.accountOAuth) {
          return {
            text: "OAuth account add is unavailable.",
            knobs: { timeoutMs: 12e4, error: true }
          };
        }
        const result = parsed.label ? await context.accountOAuth.finish(
          context.sessionID,
          parsed.code,
          parsed.label
        ) : await context.accountOAuth.finish(context.sessionID, parsed.code);
        return {
          text: result.text,
          knobs: { accounts: result.accounts, timeoutMs: 12e4 }
        };
      }
      if (parsed.kind === "current") {
        const result = await runAccountMutation(
          context,
          () => context.commandData?.setCurrentAccount(parsed.index)
        );
        if (result.kind === "not-found") {
          return notFoundResult("set current", parsed.index);
        }
        if (result.kind === "error") {
          return errorResult("current", result.text);
        }
        return {
          text: "Current account updated",
          knobs: {
            accounts: result.rows,
            action: "current",
            timeoutMs: 2e3
          }
        };
      }
      if (parsed.kind === "toggle") {
        const result = await runAccountMutation(
          context,
          () => context.commandData?.toggleAccountEnabled(parsed.index)
        );
        if (result.kind === "not-found") {
          return notFoundResult("toggle", parsed.index);
        }
        if (result.kind === "error") {
          return errorResult("toggle", result.text);
        }
        return {
          text: "Account enabled state updated",
          knobs: {
            accounts: result.rows,
            action: "toggle",
            timeoutMs: 2e3
          }
        };
      }
      if (parsed.kind === "remove") {
        const result = await runAccountMutation(
          context,
          () => context.commandData?.removeAccount(parsed.index)
        );
        if (result.kind === "not-found") {
          return notFoundResult("remove", parsed.index);
        }
        if (result.kind === "error") {
          return errorResult("remove", result.text);
        }
        return {
          text: "Account removed",
          knobs: {
            accounts: result.rows,
            action: "remove",
            timeoutMs: 2e3
          }
        };
      }
      return {
        text: `Account ${parsed.kind} requested`,
        knobs: { action: parsed.kind, timeoutMs: 12e4 }
      };
    }
    case "antigravity-routing": {
      const rawArg = (request.arguments || "").trim().toLowerCase();
      if (["main-first", "fallback-first", "sticky-balanced", "round-robin"].includes(rawArg)) {
        try {
          const configPath = getUserConfigPath();
          let cfg = {};
          if (existsSync8(configPath)) {
            try { cfg = JSON.parse(readFileSync11(configPath, "utf-8")); } catch {}
          }
          cfg.account_selection_strategy = rawArg;
          delete cfg.routing_mode;
          if (rawArg === "main-first") {
            cfg.scheduling_mode = "cache_first";
            cfg.switch_on_first_rate_limit = false;
          } else if (rawArg === "sticky-balanced") {
            cfg.scheduling_mode = "balance";
            cfg.switch_on_first_rate_limit = true;
          } else if (rawArg === "round-robin") {
            cfg.scheduling_mode = "performance_first";
            cfg.switch_on_first_rate_limit = true;
          } else if (rawArg === "fallback-first") {
            cfg.scheduling_mode = "balance";
            cfg.switch_on_first_rate_limit = true;
          }
          await writeJsonAtomic(configPath, cfg);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log12.warn("routing update failed", { error: message });
          return { text: `Routing update failed: ${message}`, knobs: { timeoutMs: 2e3, error: true } };
        }
        return { text: `Google routing set to ${rawArg}`, knobs: { mode: rawArg, timeoutMs: 2e3 } };
      }
      const parsed = parseToggleArguments(request.arguments);
      try {
        await context.settings.update((draft) => {
          if (parsed.cli_first !== void 0) {
            draft.routing.cli_first = parsed.cli_first;
          }
          if (parsed.quota_style_fallback !== void 0) {
            draft.routing.quota_style_fallback = parsed.quota_style_fallback;
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log11.warn("routing update failed", { error: message });
        return {
          text: `Routing update failed: ${message}`,
          knobs: { timeoutMs: 2e3, error: true }
        };
      }
      const after = context.settings.get();
      return {
        text: "Routing updated",
        knobs: {
          cli_first: after.routing.cli_first,
          quota_style_fallback: after.routing.quota_style_fallback,
          timeoutMs: 2e3
        }
      };
    }
    case "antigravity-killswitch": {
      const parsed = parseKillswitchArguments(request.arguments);
      try {
        await context.settings.update((draft) => {
          if (parsed.enabled !== void 0) {
            draft.killswitch.enabled = parsed.enabled;
          }
          if (parsed.minimum_remaining_percent !== void 0) {
            draft.killswitch.minimum_remaining_percent = parsed.minimum_remaining_percent;
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log11.warn("killswitch update failed", { error: message });
        return {
          text: `Killswitch update failed: ${message}`,
          knobs: { timeoutMs: 2e3, error: true }
        };
      }
      const after = context.settings.get();
      return {
        text: "Killswitch updated",
        knobs: {
          enabled: after.killswitch.enabled,
          minimum_remaining_percent: after.killswitch.minimum_remaining_percent,
          accounts: after.killswitch.accounts ?? {},
          timeoutMs: 2e3
        }
      };
    }
    case "antigravity-dump": {
      const action = parseGeminiDumpCommandAction(request.arguments);
      if (action.type === "enable") setGeminiDumpEnabled(true);
      else if (action.type === "disable") setGeminiDumpEnabled(false);
      return {
        text: executeGeminiDumpCommand({
          argumentsText: request.arguments
        }),
        knobs: { timeoutMs: 2e3 }
      };
    }
    case "antigravity-logging": {
      const level = parseLoggingLevel(request.arguments);
      await context.settings.update((draft) => {
        draft.log_level = level;
      });
      return {
        text: `Logging level set to ${level}`,
        knobs: { log_level: level, timeoutMs: 2e3 }
      };
    }
    default: {
      const exhaustiveCheck = request.command;
      throw new Error(`Unknown command ${exhaustiveCheck}`);
    }
  }
}
function createSidebarRefresher(getAccounts) {
  return async (dialogAccounts) => {
    const liveByIndex = /* @__PURE__ */ new Map();
    try {
      const live = getAccounts();
      if (live) {
        for (const entry of live)
          liveByIndex.set(entry.index, entry.coolingDownUntil);
      }
    } catch {
    }
    const accounts = dialogAccounts ? dialogAccounts.map((entry) => {
      const liveCooldown = "coolingDownUntil" in entry ? entry.coolingDownUntil : liveByIndex.get(entry.index);
      return {
        index: entry.index,
        label: entry.label,
        enabled: entry.enabled,
        current: entry.current,
        coolingDownUntil: liveCooldown,
        healthScore: entry.healthScore,
        tier: entry.tier,
        // Rebuild cachedQuota carrying the windows array so the sidebar
        // doesn't collapse from per-window rows to a single aggregate bar
        // after every apply. Mirrors the QuotaGroupSummary shape expected
        // by projectQuotaPoolForSidebar inside buildSidebarMachineStateFromAccounts.
        cachedQuota: Object.fromEntries(
          entry.quota.flatMap((group) => {
            if (group.remainingPercent == null) return [];
            return [
              [
                group.key,
                {
                  remainingFraction: group.remainingPercent / 100,
                  ...group.resetAt === void 0 ? {} : { resetTime: new Date(group.resetAt).toISOString() },
                  ...group.windows && group.windows.length > 0 ? {
                    windows: group.windows.map((w) => ({
                      window: w.window,
                      remainingFraction: w.remainingPercent / 100,
                      resetTime: typeof w.resetAt === "number" && Number.isFinite(w.resetAt) ? new Date(w.resetAt).toISOString() : ""
                    }))
                  } : {}
                }
              ]
            ];
          })
        )
      };
    }) : getAccounts();
    if (!accounts || accounts.length === 0) return;
    try {
      await setSidebarMachineState(
        buildSidebarMachineStateFromAccounts(
          accounts
        )
      );
    } catch {
    }
  };
}
function createCommandExecuteBefore(client, settings, pushNotification2, commandData, connectionState = {
  isTuiConnected
}) {
  const context = {
    client,
    sessionID: "",
    settings,
    commandData
  };
  return async (input2, output) => {
    if (input2.command === "google-routing") {
      input2.command = "antigravity-routing";
    }
    if (input2.command === "google-quota") {
      input2.command = "antigravity-quota";
    }
    const command = input2.command;
    if (command === GEMINI_DUMP_COMMAND_NAME) {
      const action = parseGeminiDumpCommandAction(input2.arguments);
      if (action.type === "enable" || action.type === "disable") {
        setGeminiDumpEnabled(action.type === "enable");
      }
      if (!connectionState.isTuiConnected(input2.sessionID)) {
        await sendIgnoredMessage(
          client,
          input2.sessionID,
          executeGeminiDumpCommand({ argumentsText: input2.arguments })
        );
      }
      throwHandledCommandSentinel();
    }
    if (command !== ANTIGRAVITY_QUOTA_COMMAND_NAME && command !== ANTIGRAVITY_ACCOUNT_COMMAND_NAME && command !== ANTIGRAVITY_ROUTING_COMMAND_NAME && command !== ANTIGRAVITY_KILLSWITCH_COMMAND_NAME && command !== ANTIGRAVITY_DUMP_COMMAND_NAME && command !== ANTIGRAVITY_LOGGING_COMMAND_NAME) {
      return;
    }
    if (command === "antigravity-routing" || command === "google-routing") {
      if (input2.arguments && input2.arguments.trim()) {
        try {
          const result = await applyCommand({
            command: "antigravity-routing",
            arguments: input2.arguments.trim(),
            sessionId: input2.sessionID
          }, context);
          if (output && output.parts) {
            output.parts.push({ type: "text", text: result.text });
          } else if (!connectionState.isTuiConnected(input2.sessionID)) {
            await sendIgnoredMessage(client, input2.sessionID, result.text);
          }
        } catch (err) {
          log12.warn("Error applying command", { error: String(err) });
        }
        return;
      }
      const payload = await buildDialogPayload(command, input2.arguments, {
        ...context,
        sessionID: input2.sessionID
      });
      pushNotification2(payload, input2.sessionID);
      if (output && output.parts) {
        output.parts.push({ type: "text", text: payload.text });
      } else if (!connectionState.isTuiConnected(input2.sessionID)) {
        await sendIgnoredMessage(client, input2.sessionID, payload.text);
      }
      return;
    }
    const payload = await buildDialogPayload(command, input2.arguments, {
      ...context,
      sessionID: input2.sessionID
    });
    pushNotification2(payload, input2.sessionID);
    if (!connectionState.isTuiConnected(input2.sessionID)) {
      await sendIgnoredMessage(client, input2.sessionID, payload.text);
    }
    throwHandledCommandSentinel();
  };
}

// src/plugin/catalog.ts
function applyAntigravityProviderCatalog(config, providerId) {
  const mutableConfig = config;
  mutableConfig.provider ??= {};
  const providerConfig = mutableConfig.provider[providerId] ?? {};
  providerConfig.models = {
    ...providerConfig.models ?? {},
    ...OPENCODE_MODEL_DEFINITIONS
  };
  providerConfig.whitelist = getAntigravityOpencodeModelIds();
  mutableConfig.provider[providerId] = providerConfig;
}
var COMMAND_DESCRIPTIONS = {
  "antigravity-quota": "Refresh Antigravity quota for the active account pool.",
  "antigravity-account": "Add, refresh, or remove Antigravity accounts.",
  "antigravity-routing": "Toggle routing overrides for Gemini / Antigravity fallback.",
  "antigravity-killswitch": "Configure the quota killswitch threshold and per-account overrides.",
  "antigravity-dump": "Show or toggle Gemini/Antigravity wire dump capture for debugging.",
  "antigravity-logging": "Adjust the runtime logging level."
};
function registerAntigravityCommands(config) {
  if (!config) return;
  config.command = config.command || {};
  const commands = [
    { name: "antigravity-routing", desc: "Configure Google Antigravity account routing strategy" },
    { name: "antigravity-quota", desc: "Refresh Google Antigravity quota" },
    { name: "antigravity-account", desc: "Manage Google Antigravity accounts" },
    { name: "antigravity-killswitch", desc: "Manage Google Antigravity killswitch" },
    { name: "antigravity-dump", desc: "Manage Google Antigravity diagnostic dumps" },
    { name: "antigravity-logging", desc: "Configure Google Antigravity logging level" },
    { name: "google-routing", desc: "Configure Google account routing strategy (alias)" },
    { name: "google-quota", desc: "Refresh Google quota (alias)" },
  ];
  for (const cmd of commands) {
    config.command[cmd.name] = {
      description: cmd.desc,
      template: cmd.name,
    };
  }
}

// src/plugin/command-data.ts
import { createHash as createHash9 } from "node:crypto";
var QUOTA_GROUP_LABELS = {
  gemini: "Gemini",
  "non-gemini": "Non-Gemini"
};
var SUPPORTED_QUOTA_KEYS = [
  "gemini",
  "non-gemini"
];
function toCommandAccountRow(entry) {
  const rawCached = entry.cachedQuotaAccountId && entry.cachedQuotaAccountId !== quotaAccountIdentity3(entry.refreshToken) ? void 0 : entry.cachedQuota;
  const cached = normalizeLegacyCachedQuota2(
    rawCached
  );
  const quota = [];
  for (const key of SUPPORTED_QUOTA_KEYS) {
    const cachedEntry = cached?.[key];
    if (!cachedEntry) continue;
    const fraction = cachedEntry.remainingFraction;
    const remainingPercent = typeof fraction === "number" && Number.isFinite(fraction) ? Math.round(fraction * 100) : null;
    let resetAt;
    if (typeof cachedEntry.resetTime === "string" && cachedEntry.resetTime.length > 0) {
      const parsed = Date.parse(cachedEntry.resetTime);
      if (Number.isFinite(parsed)) resetAt = parsed;
    }
    const windows = cachedEntry.windows?.length ? cachedEntry.windows.map((w) => ({
      window: w.window,
      remainingPercent: Math.round(w.remainingFraction * 100),
      resetAt: typeof w.resetTime === "string" && w.resetTime.length > 0 ? (() => {
        const parsed = Date.parse(w.resetTime);
        return Number.isFinite(parsed) ? parsed : void 0;
      })() : void 0
    })) : void 0;
    quota.push({
      key,
      label: QUOTA_GROUP_LABELS[key],
      remainingPercent,
      resetAt,
      windows
    });
  }
  const label = `Account ${entry.index + 1}`;
  return {
    id: `acct-${entry.index}`,
    index: entry.index,
    label,
    enabled: entry.enabled,
    current: entry.active,
    coolingDownUntil: entry.coolingDownUntil,
    healthScore: entry.healthScore,
    quota,
    tier: toCapturedTier(entry)
  };
}
function quotaAccountIdentity3(refreshToken) {
  return createHash9("sha256").update(refreshToken).digest("hex").slice(0, 16);
}
function projectCommandAccountRows(storage) {
  if (!storage) return [];
  const activeIndex = storage.activeIndexByFamily?.claude ?? storage.activeIndex;
  return storage.accounts.map(
    (entry, index) => toCommandAccountRow({
      index,
      refreshToken: entry.refreshToken,
      label: entry.label,
      enabled: entry.enabled !== false,
      active: index === activeIndex,
      cachedQuota: entry.cachedQuota,
      cachedQuotaUpdatedAt: entry.cachedQuotaUpdatedAt,
      cachedQuotaAccountId: entry.cachedQuotaAccountId
    })
  );
}
function createCommandDataService(options) {
  const {
    accountManagerView,
    quotaManager,
    sidebarStateFile,
    storage,
    now = () => Date.now()
  } = options;
  const projectRows = () => accountManagerView.getAccounts().map(toCommandAccountRow);
  const toRedactionInput = (row) => {
    const gemini = row.quota.find((q) => q.key === "gemini");
    const nonGemini = row.quota.find((q) => q.key === "non-gemini");
    const toPool = (q) => {
      if (!q || q.remainingPercent == null) return void 0;
      return {
        remainingFraction: q.remainingPercent / 100,
        resetTime: typeof q.resetAt === "number" && Number.isFinite(q.resetAt) ? new Date(q.resetAt).toISOString() : void 0,
        windows: q.windows?.map((w) => ({
          window: w.window,
          remainingFraction: w.remainingPercent / 100,
          resetTime: typeof w.resetAt === "number" && Number.isFinite(w.resetAt) ? new Date(w.resetAt).toISOString() : ""
        }))
      };
    };
    return {
      index: row.index,
      label: row.label,
      enabled: row.enabled,
      current: row.current,
      healthScore: row.healthScore,
      // Tier passes the redaction boundary unchanged (plan metadata, not PII).
      // The stamp check was already done by toCommandAccountRow.
      tier: row.tier,
      cachedQuota: {
        gemini: toPool(gemini),
        "non-gemini": toPool(nonGemini)
      }
    };
  };
  const writeSidebar = (rows) => {
    const accounts = rows.map(toRedactionInput);
    void setSidebarMachineState(
      buildSidebarMachineStateFromAccounts(accounts, { checkedAt: now() }),
      { stateFile: sidebarStateFile }
    ).catch(() => {
    });
  };
  return {
    async listAccounts() {
      return projectRows();
    },
    async refreshQuota() {
      const accountsForQuota = accountManagerView.getAccountsForQuotaCheck();
      if (accountsForQuota.length === 0) {
        writeSidebar([]);
        return [];
      }
      const results = await quotaManager.refreshAccounts(accountsForQuota, {
        indexFor: (account) => accountsForQuota.indexOf(account),
        force: true
      });
      const refreshedAt = now();
      const updates = [];
      for (const result of results) {
        const refreshToken = result.updatedAccount?.refreshToken ?? accountsForQuota[result.index]?.refreshToken;
        if (!refreshToken) continue;
        const groups = result.status === "ok" && result.quota?.groups ? result.quota.groups : void 0;
        updates.push({ refreshToken, groups });
      }
      const liveIndexByRefreshToken = /* @__PURE__ */ new Map();
      for (const entry of accountManagerView.getAccounts()) {
        liveIndexByRefreshToken.set(entry.refreshToken, entry.index);
      }
      let liveQuotaChanged = false;
      for (const update of updates) {
        const liveIndex = liveIndexByRefreshToken.get(update.refreshToken);
        if (liveIndex === void 0 || !update.groups) continue;
        accountManagerView.updateQuotaCache(
          liveIndex,
          update.groups,
          update.refreshToken
        );
        liveQuotaChanged = true;
      }
      if (liveQuotaChanged) accountManagerView.requestSaveToDisk();
      if (storage) {
        const updateByRefreshToken = new Map(
          updates.map((update) => [update.refreshToken, update])
        );
        const writeResult = storage.mutate((current) => ({
          ...current,
          accounts: current.accounts.map((entry) => {
            const update = updateByRefreshToken.get(entry.refreshToken);
            if (!update) return entry;
            if (update.groups) {
              return {
                ...entry,
                cachedQuota: update.groups,
                // Stamp the persisted quota with an opaque identity derived
                // from the refresh token so a later projection can detect
                // a stale snapshot after an account-index shift.
                cachedQuotaAccountId: quotaAccountIdentity3(entry.refreshToken),
                cachedQuotaUpdatedAt: refreshedAt
              };
            }
            return {
              ...entry,
              cachedQuotaUpdatedAt: refreshedAt
            };
          })
        }));
        await Promise.resolve(writeResult).catch(() => {
        });
      }
      const rows = projectRows();
      writeSidebar(rows);
      return rows;
    },
    async refreshQuotaRespectingBackoff() {
      const accountsForQuota = accountManagerView.getAccountsForQuotaCheck();
      if (accountsForQuota.length === 0) return;
      let results;
      try {
        results = await quotaManager.refreshAccounts(accountsForQuota, {
          indexFor: (account) => accountsForQuota.indexOf(account),
          force: false
        });
      } catch {
        return;
      }
      const updates = [];
      for (const result of results) {
        const refreshToken = result.updatedAccount?.refreshToken ?? accountsForQuota[result.index]?.refreshToken;
        if (!refreshToken) continue;
        const groups = result.status === "ok" && result.quota?.groups ? result.quota.groups : void 0;
        updates.push({ refreshToken, groups });
      }
      if (updates.length === 0) return;
      const liveIndexByRefreshToken = /* @__PURE__ */ new Map();
      for (const entry of accountManagerView.getAccounts()) {
        liveIndexByRefreshToken.set(entry.refreshToken, entry.index);
      }
      let liveQuotaChanged = false;
      for (const update of updates) {
        const liveIndex = liveIndexByRefreshToken.get(update.refreshToken);
        if (liveIndex === void 0 || !update.groups) continue;
        accountManagerView.updateQuotaCache(
          liveIndex,
          update.groups,
          update.refreshToken
        );
        liveQuotaChanged = true;
      }
      if (liveQuotaChanged) accountManagerView.requestSaveToDisk();
      const rows = projectRows();
      writeSidebar(rows);
    },
    async setCurrentAccount(index) {
      return mutateLiveAndStorage({ action: "setCurrent", index });
    },
    async toggleAccountEnabled(index) {
      return mutateLiveAndStorage({ action: "toggleEnabled", index });
    },
    async removeAccount(index) {
      return mutateLiveAndStorage({ action: "remove", index });
    }
  };
  async function mutateLiveAndStorage(args) {
    const { index, action } = args;
    const target = accountManagerView.getAccounts()[index];
    if (!target) return null;
    const refreshToken = accountManagerView.getRefreshTokenAt(index) ?? target.refreshToken;
    if (!refreshToken) return null;
    if (action === "toggleEnabled" && target.enabled === false && target.accountIneligible === true) {
      throw new Error(
        "This account is ineligible and cannot be enabled until eligibility is rechecked."
      );
    }
    if (!storage) {
      throw new Error(
        "CommandDataService is missing a locked-storage adapter; account mutations are disabled."
      );
    }
    const liveCurrentTokens = {};
    if (action === "remove") {
      const liveAccounts = accountManagerView.getAccounts();
      const liveIndexes = accountManagerView.getActiveIndexByFamily();
      liveCurrentTokens.claude = liveAccounts[liveIndexes.claude]?.refreshToken ?? void 0;
      liveCurrentTokens.gemini = liveAccounts[liveIndexes.gemini]?.refreshToken ?? void 0;
    }
    let foundInStorage = false;
    let desiredEnabled;
    let previousEnabled;
    let nextActiveIndex = 0;
    let nextActiveIndexByFamily = {
      claude: 0,
      gemini: 0
    };
    await storage.mutate((current) => {
      const tokenIdx = current.accounts.findIndex(
        (entry) => entry.refreshToken === refreshToken
      );
      if (tokenIdx === -1) return current;
      foundInStorage = true;
      if (action === "setCurrent") {
        return {
          ...current,
          activeIndex: tokenIdx,
          activeIndexByFamily: { claude: tokenIdx, gemini: tokenIdx }
        };
      }
      if (action === "toggleEnabled") {
        const entry = current.accounts[tokenIdx];
        if (!entry) return current;
        previousEnabled = entry.enabled !== false;
        desiredEnabled = entry.enabled === false;
        if (desiredEnabled && entry.accountIneligible === true) {
          throw new Error(
            "This account is ineligible and cannot be enabled until eligibility is rechecked."
          );
        }
        return {
          ...current,
          accounts: current.accounts.map(
            (account) => account.refreshToken === refreshToken ? { ...account, enabled: desiredEnabled } : account
          )
        };
      }
      const nextAccounts = current.accounts.filter(
        (account) => account.refreshToken !== refreshToken
      );
      const resolveNextIndex = (liveToken, legacyIndex) => {
        if (!liveToken)
          return Math.max(0, Math.min(legacyIndex, nextAccounts.length - 1));
        const found = nextAccounts.findIndex(
          (account) => account.refreshToken === liveToken
        );
        if (found !== -1) return found;
        return tokenIdx < nextAccounts.length ? tokenIdx : 0;
      };
      const legacyClaude = current.activeIndexByFamily?.claude ?? current.activeIndex;
      const legacyGemini = current.activeIndexByFamily?.gemini ?? current.activeIndex;
      nextActiveIndex = resolveNextIndex(liveCurrentTokens.claude, legacyClaude);
      nextActiveIndexByFamily = {
        claude: resolveNextIndex(liveCurrentTokens.claude, legacyClaude),
        gemini: resolveNextIndex(liveCurrentTokens.gemini, legacyGemini)
      };
      return {
        ...current,
        accounts: nextAccounts,
        activeIndex: nextActiveIndex,
        activeIndexByFamily: nextActiveIndexByFamily
      };
    });
    if (!foundInStorage) return null;
    const liveIndex = accountManagerView.getAccounts().findIndex((account) => account.refreshToken === refreshToken);
    let applied = action === "remove" && liveIndex === -1;
    if (liveIndex !== -1) {
      if (action === "setCurrent") {
        applied = accountManagerView.setAccountCurrent(liveIndex);
      } else if (action === "toggleEnabled") {
        applied = accountManagerView.setAccountEnabled(
          liveIndex,
          desiredEnabled === true
        );
        if (!applied) {
          applied = accountManagerView.getAccounts()[liveIndex]?.enabled === desiredEnabled;
        }
      } else {
        applied = accountManagerView.removeAccountByIndex(liveIndex);
      }
    }
    if (!applied && action !== "remove") {
      if (action === "toggleEnabled" && previousEnabled !== void 0) {
        await storage.mutate((current) => ({
          ...current,
          accounts: current.accounts.map(
            (account) => account.refreshToken === refreshToken ? { ...account, enabled: previousEnabled } : account
          )
        }));
      }
      throw new Error(
        "The account changed while the operation was being applied; reopen the dialog and try again."
      );
    }
    await accountManagerView.flushSaveToDisk().catch(() => {
    });
    const rows = projectRows();
    writeSidebar(rows);
    return rows;
  }
}

// src/plugin/config/loader.ts
import { existsSync as existsSync8, readFileSync as readFileSync11 } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { join as join14 } from "node:path";

// src/plugin/config/schema.ts
import { z as z4 } from "zod";
var AccountSelectionStrategySchema = z4.enum([
  "sticky",
  "round-robin",
  "hybrid",
  "main-first",
  "fallback-first"
]);
var ToastScopeSchema = z4.enum(["root_only", "all"]);
var SchedulingModeSchema = z4.enum([
  "cache_first",
  "balance",
  "performance_first"
]);
var SignatureCacheConfigSchema = z4.object({
  /** Enable disk caching of signatures (default: true) */
  enabled: z4.boolean().default(true),
  /** In-memory TTL in seconds (default: 3600 = 1 hour) */
  memory_ttl_seconds: z4.number().min(60).max(86400).default(3600),
  /** Disk TTL in seconds (default: 172800 = 48 hours) */
  disk_ttl_seconds: z4.number().min(3600).max(604800).default(172800),
  /** Background write interval in seconds (default: 60) */
  write_interval_seconds: z4.number().min(10).max(600).default(60)
});
var AntigravityConfigSchema = z4.object({
  /** JSON Schema reference for IDE support */
  $schema: z4.string().optional(),
  // =========================================================================
  // General Settings
  // =========================================================================
  /**
   * Suppress most toast notifications (rate limit, account switching, etc.)
   * Recovery toasts are always shown regardless of this setting.
   * Env override: OPENCODE_ANTIGRAVITY_QUIET=1
   * @default false
   */
  quiet_mode: z4.boolean().default(false),
  /**
   * Control which sessions show toast notifications.
   *
   * - `root_only` (default): Only root sessions show toasts.
   *   Subagents and background tasks will be silent (less spam).
   * - `all`: All sessions show toasts including subagents and background tasks.
   *
   * Debug logging captures all toasts regardless of this setting.
   * Env override: OPENCODE_ANTIGRAVITY_TOAST_SCOPE=all
   * @default "root_only"
   */
  toast_scope: ToastScopeSchema.default("root_only"),
  /**
   * Enable debug logging to file.
   * Env override: OPENCODE_ANTIGRAVITY_DEBUG=1
   * @default false
   */
  debug: z4.boolean().default(false),
  /**
   * Show debug logs in the TUI log panel.
   * Works independently from `debug` file logging.
   * Env override: OPENCODE_ANTIGRAVITY_DEBUG_TUI=1
   * @default false
   */
  debug_tui: z4.boolean().default(false),
  /**
   * Custom directory for debug logs.
   * Env override: OPENCODE_ANTIGRAVITY_LOG_DIR=/path/to/logs
   * @default OS-specific config dir + "/antigravity-logs"
   */
  log_dir: z4.string().optional(),
  // =========================================================================
  // Thinking Blocks
  // =========================================================================
  /**
   * Preserve thinking blocks for Claude models using signature caching.
   *
   * When false (default): Thinking blocks are stripped for reliability.
   * When true: Full context preserved, but may encounter signature errors.
   *
   * Env override: OPENCODE_ANTIGRAVITY_KEEP_THINKING=1
   * @default false
   */
  keep_thinking: z4.boolean().default(false),
  /**
   * Enable thinking warmup requests for Claude thinking models.
   * When enabled, sends a separate API call at session start to warm up
   * thinking signature validation. Costs 1 full API call per session.
   *
   * Disable to save quota — most users don't need this unless using
   * keep_thinking with signature caching.
   *
   * Env override: OPENCODE_ANTIGRAVITY_THINKING_WARMUP=1
   * @default false
   */
  thinking_warmup: z4.boolean().default(false),
  /**
   * Send a lightweight cache-seeding probe when switching to a different account.
   * The probe reuses the same request prefix with maxOutputTokens=1 so the
   * server-side implicit cache warms up before the real request fires.
   * Costs ~1 quota unit per account switch but eliminates the 0% cold-cache
   * MISS that otherwise occurs on every rotation.
   *
   * Env override: OPENCODE_ANTIGRAVITY_CACHE_WARMUP_ON_SWITCH=1
   * @default true
   */
  cache_warmup_on_switch: z4.boolean().default(true),
  // =========================================================================
  // Session Recovery
  // =========================================================================
  /**
   * Enable automatic session recovery from tool_result_missing errors.
   * When enabled, shows a toast notification when recoverable errors occur.
   *
   * @default true
   */
  session_recovery: z4.boolean().default(true),
  /**
   * Automatically send a "continue" prompt after successful recovery.
   * Only applies when session_recovery is enabled.
   *
   * When false: Only shows toast notification, user must manually continue.
   * When true: Automatically sends "continue" to resume the session.
   *
   * @default true
   */
  auto_resume: z4.boolean().default(true),
  /**
   * Custom text to send when auto-resuming after recovery.
   * Only used when auto_resume is enabled.
   *
   * @default "continue"
   */
  resume_text: z4.string().default("continue"),
  // =========================================================================
  // Signature Caching
  // =========================================================================
  /**
   * Signature cache configuration for persisting thinking block signatures.
   * Only used when keep_thinking is enabled.
   */
  signature_cache: SignatureCacheConfigSchema.optional(),
  // =========================================================================
  // Empty Response Retry (ported from LLM-API-Key-Proxy)
  // =========================================================================
  /**
   * Maximum retry attempts when Antigravity returns an empty response.
   * Empty responses occur when no candidates/choices are returned.
   *
   * @default 2
   */
  empty_response_max_attempts: z4.number().min(1).max(10).default(2),
  /**
   * Delay in milliseconds between empty response retries.
   *
   * @default 2000
   */
  empty_response_retry_delay_ms: z4.number().min(500).max(1e4).default(2e3),
  // =========================================================================
  // Tool ID Recovery (ported from LLM-API-Key-Proxy)
  // =========================================================================
  /**
   * Enable tool ID orphan recovery.
   * When tool responses have mismatched IDs (due to context compaction),
   * attempt to match them by function name or create placeholders.
   *
   * @default true
   */
  tool_id_recovery: z4.boolean().default(true),
  // =========================================================================
  // Tool Hallucination Prevention (ported from LLM-API-Key-Proxy)
  // =========================================================================
  /**
   * Enable tool hallucination prevention for Claude models.
   * When enabled, injects:
   * - Parameter signatures into tool descriptions
   * - System instruction with strict tool usage rules
   *
   * This helps prevent Claude from using parameter names from its training
   * data instead of the actual schema.
   *
   * @default true
   */
  claude_tool_hardening: z4.boolean().default(true),
  /**
   * Enable Claude prompt auto-caching by adding top-level cache_control when absent.
   *
   * @default false
   */
  claude_prompt_auto_caching: z4.boolean().default(false),
  // =========================================================================
  // Proactive Token Refresh (ported from LLM-API-Key-Proxy)
  // =========================================================================
  /**
   * Enable proactive background token refresh.
   * When enabled, tokens are refreshed in the background before they expire,
   * ensuring requests never block on token refresh.
   *
   * @default true
   */
  proactive_token_refresh: z4.boolean().default(true),
  /**
   * Seconds before token expiry to trigger proactive refresh.
   * Default is 30 minutes (1800 seconds).
   *
   * @default 1800
   */
  proactive_refresh_buffer_seconds: z4.number().min(60).max(7200).default(1800),
  /**
   * Interval between proactive refresh checks in seconds.
   * Default is 5 minutes (300 seconds).
   *
   * @default 300
   */
  proactive_refresh_check_interval_seconds: z4.number().min(30).max(1800).default(300),
  // =========================================================================
  // Rate Limiting
  // =========================================================================
  /**
   * Maximum time in seconds to wait when all accounts are rate-limited.
   * If the minimum wait time across all accounts exceeds this threshold,
   * the plugin fails fast with an error instead of hanging.
   *
   * Set to 0 to disable (wait indefinitely).
   *
   * @default 300 (5 minutes)
   */
  max_rate_limit_wait_seconds: z4.number().min(0).max(3600).default(300),
  /**
   * @deprecated Kept only for backward compatibility.
   * This flag is ignored at runtime.
   * Gemini requests always fall back between Antigravity and Gemini CLI quotas.
   *
   * @default false
   */
  quota_fallback: z4.boolean().default(false),
  /**
   * Prefer gemini-cli routing before Antigravity for Gemini models.
   *
   * When false (default): Antigravity is tried first, then gemini-cli.
   * When true: gemini-cli is tried first, then Antigravity.
   *
   * @default false
   */
  cli_first: z4.boolean().default(false),
  routing_mode: z4.enum(["main-first", "sticky-balanced", "round-robin", "fallback-first"]).default("main-first"),
  /**
   * Strategy for selecting accounts when making requests.
   * Env override: OPENCODE_ANTIGRAVITY_ACCOUNT_SELECTION_STRATEGY
   * @default "hybrid"
   */
  account_selection_strategy: AccountSelectionStrategySchema.default("hybrid"),
  /**
   * Enable PID-based account offset for multi-session distribution.
   *
   * When enabled, different sessions (PIDs) will prefer different starting
   * accounts, which helps distribute load when running multiple parallel agents.
   *
   * When disabled (default), accounts start from the same index, which preserves
   * Anthropic's prompt cache across restarts (recommended for single-session use).
   *
   * Env override: OPENCODE_ANTIGRAVITY_PID_OFFSET_ENABLED=1
   * @default false
   */
  pid_offset_enabled: z4.boolean().default(false),
  /**
   * Switch to another account immediately on first rate limit (after 1s delay).
   * When disabled, retries same account first, then switches on second rate limit.
   *
   * @default true
   */
  switch_on_first_rate_limit: z4.boolean().default(true),
  /**
   * Maximum number of account switches per request before giving up.
   * Each switch re-sends the full request payload, consuming quota on the new account.
   * Lower values reduce quota waste from cascading rate limits across accounts.
   *
   * Env override: OPENCODE_ANTIGRAVITY_MAX_ACCOUNT_SWITCHES
   * @default 10
   */
  max_account_switches: z4.number().min(0).max(500).default(10),
  /**
   * Allow falling back between quota pools (antigravity ↔ gemini-cli) when rate-limited.
   * When enabled, if one quota pool is exhausted the plugin re-sends the SAME request
   * using the alternate header style, consuming tokens from BOTH pools.
   * Disable to prevent double-spending quota across pools — the plugin will only
   * rotate accounts instead.
   * Only applies to Gemini models (Claude always uses antigravity).
   *
   * Env override: OPENCODE_ANTIGRAVITY_QUOTA_STYLE_FALLBACK
   * @default false
   */
  quota_style_fallback: z4.boolean().default(false),
  /**
   * Scheduling mode for rate limit behavior.     *
   * - `cache_first`: Wait for same account to recover (preserves prompt cache). Default.
   * - `balance`: Switch account immediately on rate limit. Maximum availability.
   * - `performance_first`: Round-robin distribution for maximum throughput.
   *
   * Env override: OPENCODE_ANTIGRAVITY_SCHEDULING_MODE
   * @default "cache_first"
   */
  scheduling_mode: SchedulingModeSchema.default("cache_first"),
  /**
   * Maximum seconds to wait for same account in cache_first mode.
   * If the account's rate limit reset time exceeds this, switch accounts.
   *
   * @default 60
   */
  max_cache_first_wait_seconds: z4.number().min(5).max(300).default(60),
  /**
   * TTL in seconds for failure count expiration.
   * After this period of no failures, consecutiveFailures resets to 0.
   * This prevents old failures from permanently penalizing an account.
   *
   * @default 3600 (1 hour)
   */
  failure_ttl_seconds: z4.number().min(60).max(7200).default(3600),
  /**
   * Default retry delay in seconds when API doesn't return a retry-after header.
   * Lower values allow faster retries but may trigger more 429 errors.
   *
   * @default 60
   */
  default_retry_after_seconds: z4.number().min(1).max(300).default(60),
  /**
   * Maximum backoff delay in seconds for exponential retry.
   * This caps how long the exponential backoff can grow.
   *
   * @default 60
   */
  max_backoff_seconds: z4.number().min(5).max(300).default(60),
  /**
   * Maximum random delay in milliseconds before each API request.
   * Adds timing jitter to break predictable request cadence patterns.
   * Set to 0 to disable request jitter.
   *
   * @default 0
   */
  request_jitter_max_ms: z4.number().min(0).max(5e3).default(0),
  /**
   * Delay in milliseconds before switching to the next account after a rate limit.
   * Lower values reduce total wait time when cycling through accounts.
   * Higher values give the rate-limited account more time to recover.
   *
   * @default 500
   */
  switch_account_delay_ms: z4.number().min(0).max(1e4).default(500),
  /**
   * Soft quota threshold percentage (1-100).
   * When an account's quota usage reaches this percentage, skip it during
   * account selection (same as if it were rate-limited).
   *
   * Example: 80 means skip account when 80% of quota is used (20% remaining).
   * Set to 100 to disable soft quota protection.
   *
   * @default 80
   */
  soft_quota_threshold_percent: z4.number().min(1).max(100).default(80),
  /**
   * How often to refresh quota data in the background (in minutes).
   * Quota is refreshed opportunistically after successful API requests.
   * Set to 0 to disable automatic refresh (manual only via Check quotas).
   *
   * @default 15
   */
  quota_refresh_interval_minutes: z4.number().min(0).max(120).default(30),
  /**
   * How long quota cache is considered fresh for threshold checks (in minutes).
   * After this time, cache is stale and account is allowed (fail-open).
   *
   * "auto" = derive from refresh interval: max(2 * refresh_interval, 10)
   *
   * @default "auto"
   */
  soft_quota_cache_ttl_minutes: z4.union([z4.literal("auto"), z4.number().min(1).max(120)]).default("auto"),
  /**
   * Proactive rotation threshold percentage (0-100).
   * After a successful request, if the current account's remaining quota
   * drops below this percentage, proactively switch to a warm-cache account
   * before the next request — avoiding a forced 429 mid-conversation.
   *
   * Set to 0 to disable proactive rotation.
   *
   * @default 20
   * @env OPENCODE_ANTIGRAVITY_PROACTIVE_ROTATION_THRESHOLD
   */
  proactive_rotation_threshold_percent: z4.number().min(0).max(100).default(20),
  // =========================================================================
  // Health Score (used by hybrid strategy)
  // =========================================================================
  health_score: z4.object({
    initial: z4.number().min(0).max(100).default(70),
    success_reward: z4.number().min(0).max(10).default(1),
    rate_limit_penalty: z4.number().min(-50).max(0).default(-10),
    failure_penalty: z4.number().min(-100).max(0).default(-20),
    recovery_rate_per_hour: z4.number().min(0).max(20).default(2),
    min_usable: z4.number().min(0).max(100).default(50),
    max_score: z4.number().min(50).max(100).default(100)
  }).optional(),
  // =========================================================================
  // Token Bucket (for hybrid strategy)
  // =========================================================================
  token_bucket: z4.object({
    max_tokens: z4.number().min(1).max(1e3).default(50),
    regeneration_rate_per_minute: z4.number().min(0.1).max(60).default(6),
    initial_tokens: z4.number().min(1).max(1e3).default(50)
  }).optional(),
  // =========================================================================
  // Auto-Update
  // =========================================================================
  // =========================================================================
  // Background Quota Refresh
  // =========================================================================
  /**
   * Enable a background timer that periodically refreshes quota for all
   * accounts. Without this, idle sessions show stale sidebar bars
   * because Antigravity is a poll-only API (no quota headers in responses).
   *
   * @default true
   */
  background_quota_refresh: z4.boolean().default(true),
  /**
   * How often the background poller refreshes quota (in minutes).
   * Valid range: 1–60.
   *
   * @default 5
   */
  background_quota_refresh_interval_minutes: z4.number().min(1).max(60).default(5),
  /**
   * Enable automatic plugin updates.
   * @default true
   */
  auto_update: z4.boolean().default(true),
  // =========================================================================
  // Operator Settings (Task 18: persistent runtime controls)
  // =========================================================================
  //
  // These fields back the slash-command dialogs. They are mutable from the
  // TUI and MUST persist across restarts. Writes go through
  // `config/writer.ts` so they use the same fenced lock + atomic rename the
  // account pool uses — concurrent writers do not silently corrupt state.
  /**
   * Routing overrides the static `cli_first` / `quota_style_fallback` flags
   * when the operator toggles them through `/antigravity-routing`.
   */
  operator: z4.object({
    routing: z4.object({
      cli_first: z4.boolean().default(false),
      quota_style_fallback: z4.boolean().default(false)
    }).optional(),
    killswitch: z4.object({
      enabled: z4.boolean().default(false),
      minimum_remaining_percent: z4.number().min(0).max(100).default(5),
      /**
       * Per-account override keyed by sha256(refreshToken).slice(0,12).
       * No raw token ever lands in the config file, sidebar, RPC, or
       * apply arguments.
       */
      accounts: z4.record(z4.string(), z4.number().min(0).max(100)).optional()
    }).optional(),
    log_level: z4.enum(["error", "warn", "info", "debug", "trace"]).default("info")
  }).optional()
});
var DEFAULT_CONFIG = {
  quiet_mode: false,
  toast_scope: "root_only",
  debug: false,
  debug_tui: false,
  keep_thinking: false,
  thinking_warmup: false,
  cache_warmup_on_switch: true,
  session_recovery: true,
  auto_resume: true,
  resume_text: "continue",
  empty_response_max_attempts: 2,
  empty_response_retry_delay_ms: 2e3,
  tool_id_recovery: true,
  claude_tool_hardening: true,
  claude_prompt_auto_caching: false,
  proactive_token_refresh: true,
  proactive_refresh_buffer_seconds: 1800,
  proactive_refresh_check_interval_seconds: 300,
  max_rate_limit_wait_seconds: 300,
  quota_fallback: false,
  cli_first: false,
  account_selection_strategy: "hybrid",
  pid_offset_enabled: false,
  switch_on_first_rate_limit: true,
  max_account_switches: 10,
  quota_style_fallback: false,
  scheduling_mode: "cache_first",
  max_cache_first_wait_seconds: 60,
  failure_ttl_seconds: 3600,
  default_retry_after_seconds: 60,
  max_backoff_seconds: 60,
  request_jitter_max_ms: 0,
  switch_account_delay_ms: 500,
  soft_quota_threshold_percent: 80,
  quota_refresh_interval_minutes: 30,
  soft_quota_cache_ttl_minutes: "auto",
  proactive_rotation_threshold_percent: 20,
  background_quota_refresh: true,
  background_quota_refresh_interval_minutes: 5,
  auto_update: true,
  signature_cache: {
    enabled: true,
    memory_ttl_seconds: 3600,
    disk_ttl_seconds: 172800,
    write_interval_seconds: 60
  },
  health_score: {
    initial: 70,
    success_reward: 1,
    rate_limit_penalty: -10,
    failure_penalty: -20,
    recovery_rate_per_hour: 2,
    min_usable: 50,
    max_score: 100
  },
  token_bucket: {
    max_tokens: 50,
    regeneration_rate_per_minute: 6,
    initial_tokens: 50
  },
  operator: {
    routing: { cli_first: false, quota_style_fallback: false },
    killswitch: { enabled: false, minimum_remaining_percent: 5 },
    log_level: "info"
  }
};

// src/plugin/config/loader.ts
var log12 = createLogger2("config");
function getConfigDir4() {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }
  const xdgConfig2 = process.env.XDG_CONFIG_HOME || join14(homedir8(), ".config");
  return join14(xdgConfig2, "opencode");
}
function getUserConfigPath() {
  const dir = getConfigDir4();
  const googlePath = join14(dir, "google.json");
  if (existsSync8(googlePath)) return googlePath;
  return join14(dir, "antigravity.json");
}
function getProjectConfigPath(directory) {
  return join14(directory, ".opencode", "antigravity.json");
}
function deriveRoutingDefaults(cfg) {
  if (!cfg || typeof cfg !== "object") return cfg;
  const rm = cfg.routing_mode || "main-first";
  cfg.routing_mode = rm;
  if (!cfg.account_selection_strategy) {
    if (rm === "main-first") {
      cfg.account_selection_strategy = "main-first";
      cfg.scheduling_mode = cfg.scheduling_mode || "cache_first";
      cfg.switch_on_first_rate_limit = cfg.switch_on_first_rate_limit ?? false;
    } else if (rm === "sticky-balanced") {
      cfg.account_selection_strategy = "hybrid";
      cfg.scheduling_mode = cfg.scheduling_mode || "balance";
      cfg.switch_on_first_rate_limit = cfg.switch_on_first_rate_limit ?? true;
    } else if (rm === "round-robin") {
      cfg.account_selection_strategy = "round-robin";
      cfg.scheduling_mode = cfg.scheduling_mode || "performance_first";
      cfg.switch_on_first_rate_limit = cfg.switch_on_first_rate_limit ?? true;
    } else if (rm === "fallback-first") {
      cfg.account_selection_strategy = "fallback-first";
      cfg.scheduling_mode = cfg.scheduling_mode || "balance";
      cfg.switch_on_first_rate_limit = cfg.switch_on_first_rate_limit ?? true;
    }
  }
  return cfg;
}
function loadConfigFile(path5) {
  try {
    if (!existsSync8(path5)) {
      return null;
    }
    const content = readFileSync11(path5, "utf-8");
    const rawConfig = deriveRoutingDefaults(JSON.parse(content));
    const result = AntigravityConfigSchema.partial().safeParse(rawConfig);
    if (!result.success) {
      log12.warn("Config validation error", {
        path: path5,
        issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")
      });
      return null;
    }
    return result.data;
  } catch (error) {
    if (error instanceof SyntaxError) {
      log12.warn("Invalid JSON in config file", { path: path5, error: error.message });
    } else {
      log12.warn("Failed to load config file", { path: path5, error: String(error) });
    }
    return null;
  }
}
function mergeConfigs(base, override) {
  return {
    ...base,
    ...override,
    // Deep merge signature_cache if both exist
    signature_cache: override.signature_cache ? {
      ...base.signature_cache,
      ...override.signature_cache
    } : base.signature_cache
  };
}
function loadConfig(directory) {
  let config = { ...DEFAULT_CONFIG };
  const userConfigPath = getUserConfigPath();
  const userConfig = loadConfigFile(userConfigPath);
  if (userConfig) {
    config = mergeConfigs(config, userConfig);
  }
  const projectConfigPath = getProjectConfigPath(directory);
  const projectConfig = loadConfigFile(projectConfigPath);
  if (projectConfig) {
    config = mergeConfigs(config, projectConfig);
  }
  return config;
}
var runtimeConfig = null;
function initRuntimeConfig(config) {
  runtimeConfig = config;
}
function getKeepThinking() {
  return runtimeConfig?.keep_thinking ?? false;
}

// src/plugin/dependencies.ts
import { homedir as homedir9 } from "node:os";
import { join as join15 } from "node:path";
function defaultFilesystemRoots() {
  const xdgConfig2 = process.env.XDG_CONFIG_HOME ?? join15(homedir9(), ".config");
  const xdgState2 = process.env.XDG_STATE_HOME ?? join15(homedir9(), ".local", "state");
  return {
    projectRoot: process.cwd(),
    userConfigRoot: join15(xdgConfig2, "opencode"),
    sidebarStateRoot: join15(xdgState2, "cortexkit", "antigravity-auth"),
    rpcRoot: join15(xdgState2, "cortexkit", "antigravity-auth", "rpc")
  };
}
function resolvePluginDependencies(overrides = {}) {
  const fetchImpl = overrides.fetchImpl ?? ((input2, init) => globalThis.fetch(input2, init));
  const agyTransport = overrides.agyTransport ?? fetchWithAgyCliTransport;
  const roots = {
    ...defaultFilesystemRoots(),
    ...overrides.filesystemRoots
  };
  const oauth = {
    authorize: overrides.oauth?.authorize ?? authorizeAntigravity,
    exchange: overrides.oauth?.exchange ?? exchangeAntigravity
  };
  const clock = {
    now: overrides.clock?.now ?? (() => Date.now()),
    random: overrides.clock?.random ?? Math.random,
    sleep: overrides.clock?.sleep ?? defaultSleep
  };
  return {
    fetchImpl,
    agyTransport,
    filesystemRoots: roots,
    oauth,
    clock
  };
}
async function defaultSleep(ms, signal) {
  if (ms <= 0) return;
  await new Promise((resolve3, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve3();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal?.reason instanceof Error ? signal.reason : new Error("Aborted")
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// src/plugin/recovery/storage.ts
import {
  existsSync as existsSync9,
  mkdirSync as mkdirSync7,
  readdirSync as readdirSync2,
  readFileSync as readFileSync12,
  unlinkSync as unlinkSync4,
  writeFileSync as writeFileSync7
} from "node:fs";
import { join as join17 } from "node:path";

// src/plugin/recovery/constants.ts
import { homedir as homedir10 } from "node:os";
import { join as join16 } from "node:path";
function getXdgData() {
  const platform = process.platform;
  if (platform === "win32") {
    return process.env.APPDATA || join16(homedir10(), "AppData", "Roaming");
  }
  return process.env.XDG_DATA_HOME || join16(homedir10(), ".local", "share");
}
var OPENCODE_STORAGE = join16(getXdgData(), "opencode", "storage");
var MESSAGE_STORAGE = join16(OPENCODE_STORAGE, "message");
var PART_STORAGE = join16(OPENCODE_STORAGE, "part");
var THINKING_TYPES = /* @__PURE__ */ new Set([
  "thinking",
  "redacted_thinking",
  "reasoning"
]);

// src/plugin/recovery/storage.ts
function getMessageDir(sessionID) {
  if (!existsSync9(MESSAGE_STORAGE)) return "";
  const directPath = join17(MESSAGE_STORAGE, sessionID);
  if (existsSync9(directPath)) {
    return directPath;
  }
  try {
    for (const dir of readdirSync2(MESSAGE_STORAGE)) {
      const sessionPath = join17(MESSAGE_STORAGE, dir, sessionID);
      if (existsSync9(sessionPath)) {
        return sessionPath;
      }
    }
  } catch {
  }
  return "";
}
function readMessages(sessionID) {
  const messageDir = getMessageDir(sessionID);
  if (!messageDir || !existsSync9(messageDir)) return [];
  const messages = [];
  try {
    for (const file of readdirSync2(messageDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = readFileSync12(join17(messageDir, file), "utf-8");
        messages.push(JSON.parse(content));
      } catch {
      }
    }
  } catch {
    return [];
  }
  return messages.sort((a, b) => {
    const aTime = a.time?.created ?? 0;
    const bTime = b.time?.created ?? 0;
    if (aTime !== bTime) return aTime - bTime;
    return a.id.localeCompare(b.id);
  });
}
function readParts(messageID) {
  const partDir = join17(PART_STORAGE, messageID);
  if (!existsSync9(partDir)) return [];
  const parts = [];
  try {
    for (const file of readdirSync2(partDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = readFileSync12(join17(partDir, file), "utf-8");
        parts.push(JSON.parse(content));
      } catch {
      }
    }
  } catch {
    return [];
  }
  return parts;
}
function findMessagesWithThinkingBlocks(sessionID) {
  const messages = readMessages(sessionID);
  const result = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const parts = readParts(msg.id);
    const hasThinking = parts.some((p) => THINKING_TYPES.has(p.type));
    if (hasThinking) {
      result.push(msg.id);
    }
  }
  return result;
}
function findMessagesWithOrphanThinking(sessionID) {
  const messages = readMessages(sessionID);
  const result = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const parts = readParts(msg.id);
    if (parts.length === 0) continue;
    const sortedParts = [...parts].sort((a, b) => a.id.localeCompare(b.id));
    const firstPart = sortedParts[0];
    if (!firstPart) continue;
    const firstIsThinking = THINKING_TYPES.has(firstPart.type);
    if (!firstIsThinking) {
      result.push(msg.id);
    }
  }
  return result;
}
function prependThinkingPart(sessionID, messageID) {
  const partDir = join17(PART_STORAGE, messageID);
  try {
    if (!existsSync9(partDir)) {
      mkdirSync7(partDir, { recursive: true });
    }
    const partId = "prt_0000000000_thinking";
    const part = {
      id: partId,
      sessionID,
      messageID,
      type: "thinking",
      thinking: "",
      synthetic: true
    };
    writeFileSync7(
      join17(partDir, `${partId}.json`),
      JSON.stringify(part, null, 2)
    );
    return true;
  } catch {
    return false;
  }
}
function stripThinkingParts(messageID) {
  const partDir = join17(PART_STORAGE, messageID);
  if (!existsSync9(partDir)) return false;
  let anyRemoved = false;
  try {
    for (const file of readdirSync2(partDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const filePath = join17(partDir, file);
        const content = readFileSync12(filePath, "utf-8");
        const part = JSON.parse(content);
        if (THINKING_TYPES.has(part.type)) {
          unlinkSync4(filePath);
          anyRemoved = true;
        }
      } catch {
      }
    }
  } catch {
    return false;
  }
  return anyRemoved;
}
function findMessageByIndexNeedingThinking(sessionID, targetIndex) {
  const messages = readMessages(sessionID);
  if (targetIndex < 0 || targetIndex >= messages.length) return null;
  const targetMsg = messages[targetIndex];
  if (targetMsg?.role !== "assistant") return null;
  const parts = readParts(targetMsg.id);
  if (parts.length === 0) return null;
  const sortedParts = [...parts].sort((a, b) => a.id.localeCompare(b.id));
  const firstPart = sortedParts[0];
  if (!firstPart) return null;
  const firstIsThinking = THINKING_TYPES.has(firstPart.type);
  if (!firstIsThinking) {
    return targetMsg.id;
  }
  return null;
}

// src/plugin/recovery.ts
var RECOVERY_RESUME_TEXT = "[session recovered - continuing previous task]";
function getErrorMessage(error) {
  if (!error) return "";
  if (typeof error === "string") return error.toLowerCase();
  const errorObj = error;
  const paths = [
    errorObj.data,
    errorObj.error,
    errorObj,
    errorObj.data?.error
  ];
  for (const obj of paths) {
    if (obj && typeof obj === "object") {
      const msg = obj.message;
      if (typeof msg === "string" && msg.length > 0) {
        return msg.toLowerCase();
      }
    }
  }
  try {
    return JSON.stringify(error).toLowerCase();
  } catch {
    return "";
  }
}
function extractMessageIndex(error) {
  const message = getErrorMessage(error);
  const match = message.match(/messages\.(\d+)/);
  if (!match?.[1]) return null;
  return parseInt(match[1], 10);
}
function detectErrorType(error) {
  const message = getErrorMessage(error);
  const hasExpectedFoundThinkingOrder = (message.includes("expected thinking") || message.includes("expected a thinking")) && message.includes("found");
  if (message.includes("tool_use") && message.includes("tool_result")) {
    return "tool_result_missing";
  }
  if (message.includes("thinking") && (message.includes("first block") || message.includes("must start with") || message.includes("preceeding") || message.includes("preceding") || hasExpectedFoundThinkingOrder)) {
    return "thinking_block_order";
  }
  if (message.includes("thinking is disabled") && message.includes("cannot contain")) {
    return "thinking_disabled_violation";
  }
  return null;
}
function isRecoverableError(error) {
  return detectErrorType(error) !== null;
}
function extractToolUseIds(parts) {
  return parts.filter(
    (p) => p.type === "tool_use" && !!p.id
  ).map((p) => p.id);
}
async function recoverToolResultMissing(client, sessionID, failedMsg) {
  let parts = failedMsg.parts || [];
  if (parts.length === 0 && failedMsg.info?.id) {
    const storedParts = readParts(failedMsg.info.id);
    parts = storedParts.map((p) => ({
      type: p.type === "tool" ? "tool_use" : p.type,
      id: "callID" in p ? p.callID : p.id,
      name: "tool" in p ? p.tool : void 0,
      input: "state" in p ? p.state?.input : void 0
    }));
  }
  const toolUseIds = extractToolUseIds(parts);
  if (toolUseIds.length === 0) {
    return false;
  }
  const toolResultParts = toolUseIds.map((id) => ({
    type: "tool_result",
    tool_use_id: id,
    content: "Operation cancelled by user (ESC pressed)"
  }));
  try {
    await client.session.prompt({
      path: { id: sessionID },
      // @ts-expect-error - SDK types may not include tool_result parts
      body: { parts: toolResultParts }
    });
    return true;
  } catch {
    return false;
  }
}
async function recoverThinkingBlockOrder(sessionID, _failedMsg, error) {
  const targetIndex = extractMessageIndex(error);
  if (targetIndex !== null) {
    const targetMessageID = findMessageByIndexNeedingThinking(
      sessionID,
      targetIndex
    );
    if (targetMessageID) {
      return prependThinkingPart(sessionID, targetMessageID);
    }
  }
  const orphanMessages = findMessagesWithOrphanThinking(sessionID);
  if (orphanMessages.length === 0) {
    return false;
  }
  let anySuccess = false;
  for (const messageID of orphanMessages) {
    if (prependThinkingPart(sessionID, messageID)) {
      anySuccess = true;
    }
  }
  return anySuccess;
}
async function recoverThinkingDisabledViolation(sessionID, _failedMsg) {
  const messagesWithThinking = findMessagesWithThinkingBlocks(sessionID);
  if (messagesWithThinking.length === 0) {
    return false;
  }
  let anySuccess = false;
  for (const messageID of messagesWithThinking) {
    if (stripThinkingParts(messageID)) {
      anySuccess = true;
    }
  }
  return anySuccess;
}
function findLastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.info?.role === "user") {
      return messages[i];
    }
  }
  return void 0;
}
function extractResumeConfig(userMessage, sessionID) {
  return {
    sessionID,
    agent: userMessage?.info?.agent,
    model: userMessage?.info?.model
  };
}
async function resumeSession(client, config, directory) {
  try {
    await client.session.prompt({
      path: { id: config.sessionID },
      body: {
        parts: [{ type: "text", text: RECOVERY_RESUME_TEXT }],
        agent: config.agent,
        model: config.model
      },
      query: { directory }
    });
    return true;
  } catch {
    return false;
  }
}
var TOAST_TITLES = {
  tool_result_missing: "Tool Crash Recovery",
  thinking_block_order: "Thinking Block Recovery",
  thinking_disabled_violation: "Thinking Strip Recovery"
};
var TOAST_MESSAGES = {
  tool_result_missing: "Injecting cancelled tool results...",
  thinking_block_order: "Fixing message structure...",
  thinking_disabled_violation: "Stripping thinking blocks..."
};
function getRecoveryToastContent(errorType) {
  if (!errorType) {
    return {
      title: "Session Recovery",
      message: "Attempting to recover session..."
    };
  }
  return {
    title: TOAST_TITLES[errorType] || "Session Recovery",
    message: TOAST_MESSAGES[errorType] || "Attempting to recover session..."
  };
}
function getRecoverySuccessToast() {
  return {
    title: "Session Recovered",
    message: "Continuing where you left off..."
  };
}
function createSessionRecoveryHook(ctx, config) {
  if (!config.session_recovery) {
    return null;
  }
  const { client, directory } = ctx;
  const processingErrors = /* @__PURE__ */ new Set();
  let onAbortCallback = null;
  let onRecoveryCompleteCallback = null;
  const setOnAbortCallback = (callback) => {
    onAbortCallback = callback;
  };
  const setOnRecoveryCompleteCallback = (callback) => {
    onRecoveryCompleteCallback = callback;
  };
  const handleSessionRecovery = async (info) => {
    if (info?.role !== "assistant" || !info.error) return false;
    const errorType = detectErrorType(info.error);
    if (!errorType) return false;
    const sessionID = info.sessionID;
    if (!sessionID) return false;
    let assistantMsgID = info.id;
    let msgs;
    const log18 = createLogger2("session-recovery");
    log18.debug("Recovery attempt started", {
      errorType,
      sessionID,
      providedMsgID: assistantMsgID ?? "none"
    });
    if (onAbortCallback) {
      onAbortCallback(sessionID);
    }
    await client.session.abort({ path: { id: sessionID } }).catch(() => {
    });
    const messagesResp = await client.session.messages({
      path: { id: sessionID },
      query: { directory }
    });
    msgs = messagesResp.data;
    if (!assistantMsgID && msgs && msgs.length > 0) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.info?.role === "assistant" && m.info?.id) {
          assistantMsgID = m.info.id;
          log18.debug("Found assistant message ID from session messages", {
            msgID: assistantMsgID,
            msgIndex: i
          });
          break;
        }
      }
    }
    if (!assistantMsgID) {
      log18.debug("No assistant message ID found, cannot recover");
      return false;
    }
    if (processingErrors.has(assistantMsgID)) return false;
    processingErrors.add(assistantMsgID);
    try {
      const failedMsg = msgs?.find((m) => m.info?.id === assistantMsgID);
      if (!failedMsg) {
        return false;
      }
      const toastContent = getRecoveryToastContent(errorType);
      logToast(`${toastContent.title}: ${toastContent.message}`, "warning");
      await client.tui.showToast({
        body: {
          title: toastContent.title,
          message: toastContent.message,
          variant: "warning"
        }
      }).catch(() => {
      });
      let success = false;
      if (errorType === "tool_result_missing") {
        success = await recoverToolResultMissing(client, sessionID, failedMsg);
      } else if (errorType === "thinking_block_order") {
        success = await recoverThinkingBlockOrder(
          sessionID,
          failedMsg,
          info.error
        );
        if (success && config.auto_resume) {
          const lastUser = findLastUserMessage(msgs ?? []);
          const resumeConfig = extractResumeConfig(lastUser, sessionID);
          await resumeSession(client, resumeConfig, directory);
        }
      } else if (errorType === "thinking_disabled_violation") {
        success = await recoverThinkingDisabledViolation(sessionID, failedMsg);
        if (success && config.auto_resume) {
          const lastUser = findLastUserMessage(msgs ?? []);
          const resumeConfig = extractResumeConfig(lastUser, sessionID);
          await resumeSession(client, resumeConfig, directory);
        }
      }
      return success;
    } catch (err) {
      log18.error("Recovery failed", { error: String(err) });
      return false;
    } finally {
      processingErrors.delete(assistantMsgID);
      if (sessionID && onRecoveryCompleteCallback) {
        onRecoveryCompleteCallback(sessionID);
      }
    }
  };
  return {
    handleSessionRecovery,
    isRecoverableError,
    setOnAbortCallback,
    setOnRecoveryCompleteCallback
  };
}

// src/plugin/event-handler.ts
function createEventHandler({
  client,
  config,
  directory,
  lifecycle,
  sessionRegistry,
  sessionRecovery,
  updateChecker,
  logger: logger2
}) {
  return async (input2) => {
    await updateChecker.event(input2);
    if (input2.event.type === "session.created") {
      const properties2 = input2.event.properties;
      const sessionId = properties2?.info?.id;
      const parentSessionId = properties2?.info?.parentID ?? null;
      if (sessionId) {
        sessionRegistry.register(sessionId, parentSessionId);
      }
      if (parentSessionId) {
        logger2.debug("child-session-detected", {
          sessionId,
          parentID: parentSessionId
        });
      } else {
        const previousSummary = lifecycle.getAccountManager()?.getSessionSummary();
        if (previousSummary && (previousSummary.totalClaude > 0 || previousSummary.totalGemini > 0)) {
          logger2.debug("prev-session-quota-summary", {
            durationMinutes: previousSummary.durationMinutes,
            totalClaude: previousSummary.totalClaude,
            totalGemini: previousSummary.totalGemini,
            requestsPerHour: previousSummary.requestsPerHour,
            accountsUsed: previousSummary.accountsUsed
          });
        }
        logger2.debug("root-session-detected", { sessionId });
      }
    }
    if (input2.event.type === "session.deleted") {
      const properties2 = input2.event.properties;
      const sessionId = properties2?.sessionID ?? properties2?.info?.id;
      if (sessionId) {
        sessionRegistry.delete(sessionId);
        lifecycle.getAccountManager()?.deleteSessionState(sessionId);
        const eventLogger = logger2;
        void removeSidebarActiveRouting(sessionId).catch((error2) => {
          eventLogger.debug("sidebar-route-remove-failed", {
            sessionId,
            error: String(error2)
          });
        });
      }
    }
    if (!sessionRecovery || input2.event.type !== "session.error") {
      return;
    }
    const properties = input2.event.properties;
    const sessionID = properties?.sessionID;
    const messageID = properties?.messageID;
    const error = properties?.error;
    if (!sessionRecovery.isRecoverableError(error)) {
      return;
    }
    const recovered = await sessionRecovery.handleSessionRecovery({
      id: messageID,
      role: "assistant",
      sessionID,
      error
    });
    if (!recovered || !sessionID || !config.auto_resume) {
      return;
    }
    await client.session.prompt({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: config.resume_text }] },
      query: { directory }
    }).catch(() => {
    });
    const successToast = getRecoverySuccessToast();
    const isChildSession = sessionRegistry.getParentSessionId(sessionID) !== null;
    logger2.debug("recovery-toast", {
      ...successToast,
      isChildSession,
      toastScope: config.toast_scope
    });
    if (config.toast_scope === "root_only" && isChildSession) {
      return;
    }
    await client.tui.showToast({
      body: {
        title: successToast.title,
        message: successToast.message,
        variant: "success"
      }
    }).catch(() => {
    });
  };
}

// src/plugin/errors.ts
var AntigravityKillswitchError = class extends Error {
  family;
  model;
  thresholdPercent;
  summaries;
  constructor(input2) {
    super(
      input2.message ?? `Antigravity killswitch: all ${input2.summaries.length} account(s) under ${input2.thresholdPercent}% quota for ${input2.family}. Refresh quota or raise the threshold via /antigravity-killswitch.`
    );
    this.name = "AntigravityKillswitchError";
    this.family = input2.family;
    this.model = input2.model;
    this.thresholdPercent = input2.thresholdPercent;
    this.summaries = input2.summaries;
  }
};

// src/plugin/fetch/retry-state.ts
var MAX_CONSECUTIVE_FAILURES = 5;
var FAILURE_COOLDOWN_MS = 3e4;
var FAILURE_STATE_RESET_MS = 12e4;
var RATE_LIMIT_DEDUP_WINDOW_MS = 2e3;
var RATE_LIMIT_STATE_RESET_MS = 12e4;
var RATE_LIMIT_TOAST_COOLDOWN_MS = 5e3;
var MAX_MAP_ENTRIES = 100;
var DISPOSED_BACKOFF = {
  attempt: 1,
  delayMs: 1e3,
  isDuplicate: false
};
var DISPOSED_FAILURE = {
  failures: 0,
  shouldCooldown: false,
  cooldownMs: 0
};
function evictOldestIfFull(map, key) {
  if (map.has(key) || map.size < MAX_MAP_ENTRIES) return 0;
  const oldest = map.keys().next().value;
  if (oldest === void 0) return 0;
  map.delete(oldest);
  return 1;
}
function createRetryState() {
  const rateLimitStateByAccountQuota = /* @__PURE__ */ new Map();
  const accountFailureState = /* @__PURE__ */ new Map();
  const rateLimitToastCooldowns = /* @__PURE__ */ new Map();
  const emptyResponseAttempts = /* @__PURE__ */ new Map();
  let softQuotaToastShownFlag = false;
  let rateLimitToastShownFlag = false;
  let disposed = false;
  function isDisposed() {
    return disposed;
  }
  function cleanupToastCooldowns() {
    if (rateLimitToastCooldowns.size <= MAX_MAP_ENTRIES) return;
    const now = Date.now();
    for (const [key, time] of rateLimitToastCooldowns) {
      if (now - time > RATE_LIMIT_TOAST_COOLDOWN_MS * 2) {
        rateLimitToastCooldowns.delete(key);
      }
    }
  }
  function getRateLimitBackoff(accountIndex, quotaKey, serverRetryAfterMs, maxBackoffMs = 6e4) {
    if (isDisposed()) return DISPOSED_BACKOFF;
    const now = Date.now();
    const stateKey = `${accountIndex}:${quotaKey}`;
    const previous = rateLimitStateByAccountQuota.get(stateKey);
    if (previous && now - previous.lastAt < RATE_LIMIT_DEDUP_WINDOW_MS) {
      const baseDelay2 = serverRetryAfterMs ?? 1e3;
      const backoffDelay2 = Math.min(
        baseDelay2 * 2 ** (previous.consecutive429 - 1),
        maxBackoffMs
      );
      return {
        attempt: previous.consecutive429,
        delayMs: Math.max(baseDelay2, backoffDelay2),
        isDuplicate: true
      };
    }
    const attempt = previous && now - previous.lastAt < RATE_LIMIT_STATE_RESET_MS ? previous.consecutive429 + 1 : 1;
    evictOldestIfFull(rateLimitStateByAccountQuota, stateKey);
    rateLimitStateByAccountQuota.set(stateKey, {
      consecutive429: attempt,
      lastAt: now,
      quotaKey
    });
    const baseDelay = serverRetryAfterMs ?? 1e3;
    const backoffDelay = Math.min(baseDelay * 2 ** (attempt - 1), maxBackoffMs);
    return {
      attempt,
      delayMs: Math.max(baseDelay, backoffDelay),
      isDuplicate: false
    };
  }
  function resetRateLimitState(accountIndex, quotaKey) {
    if (isDisposed()) return;
    const stateKey = `${accountIndex}:${quotaKey}`;
    rateLimitStateByAccountQuota.delete(stateKey);
  }
  function resetAllRateLimitStateForAccount(accountIndex) {
    if (isDisposed()) return;
    for (const key of rateLimitStateByAccountQuota.keys()) {
      if (key.startsWith(`${accountIndex}:`)) {
        rateLimitStateByAccountQuota.delete(key);
      }
    }
  }
  function headerStyleToQuotaKey(headerStyle, family) {
    if (family === "claude") return "claude";
    return headerStyle === "antigravity" ? "gemini-antigravity" : "gemini-cli";
  }
  function trackAccountFailure(accountIndex) {
    if (isDisposed()) return DISPOSED_FAILURE;
    const now = Date.now();
    const previous = accountFailureState.get(accountIndex);
    const failures = previous && now - previous.lastFailureAt < FAILURE_STATE_RESET_MS ? previous.consecutiveFailures + 1 : 1;
    evictOldestIfFull(accountFailureState, accountIndex);
    accountFailureState.set(accountIndex, {
      consecutiveFailures: failures,
      lastFailureAt: now
    });
    const shouldCooldown = failures >= MAX_CONSECUTIVE_FAILURES;
    const cooldownMs = shouldCooldown ? FAILURE_COOLDOWN_MS : 0;
    return { failures, shouldCooldown, cooldownMs };
  }
  function resetAccountFailureState(accountIndex) {
    if (isDisposed()) return;
    accountFailureState.delete(accountIndex);
  }
  function shouldShowRateLimitToast(message) {
    if (isDisposed()) return false;
    cleanupToastCooldowns();
    const toastKey = message.replace(/\d+/g, "X");
    const lastShown = rateLimitToastCooldowns.get(toastKey) ?? 0;
    const now = Date.now();
    if (now - lastShown < RATE_LIMIT_TOAST_COOLDOWN_MS) {
      return false;
    }
    evictOldestIfFull(rateLimitToastCooldowns, toastKey);
    rateLimitToastCooldowns.set(toastKey, now);
    return true;
  }
  function markSoftQuotaToastShown() {
    if (isDisposed()) return;
    softQuotaToastShownFlag = true;
  }
  function markRateLimitToastShown() {
    if (isDisposed()) return;
    rateLimitToastShownFlag = true;
  }
  function softQuotaToastShown() {
    return !isDisposed() && softQuotaToastShownFlag;
  }
  function rateLimitToastShown() {
    return !isDisposed() && rateLimitToastShownFlag;
  }
  function resetAllAccountsBlockedToasts() {
    if (isDisposed()) return;
    softQuotaToastShownFlag = false;
    rateLimitToastShownFlag = false;
  }
  function recordEmptyResponseAttempt(key) {
    if (isDisposed()) return 0;
    const next = (emptyResponseAttempts.get(key) ?? 0) + 1;
    evictOldestIfFull(emptyResponseAttempts, key);
    emptyResponseAttempts.set(key, next);
    return next;
  }
  function clearEmptyResponseAttempts() {
    if (isDisposed()) return;
    emptyResponseAttempts.clear();
  }
  function clear() {
    if (isDisposed()) return;
    rateLimitStateByAccountQuota.clear();
    accountFailureState.clear();
    rateLimitToastCooldowns.clear();
    emptyResponseAttempts.clear();
    softQuotaToastShownFlag = false;
    rateLimitToastShownFlag = false;
  }
  function dispose() {
    if (disposed) return;
    rateLimitStateByAccountQuota.clear();
    accountFailureState.clear();
    rateLimitToastCooldowns.clear();
    emptyResponseAttempts.clear();
    softQuotaToastShownFlag = false;
    rateLimitToastShownFlag = false;
    disposed = true;
  }
  function sizes() {
    return {
      rateLimitState: rateLimitStateByAccountQuota.size,
      accountFailure: accountFailureState.size,
      rateLimitToast: rateLimitToastCooldowns.size,
      emptyResponse: emptyResponseAttempts.size
    };
  }
  return {
    get disposed() {
      return disposed;
    },
    getRateLimitBackoff,
    resetRateLimitState,
    resetAllRateLimitStateForAccount,
    headerStyleToQuotaKey,
    trackAccountFailure,
    resetAccountFailureState,
    shouldShowRateLimitToast,
    markSoftQuotaToastShown,
    markRateLimitToastShown,
    softQuotaToastShown,
    rateLimitToastShown,
    resetAllAccountsBlockedToasts,
    recordEmptyResponseAttempt,
    clearEmptyResponseAttempts,
    clear,
    dispose,
    sizes
  };
}

// src/plugin/fetch/warmup.ts
var MAX_WARMUP_SESSIONS = 1e3;
var MAX_WARMUP_RETRIES = 2;
function createWarmupState() {
  const warmupAttemptedSessionIds = /* @__PURE__ */ new Set();
  const warmupSucceededSessionIds = /* @__PURE__ */ new Set();
  let disposed = false;
  function trackAttempt(sessionId) {
    if (disposed) return false;
    if (warmupSucceededSessionIds.has(sessionId)) {
      return false;
    }
    if (warmupAttemptedSessionIds.size >= MAX_WARMUP_SESSIONS) {
      const first = warmupAttemptedSessionIds.values().next().value;
      if (first) {
        warmupAttemptedSessionIds.delete(first);
        warmupSucceededSessionIds.delete(first);
      }
    }
    const attempts = getAttemptCount(sessionId);
    if (attempts >= MAX_WARMUP_RETRIES) {
      return false;
    }
    warmupAttemptedSessionIds.add(sessionId);
    return true;
  }
  function getAttemptCount(sessionId) {
    return warmupAttemptedSessionIds.has(sessionId) ? 1 : 0;
  }
  function markSuccess(sessionId) {
    if (disposed) return;
    warmupSucceededSessionIds.add(sessionId);
    if (warmupSucceededSessionIds.size >= MAX_WARMUP_SESSIONS) {
      const first = warmupSucceededSessionIds.values().next().value;
      if (first) warmupSucceededSessionIds.delete(first);
    }
  }
  function clearWarmupAttempt(sessionId) {
    if (disposed) return;
    warmupAttemptedSessionIds.delete(sessionId);
  }
  function clear() {
    warmupAttemptedSessionIds.clear();
    warmupSucceededSessionIds.clear();
  }
  function dispose() {
    if (disposed) return;
    clear();
    disposed = true;
  }
  return {
    get disposed() {
      return disposed;
    },
    trackAttempt,
    getAttemptCount,
    markSuccess,
    clearWarmupAttempt,
    clear,
    dispose
  };
}

// src/plugin/fetch-routing.ts
var MAX_TOTAL_CAPACITY_RETRIES = 4;
function isCapacityRetryBudgetExhausted(totalCapacityRetries) {
  return totalCapacityRetries >= MAX_TOTAL_CAPACITY_RETRIES;
}
function toUrlString(value) {
  if (typeof value === "string") {
    return value;
  }
  const candidate = value.url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}
function toWarmupStreamUrl(value) {
  const urlString = toUrlString(value);
  try {
    const url = new URL(urlString);
    if (!url.pathname.includes(":streamGenerateContent")) {
      url.pathname = url.pathname.replace(
        ":generateContent",
        ":streamGenerateContent"
      );
    }
    url.searchParams.set("alt", "sse");
    return url.toString();
  } catch {
    return urlString;
  }
}
function extractModelFromUrl(urlString) {
  const match = urlString.match(/\/models\/([^:/?]+)(?::\w+)?/);
  return match?.[1] ?? null;
}
function extractModelFromUrlWithSuffix(urlString) {
  const match = urlString.match(/\/models\/([^:/?]+)/);
  return match?.[1] ?? null;
}
function getModelFamilyFromUrl(urlString) {
  const model = extractModelFromUrl(urlString);
  let family = "gemini";
  if (model?.includes("claude")) {
    family = "claude";
  }
  if (isDebugEnabled()) {
    logModelFamily(urlString, model, family);
  }
  return family;
}
function resolveQuotaFallbackHeaderStyle(input2) {
  if (input2.family !== "gemini") {
    return null;
  }
  if (!input2.alternateStyle || input2.alternateStyle === input2.headerStyle) {
    return null;
  }
  return input2.alternateStyle;
}
function resolveHeaderRoutingDecision(urlString, family, config) {
  const cliFirst = getCliFirst(config);
  const preferredHeaderStyle = getHeaderStyleFromUrl(
    urlString,
    family,
    cliFirst
  );
  const explicitQuota = isExplicitQuotaFromUrl(urlString);
  return {
    cliFirst,
    preferredHeaderStyle,
    explicitQuota,
    allowQuotaFallback: family === "gemini" && !!(config.quota_style_fallback ?? false)
  };
}
function getCliFirst(config) {
  return config.cli_first ?? false;
}
function getHeaderStyleFromUrl(urlString, family, cliFirst = false) {
  if (family === "claude") {
    return "antigravity";
  }
  const modelWithSuffix = extractModelFromUrlWithSuffix(urlString);
  if (!modelWithSuffix) {
    return cliFirst ? "gemini-cli" : "antigravity";
  }
  const { quotaPreference } = resolveModelWithTier(modelWithSuffix, {
    cli_first: cliFirst
  });
  return quotaPreference ?? "antigravity";
}
function isExplicitQuotaFromUrl(urlString) {
  const modelWithSuffix = extractModelFromUrlWithSuffix(urlString);
  if (!modelWithSuffix) {
    return false;
  }
  const { explicitQuota } = resolveModelWithTier(modelWithSuffix);
  return explicitQuota ?? false;
}

// src/plugin/killswitch.ts
import { createHash as createHash10 } from "node:crypto";
var DEFAULT_CACHE_TTL_MS = 5 * 60 * 1e3;
var QUOTA_GROUP_BY_FAMILY = {
  claude: ["non-gemini"],
  gemini: ["gemini", "non-gemini"]
};
function quotaGroupForModel(family, model) {
  if (!model) return null;
  const lower = model.toLowerCase();
  if (family === "claude") return "non-gemini";
  if (family === "gemini") {
    if (lower.includes("claude") || lower.includes("gpt-oss")) {
      return "non-gemini";
    }
    if (lower.includes("gemini") || lower.startsWith("tab_")) return "gemini";
  }
  return null;
}
function accountKeyForRefreshToken(refreshToken) {
  return createHash10("sha256").update(refreshToken).digest("hex").slice(0, 12);
}
function evaluateKillswitchForAccount(account, family, settings, options = {}) {
  if (!settings.killswitch.enabled) {
    return {
      allowed: true,
      reason: "killswitch-disabled",
      thresholdPercent: 0,
      remainingPercent: null
    };
  }
  const accountKey = account.refreshToken ? accountKeyForRefreshToken(account.refreshToken) : `idx-${account.index}`;
  const thresholdPercent = settings.killswitch.accounts?.[accountKey] ?? settings.killswitch.minimum_remaining_percent;
  const now = options.now ?? Date.now();
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const freshEnough = typeof account.cachedQuotaUpdatedAt === "number" && now - account.cachedQuotaUpdatedAt <= cacheTtlMs;
  const quota = freshEnough ? account.cachedQuota : void 0;
  if (!quota) {
    return {
      allowed: true,
      reason: "quota-missing-or-stale",
      thresholdPercent,
      remainingPercent: null
    };
  }
  const remainingPercent = quotaGroupForModel(family, options.model) ? remainingPercentForGroup(quota, family, options.model) : freshestRemainingPercent(quota, family);
  if (remainingPercent === null) {
    return {
      allowed: true,
      reason: "quota-missing-or-stale",
      thresholdPercent,
      remainingPercent: null
    };
  }
  return {
    allowed: remainingPercent >= thresholdPercent,
    reason: remainingPercent >= thresholdPercent ? "ok" : "below-threshold",
    thresholdPercent,
    remainingPercent
  };
}
function freshestRemainingPercent(quota, family) {
  const groups = QUOTA_GROUP_BY_FAMILY[family];
  let best = null;
  for (const group of groups) {
    const entry = quota[group];
    if (!entry || typeof entry.remainingFraction !== "number") continue;
    const pct = clampPercent(entry.remainingFraction * 100);
    if (best === null || pct > best) best = pct;
  }
  return best;
}
function remainingPercentForGroup(quota, family, model) {
  const group = quotaGroupForModel(family, model);
  if (!group) return null;
  const entry = quota[group];
  if (!entry || typeof entry.remainingFraction !== "number") return null;
  return clampPercent(entry.remainingFraction * 100);
}
function clampPercent(value) {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}
function summarizeKillswitchOutcomes(accounts, family, settings, options = {}) {
  return accounts.map((account) => {
    const decision = evaluateKillswitchForAccount(
      account,
      family,
      settings,
      options
    );
    const accountKey = account.refreshToken ? accountKeyForRefreshToken(account.refreshToken) : `idx-${account.index}`;
    return {
      accountKey,
      remainingPercent: decision.remainingPercent,
      thresholdPercent: decision.thresholdPercent
    };
  });
}
function throwIfAllKilled(input2) {
  const { family, model, accounts, settings, quotaModel } = input2;
  if (!settings.killswitch.enabled) return;
  const summaryOptions = {
    ...input2.now !== void 0 ? { now: input2.now } : {},
    ...input2.cacheTtlMs !== void 0 ? { cacheTtlMs: input2.cacheTtlMs } : {},
    ...quotaModel !== void 0 ? { model: quotaModel } : {}
  };
  const summaries = summarizeKillswitchOutcomes(
    accounts,
    family,
    settings,
    summaryOptions
  );
  const allKilled = accounts.every((account) => {
    const decision = evaluateKillswitchForAccount(
      account,
      family,
      settings,
      summaryOptions
    );
    return decision.reason === "below-threshold";
  });
  if (!allKilled) return;
  const thresholdPercent = settings.killswitch.minimum_remaining_percent;
  throw new AntigravityKillswitchError({
    family,
    model,
    thresholdPercent,
    summaries
  });
}

// src/plugin/request.ts
import crypto2 from "node:crypto";

// src/plugin/image-saver.ts
import { chmodSync, existsSync as existsSync10, mkdirSync as mkdirSync8, writeFileSync as writeFileSync8 } from "node:fs";
import { homedir as homedir11 } from "node:os";
import { join as join18 } from "node:path";
function getImageOutputDir(outputDir) {
  const resolved = outputDir ?? join18(homedir11(), ".opencode", "generated-images");
  if (!existsSync10(resolved)) {
    mkdirSync8(resolved, { recursive: true, mode: 448 });
  }
  chmodSync(resolved, 448);
  return resolved;
}
function generateImageFilename(mimeType) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const random = Math.random().toString(36).substring(2, 8);
  let extension = "png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
    extension = "jpg";
  } else if (mimeType.includes("gif")) {
    extension = "gif";
  } else if (mimeType.includes("webp")) {
    extension = "webp";
  }
  return `image-${timestamp}-${random}.${extension}`;
}
function saveImageToDisk(base64Data, mimeType, outputDir) {
  try {
    const resolvedOutputDir = getImageOutputDir(outputDir);
    const filePath = join18(resolvedOutputDir, generateImageFilename(mimeType));
    writeFileSync8(filePath, Buffer.from(base64Data, "base64"), { mode: 384 });
    chmodSync(filePath, 384);
    return filePath;
  } catch (error) {
    console.error("[image-saver] Failed to save image:", error);
    return "";
  }
}
function processImageData(inlineData, outputDir) {
  const mimeType = inlineData.mimeType || "image/png";
  const data = inlineData.data;
  if (!data) {
    return null;
  }
  const filePath = saveImageToDisk(data, mimeType, outputDir);
  if (filePath) {
    return `![Generated Image](${filePath})

Image saved to: \`${filePath}\`

To view: \`open "${filePath}"\``;
  }
  return `![Generated Image](data:${mimeType};base64,${data})`;
}

// src/plugin/core/streaming/transformer.ts
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}
function createThoughtBuffer() {
  const buffer = /* @__PURE__ */ new Map();
  return {
    get: (index) => buffer.get(index),
    set: (index, text) => buffer.set(index, text),
    clear: () => buffer.clear()
  };
}
function deduplicateThinkingText(response, sentBuffer, displayedThinkingHashes) {
  if (!response || typeof response !== "object") return response;
  const resp = response;
  if (Array.isArray(resp.candidates)) {
    const newCandidates = resp.candidates.map(
      (candidate, index) => {
        const cand = candidate;
        if (!cand?.content) return candidate;
        const content = cand.content;
        if (!Array.isArray(content.parts)) return candidate;
        const newParts = content.parts.flatMap((part) => {
          const p = part;
          if (p.inlineData) {
            const inlineData = p.inlineData;
            const result = processImageData({
              mimeType: inlineData.mimeType,
              data: inlineData.data
            });
            if (result) {
              return { text: result };
            }
          }
          if (p.thought === true || p.type === "thinking") {
            const fullText = typeof p.text === "string" ? p.text : typeof p.thinking === "string" ? p.thinking : "";
            if (displayedThinkingHashes) {
              const hash = hashString(fullText);
              if (displayedThinkingHashes.has(hash)) {
                sentBuffer.set(index, fullText);
                return [];
              }
              displayedThinkingHashes.add(hash);
            }
            const sentText = sentBuffer.get(index) ?? "";
            if (fullText.startsWith(sentText)) {
              const delta = fullText.slice(sentText.length);
              sentBuffer.set(index, fullText);
              if (delta) {
                return { thought: true, text: delta };
              }
              return [];
            }
            sentBuffer.set(index, fullText);
            return part;
          }
          return [part];
        });
        return {
          ...cand,
          content: { ...content, parts: newParts }
        };
      }
    );
    return { ...resp, candidates: newCandidates };
  }
  if (Array.isArray(resp.content)) {
    let thinkingIndex = 0;
    const newContent = resp.content.flatMap((block) => {
      const b = block;
      if (b?.type === "thinking") {
        const fullText = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
        if (displayedThinkingHashes) {
          const hash = hashString(fullText);
          if (displayedThinkingHashes.has(hash)) {
            sentBuffer.set(thinkingIndex, fullText);
            thinkingIndex++;
            return [];
          }
          displayedThinkingHashes.add(hash);
        }
        const sentText = sentBuffer.get(thinkingIndex) ?? "";
        if (fullText.startsWith(sentText)) {
          const delta = fullText.slice(sentText.length);
          sentBuffer.set(thinkingIndex, fullText);
          thinkingIndex++;
          if (delta) {
            return { type: b.type, thinking: delta, text: delta };
          }
          return [];
        }
        sentBuffer.set(thinkingIndex, fullText);
        thinkingIndex++;
        return block;
      }
      return [block];
    });
    return { ...resp, content: newContent };
  }
  return response;
}
function extractUsageMetadataFromDataLine(line) {
  if (!line.startsWith("data:")) return void 0;
  const json = line.slice(5).trim();
  if (!json || json === "[DONE]") return void 0;
  try {
    const parsed = JSON.parse(json);
    const response = parsed && typeof parsed === "object" && "response" in parsed ? parsed.response : parsed;
    if (!response || typeof response !== "object") return void 0;
    const usage = response.usageMetadata;
    return usage && typeof usage === "object" ? usage : void 0;
  } catch {
    return void 0;
  }
}
function usageMetadataHasCacheRead(usageMetadata) {
  return typeof usageMetadata?.cachedContentTokenCount === "number";
}
function completeSseEventSuffix(suffix) {
  if (suffix.includes("\n\n")) return suffix;
  if (suffix.endsWith("\n")) return `${suffix}
`;
  return `${suffix}

`;
}
function mergeUsageMetadataIntoDataLine(line, usageMetadata) {
  if (!usageMetadata || !line.startsWith("data:")) return line;
  const json = line.slice(5).trim();
  if (!json || json === "[DONE]") return line;
  try {
    const parsed = JSON.parse(json);
    const hasResponseWrapper = !!parsed && typeof parsed === "object" && "response" in parsed;
    const response = hasResponseWrapper ? parsed.response : parsed;
    if (!response || typeof response !== "object") return line;
    const mutableResponse = response;
    const existing = mutableResponse.usageMetadata && typeof mutableResponse.usageMetadata === "object" ? mutableResponse.usageMetadata : {};
    mutableResponse.usageMetadata = { ...existing, ...usageMetadata };
    return `data: ${JSON.stringify(parsed)}`;
  } catch {
    return line;
  }
}
function responseHasToolCall(response) {
  if (!response || typeof response !== "object") return false;
  const resp = response;
  if (Array.isArray(resp.candidates)) {
    return resp.candidates.some((candidate) => {
      const cand = candidate;
      const content = cand?.content;
      const parts = content?.parts;
      return Array.isArray(parts) && parts.some((part) => {
        const p = part;
        return Boolean(p?.functionCall) || p?.type === "tool_use";
      });
    });
  }
  if (Array.isArray(resp.content)) {
    return resp.content.some((block) => {
      const b = block;
      return Boolean(b?.functionCall) || b?.type === "tool_use";
    });
  }
  return false;
}
function responseHasFinishReason(response) {
  if (!response || typeof response !== "object") return false;
  const resp = response;
  if (Array.isArray(resp.candidates)) {
    return resp.candidates.some((candidate) => {
      const cand = candidate;
      return typeof cand?.finishReason === "string" && cand.finishReason.length > 0;
    });
  }
  const stopReason = resp.stopReason ?? resp.stop_reason;
  return typeof stopReason === "string" && stopReason.length > 0;
}
function transformSseLineWithMetadata(line, signatureStore, thoughtBuffer, sentThinkingBuffer, callbacks, options, debugState2, usageState) {
  if (!line.startsWith("data:")) {
    return { line, hasToolCall: false, hasFinishReason: false };
  }
  const json = line.slice(5).trim();
  if (!json) {
    return { line, hasToolCall: false, hasFinishReason: false };
  }
  try {
    const parsed = JSON.parse(json);
    if (parsed.response !== void 0) {
      const hasToolCall = responseHasToolCall(parsed.response);
      const hasFinishReason = responseHasFinishReason(parsed.response);
      if (options.cacheSignatures && options.signatureSessionKey) {
        cacheThinkingSignaturesFromResponse(
          parsed.response,
          options.signatureSessionKey,
          signatureStore,
          thoughtBuffer,
          callbacks.onCacheSignature
        );
      }
      if (usageState) {
        const resp = parsed.response;
        const meta = resp.usageMetadata;
        if (meta && typeof meta === "object") {
          usageState.lastUsage = {
            cachedContentTokenCount: typeof meta.cachedContentTokenCount === "number" ? meta.cachedContentTokenCount : 0,
            promptTokenCount: typeof meta.promptTokenCount === "number" ? meta.promptTokenCount : 0,
            candidatesTokenCount: typeof meta.candidatesTokenCount === "number" ? meta.candidatesTokenCount : 0,
            totalTokenCount: typeof meta.totalTokenCount === "number" ? meta.totalTokenCount : 0
          };
        }
      }
      let response = deduplicateThinkingText(
        parsed.response,
        sentThinkingBuffer,
        options.displayedThinkingHashes
      );
      if (options.debugText && callbacks.onInjectDebug && !debugState2.injected) {
        response = callbacks.onInjectDebug(response, options.debugText);
        debugState2.injected = true;
      }
      const transformed = callbacks.transformThinkingParts ? callbacks.transformThinkingParts(response) : response;
      return {
        line: `data: ${JSON.stringify(transformed)}`,
        hasToolCall,
        hasFinishReason
      };
    }
  } catch (_) {
    console.warn(
      "[antigravity] Malformed SSE chunk in streaming transform, passing through untransformed:",
      json.slice(0, 200)
    );
  }
  return { line, hasToolCall: false, hasFinishReason: false };
}
function cacheThinkingSignaturesFromResponse(response, signatureSessionKey, signatureStore, thoughtBuffer, onCacheSignature) {
  if (!response || typeof response !== "object") return;
  const resp = response;
  if (Array.isArray(resp.candidates)) {
    resp.candidates.forEach((candidate, index) => {
      const cand = candidate;
      if (!cand?.content) return;
      const content = cand.content;
      if (!Array.isArray(content.parts)) return;
      content.parts.forEach((part) => {
        const p = part;
        if (p.thought === true || p.type === "thinking") {
          const text = typeof p.text === "string" ? p.text : typeof p.thinking === "string" ? p.thinking : "";
          if (text) {
            const current = thoughtBuffer.get(index) ?? "";
            thoughtBuffer.set(index, current + text);
          }
        }
        if (p.thoughtSignature) {
          const fullText = thoughtBuffer.get(index) ?? "";
          if (fullText) {
            const signature = p.thoughtSignature;
            onCacheSignature?.(signatureSessionKey, fullText, signature);
            signatureStore.set(signatureSessionKey, {
              text: fullText,
              signature
            });
          }
        }
      });
    });
  }
  if (Array.isArray(resp.content)) {
    const CLAUDE_BUFFER_KEY = 0;
    resp.content.forEach((block) => {
      const b = block;
      if (b?.type === "thinking") {
        const text = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
        if (text) {
          const current = thoughtBuffer.get(CLAUDE_BUFFER_KEY) ?? "";
          thoughtBuffer.set(CLAUDE_BUFFER_KEY, current + text);
        }
      }
      if (b?.signature) {
        const fullText = thoughtBuffer.get(CLAUDE_BUFFER_KEY) ?? "";
        if (fullText) {
          const signature = b.signature;
          onCacheSignature?.(signatureSessionKey, fullText, signature);
          signatureStore.set(signatureSessionKey, { text: fullText, signature });
        }
      }
    });
  }
}
function createStreamingTransformer(signatureStore, callbacks, options = {}) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const thoughtBuffer = createThoughtBuffer();
  const sentThinkingBuffer = createThoughtBuffer();
  const debugState2 = { injected: false };
  let hasSeenUsageMetadata = false;
  let terminatedAfterFinishReason = false;
  const pendingUsageLines = [];
  const usageState = {
    lastUsage: null
  };
  const emitSyntheticUsageIfMissing = (controller) => {
    if (hasSeenUsageMetadata) return;
    const syntheticUsage = {
      response: {
        usageMetadata: {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          totalTokenCount: 0
        }
      }
    };
    controller.enqueue(
      encoder.encode(`
data: ${JSON.stringify(syntheticUsage)}

`)
    );
    hasSeenUsageMetadata = true;
  };
  const emitUsageCallback = () => {
    if (usageState.lastUsage && callbacks.onUsageMetadata) {
      callbacks.onUsageMetadata(usageState.lastUsage);
    }
  };
  const emitPendingUsageLines = (controller, finalUsage) => {
    while (pendingUsageLines.length > 0) {
      const pending = pendingUsageLines.shift();
      if (!pending) continue;
      const line = mergeUsageMetadataIntoDataLine(pending.line, finalUsage);
      controller.enqueue(encoder.encode(line + pending.suffix));
    }
  };
  const processLine = (line, controller, suffix) => {
    if (pendingUsageLines.length > 0 && line.trim() === "") {
      const lastPending = pendingUsageLines[pendingUsageLines.length - 1];
      if (lastPending) lastPending.suffix += suffix;
      return false;
    }
    if (line.includes("usageMetadata")) {
      hasSeenUsageMetadata = true;
    }
    const result = transformSseLineWithMetadata(
      line,
      signatureStore,
      thoughtBuffer,
      sentThinkingBuffer,
      callbacks,
      options,
      debugState2,
      usageState
    );
    if (!result.hasFinishReason && pendingUsageLines.length > 0) {
      emitPendingUsageLines(controller);
    }
    const lineUsage = extractUsageMetadataFromDataLine(result.line);
    if (!result.hasFinishReason && lineUsage && !usageMetadataHasCacheRead(lineUsage)) {
      pendingUsageLines.push({ line: result.line, suffix });
      return false;
    }
    if (result.hasFinishReason) {
      const finalUsage = lineUsage;
      emitPendingUsageLines(controller, finalUsage);
      controller.enqueue(
        encoder.encode(result.line + completeSseEventSuffix(suffix))
      );
      emitSyntheticUsageIfMissing(controller);
      emitUsageCallback();
      terminatedAfterFinishReason = true;
      controller.terminate();
      return true;
    }
    emitPendingUsageLines(controller);
    controller.enqueue(encoder.encode(result.line + suffix));
    return false;
  };
  return new TransformStream({
    transform(chunk, controller) {
      if (terminatedAfterFinishReason) return;
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (processLine(line, controller, "\n")) {
          return;
        }
      }
    },
    flush(controller) {
      if (terminatedAfterFinishReason) return;
      buffer += decoder.decode();
      if (buffer && processLine(buffer, controller, "")) {
        return;
      }
      emitPendingUsageLines(controller);
      emitSyntheticUsageIfMissing(controller);
      emitUsageCallback();
    }
  });
}

// src/plugin/request-helpers.ts
var log13 = createLogger2("request-helpers");
var ANTIGRAVITY_PREVIEW_LINK = "https://goo.gle/enable-preview-features";
var UNSUPPORTED_CONSTRAINTS = [
  "minLength",
  "maxLength",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "pattern",
  "minItems",
  "maxItems",
  "format",
  "default",
  "examples"
];
var UNSUPPORTED_KEYWORDS = [
  ...UNSUPPORTED_CONSTRAINTS,
  "$schema",
  "$defs",
  "definitions",
  "const",
  "$ref",
  "additionalProperties",
  "propertyNames",
  "title",
  "$id",
  "$comment"
];
function appendDescriptionHint(schema, hint) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const existing = typeof schema.description === "string" ? schema.description : "";
  const newDescription = existing ? `${existing} (${hint})` : hint;
  return { ...schema, description: newDescription };
}
function convertRefsToHints(schema) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => convertRefsToHints(item));
  }
  if (typeof schema.$ref === "string") {
    const refVal = schema.$ref;
    const defName = refVal.includes("/") ? refVal.split("/").pop() : refVal;
    const hint = `See: ${defName}`;
    const existingDesc = typeof schema.description === "string" ? schema.description : "";
    const newDescription = existingDesc ? `${existingDesc} (${hint})` : hint;
    return { type: "object", description: newDescription };
  }
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    result[key] = convertRefsToHints(value);
  }
  return result;
}
function convertConstToEnum(schema) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => convertConstToEnum(item));
  }
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "const" && !schema.enum) {
      result.enum = [value];
    } else {
      result[key] = convertConstToEnum(value);
    }
  }
  return result;
}
function addEnumHints(schema) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => addEnumHints(item));
  }
  let result = { ...schema };
  if (Array.isArray(result.enum) && result.enum.length > 1 && result.enum.length <= 10) {
    const vals = result.enum.map((v) => String(v)).join(", ");
    result = appendDescriptionHint(result, `Allowed: ${vals}`);
  }
  for (const [key, value] of Object.entries(result)) {
    if (key !== "enum" && typeof value === "object" && value !== null) {
      result[key] = addEnumHints(value);
    }
  }
  return result;
}
function addAdditionalPropertiesHints(schema) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => addAdditionalPropertiesHints(item));
  }
  let result = { ...schema };
  if (result.additionalProperties === false) {
    result = appendDescriptionHint(result, "No extra properties allowed");
  }
  for (const [key, value] of Object.entries(result)) {
    if (key !== "additionalProperties" && typeof value === "object" && value !== null) {
      result[key] = addAdditionalPropertiesHints(value);
    }
  }
  return result;
}
function moveConstraintsToDescription(schema) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => moveConstraintsToDescription(item));
  }
  let result = { ...schema };
  for (const constraint of UNSUPPORTED_CONSTRAINTS) {
    if (result[constraint] !== void 0 && typeof result[constraint] !== "object") {
      result = appendDescriptionHint(
        result,
        `${constraint}: ${result[constraint]}`
      );
    }
  }
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "object" && value !== null) {
      result[key] = moveConstraintsToDescription(value);
    }
  }
  return result;
}
function mergeAllOf(schema) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => mergeAllOf(item));
  }
  const result = { ...schema };
  if (Array.isArray(result.allOf)) {
    const merged = {};
    const mergedRequired = [];
    for (const item of result.allOf) {
      if (!item || typeof item !== "object") continue;
      if (item.properties && typeof item.properties === "object") {
        merged.properties = { ...merged.properties, ...item.properties };
      }
      if (Array.isArray(item.required)) {
        for (const req of item.required) {
          if (!mergedRequired.includes(req)) {
            mergedRequired.push(req);
          }
        }
      }
      for (const [key, value] of Object.entries(item)) {
        if (key !== "properties" && key !== "required" && merged[key] === void 0) {
          merged[key] = value;
        }
      }
    }
    if (merged.properties) {
      result.properties = { ...result.properties, ...merged.properties };
    }
    if (mergedRequired.length > 0) {
      const existingRequired = Array.isArray(result.required) ? result.required : [];
      result.required = Array.from(
        /* @__PURE__ */ new Set([...existingRequired, ...mergedRequired])
      );
    }
    for (const [key, value] of Object.entries(merged)) {
      if (key !== "properties" && key !== "required" && result[key] === void 0) {
        result[key] = value;
      }
    }
    delete result.allOf;
  }
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "object" && value !== null) {
      result[key] = mergeAllOf(value);
    }
  }
  return result;
}
function scoreSchemaOption(schema) {
  if (!schema || typeof schema !== "object") {
    return { score: 0, typeName: "unknown" };
  }
  const type = schema.type;
  if (type === "object" || schema.properties) {
    return { score: 3, typeName: "object" };
  }
  if (type === "array" || schema.items) {
    return { score: 2, typeName: "array" };
  }
  if (type && type !== "null") {
    return { score: 1, typeName: type };
  }
  return { score: 0, typeName: type || "null" };
}
function tryMergeEnumFromUnion(options) {
  if (!Array.isArray(options) || options.length === 0) {
    return null;
  }
  const enumValues = [];
  for (const option of options) {
    if (!option || typeof option !== "object") {
      return null;
    }
    if (option.const !== void 0) {
      enumValues.push(String(option.const));
      continue;
    }
    if (Array.isArray(option.enum) && option.enum.length === 1) {
      enumValues.push(String(option.enum[0]));
      continue;
    }
    if (Array.isArray(option.enum) && option.enum.length > 0) {
      for (const val of option.enum) {
        enumValues.push(String(val));
      }
      continue;
    }
    if (option.properties || option.items || option.anyOf || option.oneOf || option.allOf) {
      return null;
    }
    if (option.type && !option.const && !option.enum) {
      return null;
    }
  }
  return enumValues.length > 0 ? enumValues : null;
}
function flattenAnyOfOneOf(schema) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => flattenAnyOfOneOf(item));
  }
  let result = { ...schema };
  for (const unionKey of ["anyOf", "oneOf"]) {
    if (Array.isArray(result[unionKey]) && result[unionKey].length > 0) {
      const options = result[unionKey];
      const parentDesc = typeof result.description === "string" ? result.description : "";
      const mergedEnum = tryMergeEnumFromUnion(options);
      if (mergedEnum !== null) {
        const { [unionKey]: _2, ...rest2 } = result;
        result = {
          ...rest2,
          type: "string",
          enum: mergedEnum
        };
        if (parentDesc) {
          result.description = parentDesc;
        }
        continue;
      }
      let bestIdx = 0;
      let bestScore = -1;
      const allTypes = [];
      for (let i = 0; i < options.length; i++) {
        const { score, typeName } = scoreSchemaOption(options[i]);
        if (typeName) {
          allTypes.push(typeName);
        }
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      let selected = flattenAnyOfOneOf(options[bestIdx]) || { type: "string" };
      if (parentDesc) {
        const childDesc = typeof selected.description === "string" ? selected.description : "";
        if (childDesc && childDesc !== parentDesc) {
          selected = {
            ...selected,
            description: `${parentDesc} (${childDesc})`
          };
        } else if (!childDesc) {
          selected = { ...selected, description: parentDesc };
        }
      }
      if (allTypes.length > 1) {
        const uniqueTypes = Array.from(new Set(allTypes));
        const hint = `Accepts: ${uniqueTypes.join(" | ")}`;
        selected = appendDescriptionHint(selected, hint);
      }
      const { [unionKey]: _, description: __, ...rest } = result;
      result = { ...rest, ...selected };
    }
  }
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "object" && value !== null) {
      result[key] = flattenAnyOfOneOf(value);
    }
  }
  return result;
}
function flattenTypeArrays(schema, nullableFields, currentPath) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map(
      (item, idx) => flattenTypeArrays(item, nullableFields, `${currentPath || ""}[${idx}]`)
    );
  }
  let result = { ...schema };
  const localNullableFields = nullableFields || /* @__PURE__ */ new Map();
  if (Array.isArray(result.type)) {
    const types = result.type;
    const hasNull = types.includes("null");
    const nonNullTypes = types.filter((t) => t !== "null" && t);
    const firstType = nonNullTypes.length > 0 ? nonNullTypes[0] : "string";
    result.type = firstType;
    if (nonNullTypes.length > 1) {
      result = appendDescriptionHint(
        result,
        `Accepts: ${nonNullTypes.join(" | ")}`
      );
    }
    if (hasNull) {
      result = appendDescriptionHint(result, "nullable");
    }
  }
  if (result.properties && typeof result.properties === "object") {
    const newProps = {};
    for (const [propKey, propValue] of Object.entries(result.properties)) {
      const propPath = currentPath ? `${currentPath}.properties.${propKey}` : `properties.${propKey}`;
      const processed = flattenTypeArrays(
        propValue,
        localNullableFields,
        propPath
      );
      newProps[propKey] = processed;
      if (processed && typeof processed === "object" && typeof processed.description === "string" && processed.description.includes("nullable")) {
        const objectPath = currentPath || "";
        const existing = localNullableFields.get(objectPath) || [];
        existing.push(propKey);
        localNullableFields.set(objectPath, existing);
      }
    }
    result.properties = newProps;
  }
  if (Array.isArray(result.required) && !nullableFields) {
    const nullableAtRoot = localNullableFields.get("") || [];
    if (nullableAtRoot.length > 0) {
      result.required = result.required.filter(
        (r) => !nullableAtRoot.includes(r)
      );
      if (result.required.length === 0) {
        delete result.required;
      }
    }
  }
  for (const [key, value] of Object.entries(result)) {
    if (key !== "properties" && typeof value === "object" && value !== null) {
      result[key] = flattenTypeArrays(
        value,
        localNullableFields,
        `${currentPath || ""}.${key}`
      );
    }
  }
  return result;
}
function removeUnsupportedKeywords(schema, insideProperties = false) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => removeUnsupportedKeywords(item, false));
  }
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!insideProperties && UNSUPPORTED_KEYWORDS.includes(key)) {
      continue;
    }
    if (typeof value === "object" && value !== null) {
      if (key === "properties") {
        const propertiesResult = {};
        for (const [propName, propSchema] of Object.entries(value)) {
          propertiesResult[propName] = removeUnsupportedKeywords(
            propSchema,
            false
          );
        }
        result[key] = propertiesResult;
      } else {
        result[key] = removeUnsupportedKeywords(value, false);
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}
function cleanupRequiredFields(schema) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => cleanupRequiredFields(item));
  }
  const result = { ...schema };
  if (Array.isArray(result.required) && result.properties && typeof result.properties === "object") {
    const validRequired = result.required.filter(
      (req) => Object.hasOwn(result.properties, req)
    );
    if (validRequired.length === 0) {
      delete result.required;
    } else if (validRequired.length !== result.required.length) {
      result.required = validRequired;
    }
  }
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "object" && value !== null) {
      result[key] = cleanupRequiredFields(value);
    }
  }
  return result;
}
function addEmptySchemaPlaceholder(schema) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => addEmptySchemaPlaceholder(item));
  }
  const result = { ...schema };
  const isObjectType = result.type === "object";
  if (isObjectType) {
    const hasProperties = result.properties && typeof result.properties === "object" && Object.keys(result.properties).length > 0;
    if (!hasProperties) {
      result.properties = {
        [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
          type: "boolean",
          description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION
        }
      };
      result.required = [EMPTY_SCHEMA_PLACEHOLDER_NAME];
    }
  }
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "object" && value !== null) {
      result[key] = addEmptySchemaPlaceholder(value);
    }
  }
  return result;
}
function cleanJSONSchemaForAntigravity(schema) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  let result = schema;
  result = convertRefsToHints(result);
  result = convertConstToEnum(result);
  result = addEnumHints(result);
  result = addAdditionalPropertiesHints(result);
  result = moveConstraintsToDescription(result);
  result = mergeAllOf(result);
  result = flattenAnyOfOneOf(result);
  result = flattenTypeArrays(result);
  result = removeUnsupportedKeywords(result);
  result = cleanupRequiredFields(result);
  result = addEmptySchemaPlaceholder(result);
  return result;
}
var DEFAULT_THINKING_BUDGET = 16e3;
function isThinkingCapableModel2(modelName) {
  const lowerModel = modelName.toLowerCase();
  return lowerModel.includes("thinking") || lowerModel.includes("gemini-3") || lowerModel.includes("opus");
}
function extractThinkingConfig(requestPayload, rawGenerationConfig, extraBody) {
  const thinkingConfig = rawGenerationConfig?.thinkingConfig ?? extraBody?.thinkingConfig ?? requestPayload.thinkingConfig;
  if (thinkingConfig && typeof thinkingConfig === "object") {
    const config = thinkingConfig;
    return {
      includeThoughts: Boolean(config.includeThoughts),
      thinkingBudget: typeof config.thinkingBudget === "number" ? config.thinkingBudget : DEFAULT_THINKING_BUDGET
    };
  }
  const anthropicThinking = extraBody?.thinking ?? requestPayload.thinking;
  if (anthropicThinking && typeof anthropicThinking === "object") {
    const thinking = anthropicThinking;
    if (thinking.type === "enabled" || thinking.budgetTokens) {
      return {
        includeThoughts: true,
        thinkingBudget: typeof thinking.budgetTokens === "number" ? thinking.budgetTokens : DEFAULT_THINKING_BUDGET
      };
    }
  }
  return void 0;
}
function extractVariantThinkingConfig(providerOptions, generationConfig) {
  const result = {};
  const google = providerOptions?.google;
  if (google) {
    if (typeof google.thinkingLevel === "string") {
      result.thinkingLevel = google.thinkingLevel;
      result.includeThoughts = typeof google.includeThoughts === "boolean" ? google.includeThoughts : void 0;
    } else if (google.thinkingConfig && typeof google.thinkingConfig === "object") {
      const tc = google.thinkingConfig;
      if (typeof tc.thinkingBudget === "number") {
        result.thinkingBudget = tc.thinkingBudget;
      }
    }
    if (google.googleSearch && typeof google.googleSearch === "object") {
      const search = google.googleSearch;
      result.googleSearch = {
        mode: search.mode === "auto" || search.mode === "off" ? search.mode : void 0,
        threshold: typeof search.threshold === "number" ? search.threshold : void 0
      };
    }
  }
  if (result.thinkingBudget === void 0 && !result.thinkingLevel && generationConfig) {
    if (generationConfig.thinkingConfig && typeof generationConfig.thinkingConfig === "object") {
      const tc = generationConfig.thinkingConfig;
      if (typeof tc.thinkingLevel === "string") {
        result.thinkingLevel = tc.thinkingLevel;
        result.includeThoughts = typeof tc.includeThoughts === "boolean" ? tc.includeThoughts : void 0;
      } else if (typeof tc.thinkingBudget === "number") {
        result.thinkingBudget = tc.thinkingBudget;
      }
    }
  }
  return Object.keys(result).length > 0 ? result : void 0;
}
function resolveThinkingConfig(userConfig, isThinkingModel, _isClaudeModel, _hasAssistantHistory) {
  if (isThinkingModel && !userConfig) {
    return { includeThoughts: true, thinkingBudget: DEFAULT_THINKING_BUDGET };
  }
  return userConfig;
}
function isThinkingPart(part) {
  return part.type === "thinking" || part.type === "redacted_thinking" || part.type === "reasoning" || part.thinking !== void 0 || part.thought === true;
}
function hasSignatureField(part) {
  return part.signature !== void 0 || part.thoughtSignature !== void 0;
}
function isToolBlock(part) {
  return part.type === "tool_use" || part.type === "tool_result" || part.tool_use_id !== void 0 || part.tool_call_id !== void 0 || part.tool_result !== void 0 || part.tool_use !== void 0 || part.toolUse !== void 0 || part.functionCall !== void 0 || part.functionResponse !== void 0;
}
function stripAllThinkingBlocks(contentArray) {
  return contentArray.map((item) => {
    if (!item || typeof item !== "object") return item;
    if (isToolBlock(item)) return item;
    if (isThinkingPart(item) || hasSignatureField(item)) {
      const cc = item.cache_control;
      const sentinel = { text: "." };
      if (cc) sentinel.cache_control = cc;
      return sentinel;
    }
    return item;
  });
}
function removeTrailingThinkingBlocks(contentArray, sessionId, getCachedSignatureFn) {
  const result = [...contentArray];
  for (let i = result.length - 1; i >= 0; i--) {
    if (!isThinkingPart(result[i])) break;
    const part = result[i];
    const isValid = sessionId && getCachedSignatureFn ? isOurCachedSignature(
      part,
      sessionId,
      getCachedSignatureFn
    ) : hasValidSignature(part);
    if (isValid) break;
    const cc = part?.cache_control;
    const sentinel = { text: "." };
    if (cc) sentinel.cache_control = cc;
    result[i] = sentinel;
  }
  return result;
}
function hasValidSignature(part) {
  const signature = part.thought === true ? part.thoughtSignature : part.signature;
  return typeof signature === "string" && signature.length >= 50;
}
function getSignature(part) {
  const signature = part.thought === true ? part.thoughtSignature : part.signature;
  return typeof signature === "string" ? signature : void 0;
}
function isOurCachedSignature(part, sessionId, getCachedSignatureFn) {
  if (!sessionId || !getCachedSignatureFn) {
    return false;
  }
  const text = getThinkingText(part);
  if (!text) {
    return false;
  }
  const partSignature = getSignature(part);
  if (!partSignature) {
    return false;
  }
  const cachedSignature = getCachedSignatureFn(sessionId, text);
  return cachedSignature === partSignature;
}
function getThinkingText(part) {
  if (typeof part.text === "string") return part.text;
  if (typeof part.thinking === "string") return part.thinking;
  if (part.text && typeof part.text === "object") {
    const maybeText = part.text.text;
    if (typeof maybeText === "string") return maybeText;
  }
  if (part.thinking && typeof part.thinking === "object") {
    const maybeText = part.thinking.text ?? part.thinking.thinking;
    if (typeof maybeText === "string") return maybeText;
  }
  return "";
}
function stripCacheControlRecursively(obj) {
  if (obj === null || obj === void 0) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj))
    return obj.map((item) => stripCacheControlRecursively(item));
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "cache_control" || key === "providerOptions") continue;
    result[key] = stripCacheControlRecursively(value);
  }
  return result;
}
function sanitizeThinkingPart(part) {
  if (part.thought === true) {
    let textContent = part.text;
    if (typeof textContent === "object" && textContent !== null) {
      const maybeText = textContent.text;
      textContent = typeof maybeText === "string" ? maybeText : void 0;
    }
    const hasContent = typeof textContent === "string" && textContent.trim().length > 0;
    if (!hasContent && !part.thoughtSignature) {
      return null;
    }
    const sanitized = { thought: true };
    sanitized.text = typeof textContent === "string" ? textContent : "";
    if (part.thoughtSignature !== void 0)
      sanitized.thoughtSignature = part.thoughtSignature;
    if (part.cache_control !== void 0)
      sanitized.cache_control = part.cache_control;
    return sanitized;
  }
  if (part.type === "thinking" || part.type === "redacted_thinking" || part.thinking !== void 0) {
    let thinkingContent = part.thinking ?? part.text;
    if (thinkingContent !== void 0 && typeof thinkingContent === "object" && thinkingContent !== null) {
      const maybeText = thinkingContent.text ?? thinkingContent.thinking;
      thinkingContent = typeof maybeText === "string" ? maybeText : void 0;
    }
    const hasContent = typeof thinkingContent === "string" && thinkingContent.trim().length > 0;
    if (!hasContent && !part.signature) {
      return null;
    }
    const sanitized = {
      type: part.type === "redacted_thinking" ? "redacted_thinking" : "thinking"
    };
    sanitized.thinking = typeof thinkingContent === "string" ? thinkingContent : "";
    if (part.signature !== void 0) sanitized.signature = part.signature;
    if (part.cache_control !== void 0)
      sanitized.cache_control = part.cache_control;
    return sanitized;
  }
  if (part.type === "reasoning") {
    let textContent = part.text;
    if (typeof textContent === "object" && textContent !== null) {
      const maybeText = textContent.text;
      textContent = typeof maybeText === "string" ? maybeText : void 0;
    }
    const hasContent = typeof textContent === "string" && textContent.trim().length > 0;
    if (!hasContent && !part.signature) {
      return null;
    }
    const sanitized = { type: "reasoning" };
    sanitized.text = typeof textContent === "string" ? textContent : "";
    if (part.signature !== void 0) sanitized.signature = part.signature;
    if (part.cache_control !== void 0)
      sanitized.cache_control = part.cache_control;
    return sanitized;
  }
  return stripCacheControlRecursively(part);
}
function findLastAssistantIndex(contents, roleValue) {
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i];
    if (content && typeof content === "object" && content.role === roleValue) {
      return i;
    }
  }
  return -1;
}
function filterContentArray(contentArray, sessionId, getCachedSignatureFn, isClaudeModel2, isLastAssistantMessage = false) {
  if (isClaudeModel2 && !getKeepThinking()) {
    return stripAllThinkingBlocks(contentArray);
  }
  const filtered = [];
  for (const item of contentArray) {
    if (!item || typeof item !== "object") {
      filtered.push(item);
      continue;
    }
    if (isToolBlock(item)) {
      if (!isClaudeModel2) {
        filtered.push(item);
        continue;
      }
      const sanitizedToolBlock = { ...item };
      delete sanitizedToolBlock.signature;
      delete sanitizedToolBlock.thoughtSignature;
      delete sanitizedToolBlock.thought_signature;
      delete sanitizedToolBlock.thought;
      filtered.push(sanitizedToolBlock);
      continue;
    }
    const isThinking = isThinkingPart(item);
    const hasSignature = hasSignatureField(item);
    if (!isThinking && !hasSignature) {
      filtered.push(item);
      continue;
    }
    if (isClaudeModel2 && (isThinking || hasSignature)) {
      const sentinel2 = { text: "." };
      if (item.cache_control) sentinel2.cache_control = item.cache_control;
      filtered.push(sentinel2);
      continue;
    }
    if (isLastAssistantMessage && (isThinking || hasSignature)) {
      if (isOurCachedSignature(item, sessionId, getCachedSignatureFn)) {
        const sanitized = sanitizeThinkingPart(item);
        if (sanitized) {
          filtered.push(sanitized);
        } else {
          const sentinel3 = { text: "." };
          if (item.cache_control) sentinel3.cache_control = item.cache_control;
          filtered.push(sentinel3);
        }
        continue;
      }
      const existingSignature = item.signature || item.thoughtSignature;
      const signatureInfo = existingSignature ? `foreign signature (${String(existingSignature).length} chars)` : "no signature";
      log13.debug(
        `Injecting plain text sentinel for last-message thinking block with ${signatureInfo}`
      );
      const sentinel2 = { text: "." };
      if (item.cache_control) sentinel2.cache_control = item.cache_control;
      filtered.push(sentinel2);
      continue;
    }
    if (isOurCachedSignature(item, sessionId, getCachedSignatureFn)) {
      const sanitized = sanitizeThinkingPart(item);
      if (sanitized) {
        filtered.push(sanitized);
      } else {
        const sentinel2 = { text: "." };
        if (item.cache_control) sentinel2.cache_control = item.cache_control;
        filtered.push(sentinel2);
      }
      continue;
    }
    if (sessionId && getCachedSignatureFn) {
      const text = getThinkingText(item);
      if (text) {
        const cachedSignature = getCachedSignatureFn(sessionId, text);
        if (cachedSignature && cachedSignature.length >= 50) {
          const restoredPart = { ...item };
          if (item.thought === true) {
            ;
            restoredPart.thoughtSignature = cachedSignature;
          } else {
            ;
            restoredPart.signature = cachedSignature;
          }
          const sanitized = sanitizeThinkingPart(
            restoredPart
          );
          if (sanitized) {
            filtered.push(sanitized);
          } else {
            const sentinel2 = { text: "." };
            if (item.cache_control) sentinel2.cache_control = item.cache_control;
            filtered.push(sentinel2);
          }
          continue;
        }
      }
    }
    const sentinel = { text: "." };
    if (item.cache_control) sentinel.cache_control = item.cache_control;
    filtered.push(sentinel);
  }
  return filtered;
}
function filterUnsignedThinkingBlocks(contents, sessionId, getCachedSignatureFn, isClaudeModel2) {
  const lastAssistantIdx = findLastAssistantIndex(contents, "model");
  return contents.map((content, idx) => {
    if (!content || typeof content !== "object") {
      return content;
    }
    const isLastAssistant = idx === lastAssistantIdx;
    if (Array.isArray(content.parts)) {
      const filteredParts = filterContentArray(
        content.parts,
        sessionId,
        getCachedSignatureFn,
        isClaudeModel2,
        isLastAssistant
      );
      const trimmedParts = content.role === "model" && !isClaudeModel2 ? removeTrailingThinkingBlocks(
        filteredParts,
        sessionId,
        getCachedSignatureFn
      ) : filteredParts;
      return { ...content, parts: trimmedParts };
    }
    if (Array.isArray(content.content)) {
      const isAssistantRole = content.role === "assistant";
      const isLastAssistantContent = idx === lastAssistantIdx || isAssistantRole && idx === findLastAssistantIndex(contents, "assistant");
      const filteredContent = filterContentArray(
        content.content,
        sessionId,
        getCachedSignatureFn,
        isClaudeModel2,
        isLastAssistantContent
      );
      const trimmedContent = isAssistantRole && !isClaudeModel2 ? removeTrailingThinkingBlocks(
        filteredContent,
        sessionId,
        getCachedSignatureFn
      ) : filteredContent;
      return { ...content, content: trimmedContent };
    }
    return content;
  });
}
function filterMessagesThinkingBlocks(messages, sessionId, getCachedSignatureFn, isClaudeModel2) {
  const lastAssistantIdx = findLastAssistantIndex(messages, "assistant");
  return messages.map((message, idx) => {
    if (!message || typeof message !== "object") {
      return message;
    }
    if (Array.isArray(message.content)) {
      const isAssistantRole = message.role === "assistant";
      const isLastAssistant = isAssistantRole && idx === lastAssistantIdx;
      const filteredContent = filterContentArray(
        message.content,
        sessionId,
        getCachedSignatureFn,
        isClaudeModel2,
        isLastAssistant
      );
      const trimmedContent = isAssistantRole && !isClaudeModel2 ? removeTrailingThinkingBlocks(
        filteredContent,
        sessionId,
        getCachedSignatureFn
      ) : filteredContent;
      return { ...message, content: trimmedContent };
    }
    return message;
  });
}
function deepFilterThinkingBlocks(payload, sessionId, getCachedSignatureFn, isClaudeModel2) {
  const visited = /* @__PURE__ */ new WeakSet();
  const walk = (value) => {
    if (!value || typeof value !== "object") {
      return;
    }
    if (visited.has(value)) {
      return;
    }
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => {
        walk(item);
      });
      return;
    }
    const obj = value;
    if (Array.isArray(obj.contents)) {
      obj.contents = filterUnsignedThinkingBlocks(
        obj.contents,
        sessionId,
        getCachedSignatureFn,
        isClaudeModel2
      );
    }
    if (Array.isArray(obj.messages)) {
      obj.messages = filterMessagesThinkingBlocks(
        obj.messages,
        sessionId,
        getCachedSignatureFn,
        isClaudeModel2
      );
    }
    Object.keys(obj).forEach((key) => {
      walk(obj[key]);
    });
  };
  walk(payload);
  return payload;
}
function transformGeminiCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return candidate;
  }
  const content = candidate.content;
  if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
    return candidate;
  }
  const thinkingTexts = [];
  const transformedParts = content.parts.map((part) => {
    if (!part || typeof part !== "object") {
      return part;
    }
    if (part.thought === true) {
      const thinkingText = typeof part.text === "string" ? part.text : "";
      thinkingTexts.push(thinkingText);
      const transformed = {
        type: "reasoning",
        text: thinkingText,
        thought: true
      };
      const sig = part.thoughtSignature || part.signature;
      if (typeof sig === "string" && sig) transformed.thoughtSignature = sig;
      if (part.cache_control) transformed.cache_control = part.cache_control;
      return transformed;
    }
    if (part.type === "thinking") {
      const thinkingText = typeof part.thinking === "string" ? part.thinking : typeof part.text === "string" ? part.text : "";
      thinkingTexts.push(thinkingText);
      const transformed = {
        type: "reasoning",
        text: thinkingText,
        thought: true
      };
      const sig = part.thoughtSignature || part.signature;
      if (typeof sig === "string" && sig) transformed.thoughtSignature = sig;
      if (part.cache_control) transformed.cache_control = part.cache_control;
      return transformed;
    }
    if (part.functionCall) {
      const parsedArgs = part.functionCall.args ? recursivelyParseJsonStrings(part.functionCall.args) : {};
      return {
        ...part,
        functionCall: {
          ...part.functionCall,
          args: parsedArgs
        }
      };
    }
    if (part.inlineData) {
      const result = processImageData({
        mimeType: part.inlineData.mimeType,
        data: part.inlineData.data
      });
      if (result) {
        return { text: result };
      }
    }
    return part;
  });
  return {
    ...candidate,
    content: { ...content, parts: transformedParts },
    ...thinkingTexts.length > 0 ? { reasoning_content: thinkingTexts.join("\n\n") } : {}
  };
}
function transformThinkingParts(response) {
  if (!response || typeof response !== "object") {
    return response;
  }
  const resp = response;
  const result = { ...resp };
  const reasoningTexts = [];
  if (Array.isArray(resp.content)) {
    const transformedContent = [];
    for (const block of resp.content) {
      if (block && typeof block === "object" && block.type === "thinking") {
        const thinkingText = typeof block.thinking === "string" ? block.thinking : typeof block.text === "string" ? block.text : "";
        reasoningTexts.push(thinkingText);
        const transformed = {
          type: "reasoning",
          text: thinkingText,
          thought: true
        };
        const sig = block.thoughtSignature || block.signature;
        if (typeof sig === "string" && sig) transformed.thoughtSignature = sig;
        if (block.cache_control)
          transformed.cache_control = block.cache_control;
        transformedContent.push(transformed);
      } else {
        transformedContent.push(block);
      }
    }
    result.content = transformedContent;
  }
  if (Array.isArray(resp.candidates)) {
    result.candidates = resp.candidates.map(transformGeminiCandidate);
  }
  if (reasoningTexts.length > 0 && !result.reasoning_content) {
    result.reasoning_content = reasoningTexts.join("\n\n");
  }
  return result;
}
function normalizeThinkingConfig(config) {
  if (!config || typeof config !== "object") {
    return void 0;
  }
  const record = config;
  const budgetRaw = record.thinkingBudget ?? record.thinking_budget;
  const includeRaw = record.includeThoughts ?? record.include_thoughts;
  const thinkingBudget = typeof budgetRaw === "number" && Number.isFinite(budgetRaw) ? budgetRaw : void 0;
  const includeThoughts = typeof includeRaw === "boolean" ? includeRaw : void 0;
  const enableThinking = thinkingBudget !== void 0 && thinkingBudget > 0;
  const finalInclude = enableThinking ? includeThoughts ?? false : false;
  if (!enableThinking && finalInclude === false && thinkingBudget === void 0 && includeThoughts === void 0) {
    return void 0;
  }
  const normalized = {};
  if (thinkingBudget !== void 0) {
    normalized.thinkingBudget = thinkingBudget;
  }
  if (finalInclude !== void 0) {
    normalized.includeThoughts = finalInclude;
  }
  return normalized;
}
function parseAntigravityApiBody(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      const firstObject = parsed.find(
        (item) => typeof item === "object" && item !== null
      );
      if (firstObject && typeof firstObject === "object") {
        return firstObject;
      }
      return null;
    }
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
function extractUsageMetadata(body) {
  const usage = body.response && typeof body.response === "object" ? body.response.usageMetadata : void 0;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const asRecord = usage;
  const toNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
  return {
    totalTokenCount: toNumber(asRecord.totalTokenCount),
    promptTokenCount: toNumber(asRecord.promptTokenCount),
    candidatesTokenCount: toNumber(asRecord.candidatesTokenCount),
    cachedContentTokenCount: toNumber(asRecord.cachedContentTokenCount),
    thoughtsTokenCount: toNumber(asRecord.thoughtsTokenCount)
  };
}
function extractUsageFromSsePayload(payload) {
  const lines = payload.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const jsonText = line.slice(5).trim();
    if (!jsonText) {
      continue;
    }
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === "object") {
        const usage = extractUsageMetadata({
          response: parsed.response
        });
        if (usage) {
          return usage;
        }
      }
    } catch {
    }
  }
  return null;
}
function rewriteAntigravityPreviewAccessError(body, status, requestedModel) {
  if (!needsPreviewAccessOverride(status, body, requestedModel)) {
    return null;
  }
  const error = body.error ?? {};
  const trimmedMessage = typeof error.message === "string" ? error.message.trim() : "";
  const messagePrefix = trimmedMessage.length > 0 ? trimmedMessage : "Antigravity preview features are not enabled for this account.";
  const enhancedMessage = `${messagePrefix} Request preview access at ${ANTIGRAVITY_PREVIEW_LINK} before using this model.`;
  return {
    ...body,
    error: {
      ...error,
      message: enhancedMessage
    }
  };
}
function needsPreviewAccessOverride(status, body, requestedModel) {
  if (status !== 404) {
    return false;
  }
  if (isAntigravityModel(requestedModel)) {
    return true;
  }
  const errorMessage = typeof body.error?.message === "string" ? body.error.message : "";
  return isAntigravityModel(errorMessage);
}
function isAntigravityModel(target) {
  if (!target) {
    return false;
  }
  return /antigravity/i.test(target) || /opus/i.test(target) || /claude/i.test(target);
}
function isEmptyResponseBody(text) {
  if (!text?.trim()) {
    return true;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed.candidates !== void 0) {
      if (!Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
        return true;
      }
      const firstCandidate = parsed.candidates[0];
      if (!firstCandidate) {
        return true;
      }
      const content = firstCandidate.content;
      if (!content || typeof content !== "object") {
        return true;
      }
      const parts = content.parts;
      if (!Array.isArray(parts) || parts.length === 0) {
        return true;
      }
      const hasContent = parts.some((part) => {
        if (!part || typeof part !== "object") return false;
        if (typeof part.text === "string" && part.text.length > 0) return true;
        if (part.functionCall) return true;
        if (part.thought === true && typeof part.text === "string") return true;
        return false;
      });
      if (!hasContent) {
        return true;
      }
    }
    if (parsed.choices !== void 0) {
      if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) {
        return true;
      }
      const firstChoice = parsed.choices[0];
      if (!firstChoice) {
        return true;
      }
      const message = firstChoice.message || firstChoice.delta;
      if (!message) {
        return true;
      }
      if (!message.content && !message.tool_calls && !message.reasoning_content) {
        return true;
      }
    }
    if (parsed.response !== void 0) {
      const response = parsed.response;
      if (!response || typeof response !== "object") {
        return true;
      }
      return isEmptyResponseBody(JSON.stringify(response));
    }
    return false;
  } catch {
    return true;
  }
}
var SKIP_PARSE_KEYS = /* @__PURE__ */ new Set([
  "oldString",
  "newString",
  "content",
  "filePath",
  "path",
  "text",
  "code",
  "source",
  "data",
  "body",
  "message",
  "prompt",
  "input",
  "output",
  "result",
  "value",
  "query",
  "pattern",
  "replacement",
  "template",
  "script",
  "command",
  "snippet"
]);
function recursivelyParseJsonStrings(obj, skipParseKeys = SKIP_PARSE_KEYS, currentKey) {
  if (obj === null || obj === void 0) {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => recursivelyParseJsonStrings(item, skipParseKeys));
  }
  if (typeof obj === "object") {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = recursivelyParseJsonStrings(value, skipParseKeys, key);
    }
    return result;
  }
  if (typeof obj !== "string") {
    return obj;
  }
  if (currentKey && skipParseKeys.has(currentKey)) {
    return obj;
  }
  const stripped = obj.trim();
  const hasControlCharEscapes = obj.includes("\\n") || obj.includes("\\t");
  const hasIntentionalEscapes = obj.includes('\\"') || obj.includes("\\\\");
  if (hasControlCharEscapes && !hasIntentionalEscapes) {
    try {
      return JSON.parse(`"${obj}"`);
    } catch {
    }
  }
  if (stripped && (stripped[0] === "{" || stripped[0] === "[")) {
    if (stripped.startsWith("{") && stripped.endsWith("}") || stripped.startsWith("[") && stripped.endsWith("]")) {
      try {
        const parsed = JSON.parse(obj);
        return recursivelyParseJsonStrings(parsed);
      } catch {
      }
    }
    if (stripped.startsWith("[") && !stripped.endsWith("]")) {
      try {
        const lastBracket = stripped.lastIndexOf("]");
        if (lastBracket > 0) {
          const cleaned = stripped.slice(0, lastBracket + 1);
          const parsed = JSON.parse(cleaned);
          log13.debug("Auto-corrected malformed JSON array", {
            truncatedChars: stripped.length - cleaned.length
          });
          return recursivelyParseJsonStrings(parsed);
        }
      } catch {
      }
    }
    if (stripped.startsWith("{") && !stripped.endsWith("}")) {
      try {
        const lastBrace = stripped.lastIndexOf("}");
        if (lastBrace > 0) {
          const cleaned = stripped.slice(0, lastBrace + 1);
          const parsed = JSON.parse(cleaned);
          log13.debug("Auto-corrected malformed JSON object", {
            truncatedChars: stripped.length - cleaned.length
          });
          return recursivelyParseJsonStrings(parsed);
        }
      } catch {
      }
    }
  }
  return obj;
}
function fixToolResponseGrouping(contents) {
  if (!Array.isArray(contents) || contents.length === 0) {
    return contents;
  }
  const newContents = [];
  const pendingGroups = [];
  const collectedResponses = /* @__PURE__ */ new Map();
  for (const content of contents) {
    const role = content.role;
    const parts = content.parts || [];
    const responseParts = parts.filter((p) => p?.functionResponse);
    if (responseParts.length > 0) {
      for (const resp of responseParts) {
        const respId = resp.functionResponse?.id || "";
        if (respId && !collectedResponses.has(respId)) {
          collectedResponses.set(respId, resp);
        }
      }
      for (let i = pendingGroups.length - 1; i >= 0; i--) {
        const group = pendingGroups[i];
        if (group.ids.every((id) => collectedResponses.has(id))) {
          const groupResponses = group.ids.map((id) => {
            const resp = collectedResponses.get(id);
            collectedResponses.delete(id);
            return resp;
          });
          newContents.push({ parts: groupResponses, role: "user" });
          pendingGroups.splice(i, 1);
          break;
        }
      }
      continue;
    }
    if (role === "model") {
      const funcCalls = parts.filter((p) => p?.functionCall);
      newContents.push(content);
      if (funcCalls.length > 0) {
        const callIds = funcCalls.map((fc) => fc.functionCall?.id || "").filter(Boolean);
        const funcNames = funcCalls.map(
          (fc) => fc.functionCall?.name || ""
        );
        if (callIds.length > 0) {
          pendingGroups.push({
            ids: callIds,
            funcNames,
            insertAfterIdx: newContents.length - 1
          });
        }
      }
    } else {
      newContents.push(content);
    }
  }
  pendingGroups.sort((a, b) => b.insertAfterIdx - a.insertAfterIdx);
  for (const group of pendingGroups) {
    const groupResponses = [];
    for (let i = 0; i < group.ids.length; i++) {
      const expectedId = group.ids[i];
      const expectedName = group.funcNames[i] || "";
      if (collectedResponses.has(expectedId)) {
        groupResponses.push(collectedResponses.get(expectedId));
        collectedResponses.delete(expectedId);
      } else if (collectedResponses.size > 0) {
        let matchedId = null;
        for (const [orphanId, orphanResp] of collectedResponses) {
          const orphanName = orphanResp.functionResponse?.name || "";
          if (orphanName === expectedName) {
            matchedId = orphanId;
            break;
          }
        }
        if (!matchedId) {
          for (const [orphanId, orphanResp] of collectedResponses) {
            if (orphanResp.functionResponse?.name === "unknown_function") {
              matchedId = orphanId;
              break;
            }
          }
        }
        if (!matchedId) {
          matchedId = collectedResponses.keys().next().value ?? null;
        }
        if (matchedId) {
          const orphanResp = collectedResponses.get(matchedId);
          collectedResponses.delete(matchedId);
          orphanResp.functionResponse.id = expectedId;
          if (orphanResp.functionResponse.name === "unknown_function" && expectedName) {
            orphanResp.functionResponse.name = expectedName;
          }
          log13.debug("Auto-repaired tool ID mismatch", {
            mappedFrom: matchedId,
            mappedTo: expectedId,
            functionName: expectedName
          });
          groupResponses.push(orphanResp);
        }
      } else {
        const placeholder = {
          functionResponse: {
            name: expectedName || "unknown_function",
            response: {
              result: {
                error: "Tool response was lost during context processing. This is a recovered placeholder.",
                recovered: true
              }
            },
            id: expectedId
          }
        };
        log13.debug("Created placeholder response for missing tool", {
          id: expectedId,
          name: expectedName
        });
        groupResponses.push(placeholder);
      }
    }
    if (groupResponses.length > 0) {
      newContents.splice(group.insertAfterIdx + 1, 0, {
        parts: groupResponses,
        role: "user"
      });
    }
  }
  return newContents;
}
function findOrphanedToolUseIds(messages) {
  const toolUseIds = /* @__PURE__ */ new Set();
  const toolResultIds = /* @__PURE__ */ new Set();
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id) {
          toolUseIds.add(block.id);
        }
        if (block.type === "tool_result" && block.tool_use_id) {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }
  }
  return new Set([...toolUseIds].filter((id) => !toolResultIds.has(id)));
}
function fixClaudeToolPairing(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }
  const toolUseMap = /* @__PURE__ */ new Map();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id) {
          toolUseMap.set(block.id, {
            name: block.name || `tool-${toolUseMap.size}`,
            msgIndex: i
          });
        }
      }
    }
  }
  const toolResultIds = /* @__PURE__ */ new Set();
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }
  }
  const orphans = [];
  for (const [id, info] of toolUseMap) {
    if (!toolResultIds.has(id)) {
      orphans.push({ id, ...info });
    }
  }
  if (orphans.length === 0) {
    return messages;
  }
  const orphansByMsgIndex = /* @__PURE__ */ new Map();
  for (const orphan of orphans) {
    const existing = orphansByMsgIndex.get(orphan.msgIndex) || [];
    existing.push(orphan);
    orphansByMsgIndex.set(orphan.msgIndex, existing);
  }
  const result = [];
  for (let i = 0; i < messages.length; i++) {
    result.push(messages[i]);
    const orphansForMsg = orphansByMsgIndex.get(i);
    if (orphansForMsg && orphansForMsg.length > 0) {
      const nextMsg = messages[i + 1];
      if (nextMsg?.role === "user" && Array.isArray(nextMsg.content)) {
        const placeholders = orphansForMsg.map((o) => ({
          type: "tool_result",
          tool_use_id: o.id,
          content: `[Tool "${o.name}" execution was cancelled or failed]`,
          is_error: true
        }));
        nextMsg.content = [...placeholders, ...nextMsg.content];
      } else {
        result.push({
          role: "user",
          content: orphansForMsg.map((o) => ({
            type: "tool_result",
            tool_use_id: o.id,
            content: `[Tool "${o.name}" execution was cancelled or failed]`,
            is_error: true
          }))
        });
      }
    }
  }
  return result;
}
function removeOrphanedToolUse(messages, orphanIds) {
  return messages.map((msg) => {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.filter(
          (block) => block.type !== "tool_use" || !orphanIds.has(block.id)
        )
      };
    }
    return msg;
  }).filter(
    (msg) => (
      // Remove empty assistant messages
      !(msg.role === "assistant" && Array.isArray(msg.content) && msg.content.length === 0)
    )
  );
}
function validateAndFixClaudeToolPairing(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }
  const fixed = fixClaudeToolPairing(messages);
  const orphanIds = findOrphanedToolUseIds(fixed);
  if (orphanIds.size === 0) {
    return fixed;
  }
  console.warn(
    "[antigravity] fixClaudeToolPairing left orphans, applying nuclear option",
    {
      orphanIds: [...orphanIds]
    }
  );
  return removeOrphanedToolUse(fixed, orphanIds);
}
function formatTypeHint(propData, depth = 0) {
  const type = propData.type ?? "unknown";
  if (propData.enum && Array.isArray(propData.enum)) {
    const enumVals = propData.enum;
    if (enumVals.length <= 5) {
      return `string ENUM[${enumVals.map((v) => JSON.stringify(v)).join(", ")}]`;
    }
    return `string ENUM[${enumVals.length} options]`;
  }
  if (propData.const !== void 0) {
    return `string CONST=${JSON.stringify(propData.const)}`;
  }
  if (type === "array") {
    const items = propData.items;
    if (items && typeof items === "object") {
      const itemType = items.type ?? "unknown";
      if (itemType === "object") {
        const nestedProps = items.properties;
        const nestedReq = items.required ?? [];
        if (nestedProps && depth < 1) {
          const nestedList = Object.entries(nestedProps).map(([n, d]) => {
            const t = d.type ?? "unknown";
            const req = nestedReq.includes(n) ? " REQUIRED" : "";
            return `${n}: ${t}${req}`;
          });
          return `ARRAY_OF_OBJECTS[${nestedList.join(", ")}]`;
        }
        return "ARRAY_OF_OBJECTS";
      }
      return `ARRAY_OF_${itemType.toUpperCase()}`;
    }
    return "ARRAY";
  }
  if (type === "object") {
    const nestedProps = propData.properties;
    const nestedReq = propData.required ?? [];
    if (nestedProps && depth < 1) {
      const nestedList = Object.entries(nestedProps).map(([n, d]) => {
        const t = d.type ?? "unknown";
        const req = nestedReq.includes(n) ? " REQUIRED" : "";
        return `${n}: ${t}${req}`;
      });
      return `object{${nestedList.join(", ")}}`;
    }
  }
  return type;
}
function injectParameterSignatures(tools, promptTemplate = "\n\n\u26A0\uFE0F STRICT PARAMETERS: {params}.") {
  if (!tools || !Array.isArray(tools)) return tools;
  return tools.map((tool2) => {
    const declarations = tool2.functionDeclarations;
    if (!Array.isArray(declarations)) return tool2;
    const newDeclarations = declarations.map((decl) => {
      if (decl.description?.includes("STRICT PARAMETERS:")) {
        return decl;
      }
      const schema = decl.parameters || decl.parametersJsonSchema;
      if (!schema) return decl;
      const required = schema.required ?? [];
      const properties = schema.properties ?? {};
      if (Object.keys(properties).length === 0) return decl;
      const paramList = Object.entries(properties).map(
        ([propName, propData]) => {
          const typeHint = formatTypeHint(propData);
          const isRequired = required.includes(propName);
          return `${propName} (${typeHint}${isRequired ? ", REQUIRED" : ""})`;
        }
      );
      const sigStr = promptTemplate.replace("{params}", paramList.join(", "));
      return {
        ...decl,
        description: (decl.description || "") + sigStr
      };
    });
    return { ...tool2, functionDeclarations: newDeclarations };
  });
}
function injectToolHardeningInstruction(payload, instructionText) {
  if (!instructionText) return;
  const existing = payload.systemInstruction;
  if (existing && typeof existing === "object" && "parts" in existing) {
    const parts = existing.parts;
    if (Array.isArray(parts) && parts.some((p) => p.text?.includes("CRITICAL TOOL USAGE INSTRUCTIONS"))) {
      return;
    }
  }
  const instructionPart = { text: instructionText };
  if (payload.systemInstruction) {
    if (existing && typeof existing === "object" && "parts" in existing) {
      const parts = existing.parts;
      if (Array.isArray(parts)) {
        parts.push(instructionPart);
      }
    } else if (typeof existing === "string") {
      payload.systemInstruction = {
        role: "user",
        parts: [{ text: existing }, instructionPart]
      };
    } else {
      payload.systemInstruction = {
        role: "user",
        parts: [instructionPart]
      };
    }
  } else {
    payload.systemInstruction = {
      role: "user",
      parts: [instructionPart]
    };
  }
}
function assignToolIdsToContents(contents) {
  if (!Array.isArray(contents)) {
    return { contents, pendingCallIdsByName: /* @__PURE__ */ new Map(), toolCallCounter: 0 };
  }
  let toolCallCounter = 0;
  const pendingCallIdsByName = /* @__PURE__ */ new Map();
  const newContents = contents.map((content) => {
    if (!content || !Array.isArray(content.parts)) {
      return content;
    }
    const newParts = content.parts.map((part) => {
      if (part && typeof part === "object" && part.functionCall) {
        const call = { ...part.functionCall };
        if (!call.id) {
          call.id = `tool-call-${++toolCallCounter}`;
        }
        const nameKey = typeof call.name === "string" ? call.name : `tool-${toolCallCounter}`;
        const queue2 = pendingCallIdsByName.get(nameKey) || [];
        queue2.push(call.id);
        pendingCallIdsByName.set(nameKey, queue2);
        return { ...part, functionCall: call };
      }
      return part;
    });
    return { ...content, parts: newParts };
  });
  return { contents: newContents, pendingCallIdsByName, toolCallCounter };
}
function matchResponseIdsToContents(contents, pendingCallIdsByName) {
  if (!Array.isArray(contents)) {
    return contents;
  }
  return contents.map((content) => {
    if (!content || !Array.isArray(content.parts)) {
      return content;
    }
    const newParts = content.parts.map((part) => {
      if (part && typeof part === "object" && part.functionResponse) {
        const resp = { ...part.functionResponse };
        if (!resp.id && typeof resp.name === "string") {
          const queue2 = pendingCallIdsByName.get(resp.name);
          if (queue2 && queue2.length > 0) {
            resp.id = queue2.shift();
            pendingCallIdsByName.set(resp.name, queue2);
          }
        }
        return { ...part, functionResponse: resp };
      }
      return part;
    });
    return { ...content, parts: newParts };
  });
}
function applyToolPairingFixes(payload, isClaude) {
  let contentsFixed = false;
  let messagesFixed = false;
  if (!isClaude) {
    return { contentsFixed, messagesFixed };
  }
  if (Array.isArray(payload.contents)) {
    const { contents: contentsWithIds, pendingCallIdsByName } = assignToolIdsToContents(payload.contents);
    const contentsWithMatchedIds = matchResponseIdsToContents(
      contentsWithIds,
      pendingCallIdsByName
    );
    payload.contents = fixToolResponseGrouping(contentsWithMatchedIds);
    contentsFixed = true;
    log13.debug("Applied tool pairing fixes to contents[]", {
      originalLength: payload.contents.length
    });
  }
  if (Array.isArray(payload.messages)) {
    payload.messages = validateAndFixClaudeToolPairing(
      payload.messages
    );
    messagesFixed = true;
    log13.debug("Applied tool pairing fixes to messages[]", {
      originalLength: payload.messages.length
    });
  }
  return { contentsFixed, messagesFixed };
}
function createSyntheticTextResponse(text, extraHeaders = {}) {
  const outputTokens = Math.max(1, Math.ceil(text.length / 4));
  const event = {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text }]
        },
        finishReason: "STOP"
      }
    ],
    usageMetadata: {
      promptTokenCount: 0,
      candidatesTokenCount: outputTokens,
      totalTokenCount: outputTokens
    }
  };
  return new Response(`data: ${JSON.stringify(event)}

`, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Antigravity-Synthetic": "true",
      ...extraHeaders
    }
  });
}
function createSyntheticErrorResponse(errorMessage, _requestedModel = "unknown") {
  return createSyntheticTextResponse(errorMessage, {
    "X-Antigravity-Error-Type": "synthetic_error"
  });
}

// src/plugin/stores/signature-store.ts
function createSignatureStore() {
  const store = /* @__PURE__ */ new Map();
  return {
    get: (key) => store.get(key),
    set: (key, value) => {
      store.set(key, value);
    },
    has: (key) => store.has(key),
    delete: (key) => {
      store.delete(key);
    }
  };
}
var defaultSignatureStore = createSignatureStore();

// src/plugin/thinking-recovery.ts
function isThinkingPart2(part) {
  if (!part || typeof part !== "object") return false;
  return part.thought === true || part.type === "thinking" || part.type === "redacted_thinking";
}
function isFunctionResponsePart(part) {
  return part && typeof part === "object" && "functionResponse" in part;
}
function isFunctionCallPart(part) {
  return part && typeof part === "object" && "functionCall" in part;
}
function isToolResultMessage(msg) {
  if (msg?.role !== "user") return false;
  const parts = msg.parts || [];
  return parts.some(isFunctionResponsePart);
}
function messageHasThinking(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (Array.isArray(msg.parts)) {
    return msg.parts.some(isThinkingPart2);
  }
  if (Array.isArray(msg.content)) {
    return msg.content.some(
      (block) => block?.type === "thinking" || block?.type === "redacted_thinking"
    );
  }
  return false;
}
function messageHasToolCalls(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (Array.isArray(msg.parts)) {
    return msg.parts.some(isFunctionCallPart);
  }
  if (Array.isArray(msg.content)) {
    return msg.content.some((block) => block?.type === "tool_use");
  }
  return false;
}
function analyzeConversationState(contents) {
  const state = {
    inToolLoop: false,
    turnStartIdx: -1,
    turnHasThinking: false,
    lastModelIdx: -1,
    lastModelHasThinking: false,
    lastModelHasToolCalls: false
  };
  if (!Array.isArray(contents) || contents.length === 0) {
    return state;
  }
  let lastRealUserIdx = -1;
  for (let i = 0; i < contents.length; i++) {
    const msg = contents[i];
    if (msg?.role === "user" && !isToolResultMessage(msg)) {
      lastRealUserIdx = i;
    }
  }
  for (let i = 0; i < contents.length; i++) {
    const msg = contents[i];
    const role = msg?.role;
    if (role === "model" || role === "assistant") {
      const hasThinking = messageHasThinking(msg);
      const hasToolCalls = messageHasToolCalls(msg);
      if (i > lastRealUserIdx && state.turnStartIdx === -1) {
        state.turnStartIdx = i;
        state.turnHasThinking = hasThinking;
      }
      state.lastModelIdx = i;
      state.lastModelHasToolCalls = hasToolCalls;
      state.lastModelHasThinking = hasThinking;
    }
  }
  if (contents.length > 0) {
    const lastMsg = contents[contents.length - 1];
    if (lastMsg?.role === "user" && isToolResultMessage(lastMsg)) {
      state.inToolLoop = true;
    }
  }
  return state;
}
function stripAllThinkingBlocks2(contents) {
  return contents.map((content) => {
    if (!content || typeof content !== "object") return content;
    if (Array.isArray(content.parts)) {
      const mappedParts = content.parts.map((part) => {
        if (!isThinkingPart2(part)) return part;
        const sentinel = { text: "." };
        if (part.cache_control !== void 0)
          sentinel.cache_control = part.cache_control;
        return sentinel;
      });
      return { ...content, parts: mappedParts };
    }
    if (Array.isArray(content.content)) {
      const mappedContent = content.content.map((block) => {
        if (block?.type !== "thinking" && block?.type !== "redacted_thinking")
          return block;
        const sentinel = { text: "." };
        if (block?.cache_control !== void 0)
          sentinel.cache_control = block.cache_control;
        return sentinel;
      });
      return { ...content, content: mappedContent };
    }
    return content;
  });
}
function countTrailingToolResults(contents) {
  let count = 0;
  for (let i = contents.length - 1; i >= 0; i--) {
    const msg = contents[i];
    if (msg?.role === "user") {
      const parts = msg.parts || [];
      const functionResponses = parts.filter(isFunctionResponsePart);
      if (functionResponses.length > 0) {
        count += functionResponses.length;
      } else {
        break;
      }
    } else if (msg?.role === "model" || msg?.role === "assistant") {
      break;
    }
  }
  return count;
}
function closeToolLoopForThinking(contents) {
  const strippedContents = stripAllThinkingBlocks2(contents);
  const toolResultCount = countTrailingToolResults(strippedContents);
  let syntheticModelContent;
  if (toolResultCount === 0) {
    syntheticModelContent = "[Processing previous context.]";
  } else if (toolResultCount === 1) {
    syntheticModelContent = "[Tool execution completed.]";
  } else {
    syntheticModelContent = `[${toolResultCount} tool executions completed.]`;
  }
  const syntheticModel = {
    role: "model",
    parts: [{ text: syntheticModelContent }]
  };
  const syntheticUser = {
    role: "user",
    parts: [{ text: "[Continue]" }]
  };
  return [...strippedContents, syntheticModel, syntheticUser];
}
function needsThinkingRecovery(state) {
  return state.inToolLoop && !state.turnHasThinking;
}

// src/plugin/request.ts
var log14 = createLogger2("request");
var PLUGIN_SESSION_ID = `-${crypto2.randomUUID()}`;
var DEFAULT_AGY_REQUEST_SESSION = createAgyRequestSessionContext("");
var sessionDisplayedThinkingHashes = /* @__PURE__ */ new Set();
var MIN_SIGNATURE_LENGTH = 50;
var AGY_CLAUDE_THINKING_BUDGET = 1024;
var ANTIGRAVITY_ENVELOPE_FIELD_ORDER = [
  "project",
  "requestId",
  "request",
  "model",
  "userAgent",
  "requestType"
];
var OPENCODE_TITLE_PROMPT_PREFIX = "Generate a title for this conversation:";
function getOpenCodeTitleSourceText(payload) {
  if (!Array.isArray(payload.contents)) {
    return void 0;
  }
  const texts = payload.contents.flatMap((content) => {
    if (!content || typeof content !== "object") {
      return [];
    }
    const parts = content.parts;
    if (!Array.isArray(parts)) {
      return [];
    }
    return parts.flatMap(
      (part) => part && typeof part === "object" && typeof part.text === "string" ? [part.text] : []
    );
  });
  const promptIndex = texts.findIndex(
    (text) => text.startsWith(OPENCODE_TITLE_PROMPT_PREFIX)
  );
  return promptIndex >= 0 ? texts.slice(promptIndex + 1).find((text) => text.trim().length > 0) : void 0;
}
function isOpenCodeTitleGenerationRequest(payload) {
  return getOpenCodeTitleSourceText(payload) !== void 0;
}
function formatLocalImageTitle(sourceText) {
  const normalized = sourceText.trim().replace(/^(["“])(.*)(["”])$/s, "$2").replace(/\s+/g, " ");
  const characters = Array.from(normalized);
  if (characters.length <= 50) {
    return normalized || "Image generation";
  }
  return `${characters.slice(0, 47).join("").trimEnd()}...`;
}
function getImageModelLocalTitle(input2, init) {
  const url = fetchInputToUrl(input2);
  if (!/\/models\/[^/:]*(?:image|imagen)[^/:]*:streamGenerateContent/i.test(url)) {
    return void 0;
  }
  const body = init?.body;
  const bodyText = typeof body === "string" ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : "";
  if (!bodyText) {
    return void 0;
  }
  try {
    const sourceText = getOpenCodeTitleSourceText(
      JSON.parse(bodyText)
    );
    return sourceText === void 0 ? void 0 : formatLocalImageTitle(sourceText);
  } catch {
    return void 0;
  }
}
function getAgyMaxOutputTokens(model) {
  const lower = model.toLowerCase();
  if (lower === "gemini-3.5-flash-low" || lower === "gemini-3.5-flash-extra-low" || lower === "gemini-3-flash-agent" || lower === "gemini-3.6-flash-low" || lower === "gemini-3.6-flash-medium" || lower === "gemini-3.6-flash-high" || lower === "gemini-3.7-flash-low" || lower === "gemini-3.7-flash-medium" || lower === "gemini-3.7-flash-high" || lower === "gemini-3.8-flash-low" || lower === "gemini-3.8-flash-medium" || lower === "gemini-3.8-flash-high") {
    return 65536;
  }
  if (lower === "gemini-3.1-pro-low" || lower === "gemini-pro-agent") {
    return 65535;
  }
  if (lower === "claude-sonnet-4-6" || lower === "claude-opus-4-6-thinking") {
    return 64e3;
  }
  if (lower === "gpt-oss-120b-medium") {
    return 32768;
  }
  return void 0;
}
function applyAgyGenerationDefaults(model, generationConfig, headerStyle) {
  if (headerStyle !== "antigravity") {
    return;
  }
  const maxOutputTokens = getAgyMaxOutputTokens(model);
  if (maxOutputTokens !== void 0) {
    generationConfig.maxOutputTokens = maxOutputTokens;
    delete generationConfig.max_output_tokens;
  }
}
function orderAntigravityEnvelope(body) {
  const ordered = {};
  const remaining = new Set(Object.keys(body));
  for (const key of ANTIGRAVITY_ENVELOPE_FIELD_ORDER) {
    if (key in body) {
      ordered[key] = body[key];
      remaining.delete(key);
    }
  }
  for (const key of remaining) {
    ordered[key] = body[key];
  }
  return ordered;
}
function buildSignatureSessionKey(sessionId, model, conversationKey, projectKey) {
  const modelKey = typeof model === "string" && model.trim() ? model.toLowerCase() : "unknown";
  const projectPart = typeof projectKey === "string" && projectKey.trim() ? projectKey.trim() : "default";
  const conversationPart = typeof conversationKey === "string" && conversationKey.trim() ? conversationKey.trim() : "default";
  return `${sessionId}:${modelKey}:${projectPart}:${conversationPart}`;
}
var JSON_SCHEMA_TYPES = /* @__PURE__ */ new Set([
  "boolean",
  "string",
  "number",
  "integer",
  "array",
  "object"
]);
function thinkingSafeReplacer(key, value) {
  if (key === "thinking" && typeof value === "object" && value !== null) {
    const rec = value;
    if (typeof rec.type === "string" && JSON_SCHEMA_TYPES.has(rec.type.toLowerCase())) {
      return value;
    }
    return "";
  }
  return value;
}
function ensureThinkingFields(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) ensureThinkingFields(item);
    return;
  }
  const rec = obj;
  if (rec.type === "thinking" && typeof rec.thinking !== "string") {
    rec.thinking = "";
  }
  if (rec.thought === true && typeof rec.text !== "string") {
    rec.text = "";
  }
  for (const val of Object.values(rec)) {
    ensureThinkingFields(val);
  }
}
function safeStringify(obj) {
  ensureThinkingFields(obj);
  return JSON.stringify(obj, thinkingSafeReplacer);
}
function shouldCacheThinkingSignatures(model) {
  if (typeof model !== "string") return false;
  const lower = model.toLowerCase();
  return lower.includes("claude") || lower.includes("gemini-3");
}
function hashConversationSeed(seed) {
  return crypto2.createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16);
}
function extractTextFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const anyBlock = block;
    if (typeof anyBlock.text === "string") {
      return anyBlock.text;
    }
    if (anyBlock.text && typeof anyBlock.text === "object" && typeof anyBlock.text.text === "string") {
      return anyBlock.text.text;
    }
  }
  return "";
}
function extractConversationSeedFromMessages(messages) {
  const system = messages.find((message) => message?.role === "system");
  const users = messages.filter((message) => message?.role === "user");
  const firstUser = users[0];
  const lastUser = users.length > 0 ? users[users.length - 1] : void 0;
  const systemText = system ? extractTextFromContent(system.content) : "";
  const userText = firstUser ? extractTextFromContent(firstUser.content) : "";
  const fallbackUserText = !userText && lastUser ? extractTextFromContent(lastUser.content) : "";
  return [systemText, userText || fallbackUserText].filter(Boolean).join("|");
}
function extractConversationSeedFromContents(contents) {
  const users = contents.filter((content) => content?.role === "user");
  const firstUser = users[0];
  const lastUser = users.length > 0 ? users[users.length - 1] : void 0;
  const primaryUser = firstUser && Array.isArray(firstUser.parts) ? extractTextFromContent(firstUser.parts) : "";
  if (primaryUser) {
    return primaryUser;
  }
  if (lastUser && Array.isArray(lastUser.parts)) {
    return extractTextFromContent(lastUser.parts);
  }
  return "";
}
function resolveConversationKey(requestPayload) {
  const anyPayload = requestPayload;
  const candidates = [
    anyPayload.conversationId,
    anyPayload.conversation_id,
    anyPayload.thread_id,
    anyPayload.threadId,
    anyPayload.chat_id,
    anyPayload.chatId,
    anyPayload.sessionId,
    anyPayload.session_id,
    anyPayload.metadata?.conversation_id,
    anyPayload.metadata?.conversationId,
    anyPayload.metadata?.thread_id,
    anyPayload.metadata?.threadId
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  const systemSeed = extractTextFromContent(
    anyPayload.systemInstruction?.parts ?? anyPayload.systemInstruction ?? anyPayload.system ?? anyPayload.system_instruction
  );
  const messageSeed = Array.isArray(anyPayload.messages) ? extractConversationSeedFromMessages(anyPayload.messages) : Array.isArray(anyPayload.contents) ? extractConversationSeedFromContents(anyPayload.contents) : "";
  const seed = [systemSeed, messageSeed].filter(Boolean).join("|");
  if (!seed) {
    return void 0;
  }
  return `seed-${hashConversationSeed(seed)}`;
}
function resolveConversationKeyFromRequests(requestObjects) {
  for (const req of requestObjects) {
    const key = resolveConversationKey(req);
    if (key) {
      return key;
    }
  }
  return void 0;
}
function resolveProjectKey(candidate, fallback) {
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return void 0;
}
function formatDebugLinesForThinking(lines) {
  const cleaned = lines.map((line) => line.trim()).filter((line) => line.length > 0).slice(-50);
  const prelude = `[ThinkingResolution] source=debug_tui lines=${cleaned.length}`;
  return `${DEBUG_MESSAGE_PREFIX}
- ${prelude}
${cleaned.map((line) => `- ${line}`).join("\n")}`;
}
function injectDebugThinking(response, debugText) {
  if (!response || typeof response !== "object") {
    return response;
  }
  const resp = response;
  if (Array.isArray(resp.candidates) && resp.candidates.length > 0) {
    const candidates = resp.candidates.slice();
    const first = candidates[0];
    if (first && typeof first === "object" && first.content && typeof first.content === "object" && Array.isArray(first.content.parts)) {
      const parts = [{ thought: true, text: debugText }, ...first.content.parts];
      candidates[0] = { ...first, content: { ...first.content, parts } };
      return { ...resp, candidates };
    }
    return resp;
  }
  if (Array.isArray(resp.content)) {
    const content = [{ type: "thinking", thinking: debugText }, ...resp.content];
    return { ...resp, content };
  }
  if (!resp.reasoning_content) {
    return { ...resp, reasoning_content: debugText };
  }
  return resp;
}
var SYNTHETIC_THINKING_PLACEHOLDER = "[Thinking preserved]\n";
function stripInjectedDebugFromParts(parts) {
  if (!Array.isArray(parts)) {
    return parts;
  }
  return parts.map((part) => {
    if (!part || typeof part !== "object") {
      return part;
    }
    const record = part;
    const text = typeof record.text === "string" ? record.text : typeof record.thinking === "string" ? record.thinking : void 0;
    if (text && (text.startsWith(DEBUG_MESSAGE_PREFIX) || text.startsWith(SYNTHETIC_THINKING_PLACEHOLDER.trim()))) {
      const sentinel = { text: "." };
      if (record.cache_control !== void 0)
        sentinel.cache_control = record.cache_control;
      return sentinel;
    }
    return part;
  });
}
function stripInjectedDebugFromRequestPayload(payload) {
  const anyPayload = payload;
  if (Array.isArray(anyPayload.contents)) {
    anyPayload.contents = anyPayload.contents.map((content) => {
      if (!content || typeof content !== "object") {
        return content;
      }
      if (Array.isArray(content.parts)) {
        return { ...content, parts: stripInjectedDebugFromParts(content.parts) };
      }
      if (Array.isArray(content.content)) {
        return {
          ...content,
          content: stripInjectedDebugFromParts(content.content)
        };
      }
      return content;
    });
  }
  if (Array.isArray(anyPayload.messages)) {
    anyPayload.messages = anyPayload.messages.map((message) => {
      if (!message || typeof message !== "object") {
        return message;
      }
      if (Array.isArray(message.content)) {
        return {
          ...message,
          content: stripInjectedDebugFromParts(message.content)
        };
      }
      return message;
    });
  }
}
function isValidRequestPart(part) {
  if (!part || typeof part !== "object") {
    return false;
  }
  const record = part;
  return Object.hasOwn(record, "text") || Object.hasOwn(record, "functionCall") || Object.hasOwn(record, "functionResponse") || Object.hasOwn(record, "inlineData") || Object.hasOwn(record, "fileData") || Object.hasOwn(record, "executableCode") || Object.hasOwn(record, "codeExecutionResult") || Object.hasOwn(record, "thought");
}
function stripCacheControlFromParts(parts) {
  if (!Array.isArray(parts)) {
    return;
  }
  for (const part of parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      continue;
    }
    const record = part;
    delete record.cache_control;
    delete record.cacheControl;
  }
}
function stripUnsupportedAntigravityFields(payload) {
  delete payload.providerOptions;
  delete payload.cached_content;
  delete payload.cachedContent;
  delete payload.cache_control;
  delete payload.cacheControl;
  const extraBody = payload.extra_body;
  if (extraBody && typeof extraBody === "object" && !Array.isArray(extraBody)) {
    const extraBodyRecord = extraBody;
    delete extraBodyRecord.cached_content;
    delete extraBodyRecord.cachedContent;
    delete extraBodyRecord.cache_control;
    delete extraBodyRecord.cacheControl;
    if (Object.keys(extraBodyRecord).length === 0) {
      delete payload.extra_body;
    }
  }
  const stripContentParts = (items) => {
    if (!Array.isArray(items)) {
      return;
    }
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const record = item;
      stripCacheControlFromParts(record.parts);
      stripCacheControlFromParts(record.content);
    }
  };
  stripContentParts(payload.contents);
  stripContentParts(payload.messages);
  for (const instructionKey of [
    "systemInstruction",
    "system_instruction"
  ]) {
    const instruction = payload[instructionKey];
    if (instruction && typeof instruction === "object" && !Array.isArray(instruction)) {
      stripCacheControlFromParts(instruction.parts);
    }
  }
}
function configureAntigravityToolCalling(payload) {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
    delete payload.toolConfig;
    return;
  }
  const toolConfig = payload.toolConfig && typeof payload.toolConfig === "object" && !Array.isArray(payload.toolConfig) ? payload.toolConfig : {};
  const functionCallingConfig = toolConfig.functionCallingConfig && typeof toolConfig.functionCallingConfig === "object" && !Array.isArray(toolConfig.functionCallingConfig) ? toolConfig.functionCallingConfig : {};
  functionCallingConfig.mode = "VALIDATED";
  toolConfig.functionCallingConfig = functionCallingConfig;
  payload.toolConfig = toolConfig;
}
function sanitizeRequestPayloadForAntigravity(payload) {
  const anyPayload = payload;
  if (Array.isArray(anyPayload.contents)) {
    anyPayload.contents = anyPayload.contents.map((content) => {
      if (!content || typeof content !== "object") {
        return { role: "user", parts: [{ text: "." }] };
      }
      const contentRecord = content;
      const rawParts = Array.isArray(contentRecord.parts) ? contentRecord.parts : [];
      let foundFirstFunctionCall = false;
      const sanitizedParts = rawParts.map((part) => {
        if (!isValidRequestPart(part)) {
          return { text: "." };
        }
        return part;
      }).map((part) => {
        if (part && typeof part === "object" && part.functionCall) {
          let sig = part.thoughtSignature || part.thought_signature;
          if (!foundFirstFunctionCall) {
            foundFirstFunctionCall = true;
            if (!sig || sig.length < MIN_SIGNATURE_LENGTH) {
              sig = SKIP_THOUGHT_SIGNATURE;
            }
          } else {
            sig = void 0;
          }
          if (sig) {
            return { ...part, thought_signature: sig, thoughtSignature: sig };
          }
          const newPart = { ...part };
          delete newPart.thoughtSignature;
          delete newPart.thought_signature;
          return newPart;
        }
        return part;
      });
      if (sanitizedParts.length === 0) {
        return { ...contentRecord, parts: [{ text: "." }] };
      }
      return {
        ...contentRecord,
        parts: sanitizedParts
      };
    });
  }
  if (Array.isArray(anyPayload.messages)) {
    anyPayload.messages = anyPayload.messages.map((message) => {
      if (!message || typeof message !== "object") {
        return { role: "user", content: [{ type: "text", text: "." }] };
      }
      const messageRecord = message;
      const rawContent = Array.isArray(messageRecord.content) ? messageRecord.content : messageRecord.content;
      if (!Array.isArray(rawContent)) {
        return messageRecord;
      }
      const sanitizedContent = rawContent.map((block) => {
        if (!block || typeof block !== "object") {
          return { type: "text", text: "." };
        }
        const blockRecord = block;
        if (blockRecord.type === "text") {
          const text = blockRecord.text;
          if (typeof text !== "string" || text.trim().length === 0) {
            const sentinel = {
              type: "text",
              text: "."
            };
            if (blockRecord.cache_control !== void 0)
              sentinel.cache_control = blockRecord.cache_control;
            return sentinel;
          }
        }
        return block;
      });
      if (sanitizedContent.length === 0) {
        return { ...messageRecord, content: [{ type: "text", text: "." }] };
      }
      return {
        ...messageRecord,
        content: sanitizedContent
      };
    });
  }
  const systemInstruction = anyPayload.systemInstruction;
  if (systemInstruction && typeof systemInstruction === "object" && !Array.isArray(systemInstruction)) {
    const sys = systemInstruction;
    if (Array.isArray(sys.parts)) {
      const sanitizedSystemParts = sys.parts.map((part) => {
        if (isValidRequestPart(part)) return part;
        const record = part;
        const sentinel = { text: "." };
        if (record?.cache_control !== void 0)
          sentinel.cache_control = record.cache_control;
        return sentinel;
      });
      const hasRealContent = sanitizedSystemParts.some(
        (p) => p && typeof p === "object" && typeof p.text === "string" && p.text !== "."
      );
      if (hasRealContent) {
        sys.parts = sanitizedSystemParts;
      } else {
        delete anyPayload.systemInstruction;
      }
    }
  }
}
function isGeminiToolUsePart(part) {
  return !!(part && typeof part === "object" && (part.functionCall || part.tool_use || part.toolUse));
}
function isGeminiThinkingPart(part) {
  return !!(part && typeof part === "object" && (part.thought === true || part.type === "thinking" || part.type === "reasoning"));
}
var SENTINEL_SIGNATURE = "skip_thought_signature_validator";
function getThinkingPartText(part) {
  if (!part || typeof part !== "object") {
    return "";
  }
  if (typeof part.text === "string") {
    return part.text;
  }
  if (typeof part.thinking === "string") {
    return part.thinking;
  }
  return "";
}
function hasCachedMatchingSignature(part, sessionId) {
  if (!part || typeof part !== "object") {
    return false;
  }
  const text = getThinkingPartText(part);
  if (!text) {
    return false;
  }
  const expectedSignature = getCachedSignature(sessionId, text);
  if (!expectedSignature) {
    return false;
  }
  if (part.thought === true) {
    return part.thoughtSignature === expectedSignature;
  }
  return part.signature === expectedSignature;
}
function ensureThoughtSignature(part, sessionId) {
  if (!part || typeof part !== "object") {
    return part;
  }
  if (!sessionId) {
    return part;
  }
  const text = getThinkingPartText(part);
  if (!text) {
    return part;
  }
  if (part.thought === true) {
    return { ...part, thoughtSignature: SENTINEL_SIGNATURE };
  }
  if (part.type === "thinking" || part.type === "reasoning" || part.type === "redacted_thinking") {
    return { ...part, signature: SENTINEL_SIGNATURE };
  }
  return part;
}
function hasSignedThinkingPart(part, sessionId) {
  if (!part || typeof part !== "object") {
    return false;
  }
  if (part.thought === true) {
    if (part.thoughtSignature === SENTINEL_SIGNATURE || part.thoughtSignature === SKIP_THOUGHT_SIGNATURE) {
      return true;
    }
    if (typeof part.thoughtSignature !== "string" || part.thoughtSignature.length < MIN_SIGNATURE_LENGTH) {
      return false;
    }
    if (!sessionId) {
      return true;
    }
    return hasCachedMatchingSignature(part, sessionId);
  }
  if (part.type === "thinking" || part.type === "reasoning" || part.type === "redacted_thinking") {
    if (part.signature === SENTINEL_SIGNATURE || part.signature === SKIP_THOUGHT_SIGNATURE) {
      return true;
    }
    if (typeof part.signature !== "string" || part.signature.length < MIN_SIGNATURE_LENGTH) {
      return false;
    }
    if (!sessionId) {
      return true;
    }
    return hasCachedMatchingSignature(part, sessionId);
  }
  return false;
}
function ensureThinkingBeforeToolUseInContents(contents, signatureSessionKey) {
  return contents.map((content) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return content;
    }
    const role = content.role;
    if (role !== "model" && role !== "assistant") {
      return content;
    }
    const parts = content.parts;
    const hasToolUse = parts.some(isGeminiToolUsePart);
    if (!hasToolUse) {
      return content;
    }
    const hasSignedThinking = parts.some(
      (p) => isGeminiThinkingPart(p) && hasSignedThinkingPart(
        ensureThoughtSignature(p, signatureSessionKey),
        signatureSessionKey
      )
    );
    if (hasSignedThinking) {
      return {
        ...content,
        parts: parts.map(
          (p) => isGeminiThinkingPart(p) ? ensureThoughtSignature(p, signatureSessionKey) : p
        )
      };
    }
    const lastThinking = defaultSignatureStore.get(signatureSessionKey);
    log14.debug("Replacing thinking with sentinels in-place", {
      signatureSessionKey,
      hasCachedSig: !!lastThinking
    });
    const newParts = parts.map((p) => {
      if (!isGeminiThinkingPart(p)) return p;
      const cc = p.cache_control;
      const sentinel = { text: "." };
      if (cc) sentinel.cache_control = cc;
      return sentinel;
    });
    return { ...content, parts: newParts };
  });
}
function ensureMessageThinkingSignature(block, sessionId) {
  if (!block || typeof block !== "object") {
    return block;
  }
  if (block.type !== "thinking" && block.type !== "redacted_thinking") {
    return block;
  }
  const text = getThinkingPartText(block);
  if (!text) {
    return block;
  }
  if (!sessionId) {
    return block;
  }
  return { ...block, signature: SKIP_THOUGHT_SIGNATURE };
}
function hasToolUseInContents(contents) {
  return contents.some((content) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return false;
    }
    return content.parts.some(isGeminiToolUsePart);
  });
}
function hasSignedThinkingInContents(contents, sessionId) {
  return contents.some((content) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return false;
    }
    return content.parts.some(
      (part) => hasSignedThinkingPart(part, sessionId)
    );
  });
}
function hasToolUseInMessages(messages) {
  return messages.some((message) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return false;
    }
    return message.content.some(
      (block) => block && typeof block === "object" && (block.type === "tool_use" || block.type === "tool_result")
    );
  });
}
function hasSignedThinkingInMessages(messages, sessionId) {
  return messages.some((message) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return false;
    }
    return message.content.some(
      (block) => hasSignedThinkingPart(block, sessionId)
    );
  });
}
function ensureThinkingBeforeToolUseInMessages(messages, signatureSessionKey) {
  return messages.map((message) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return message;
    }
    if (message.role !== "assistant") {
      return message;
    }
    const blocks = message.content;
    const hasToolUse = blocks.some(
      (b) => b && typeof b === "object" && (b.type === "tool_use" || b.type === "tool_result")
    );
    if (!hasToolUse) {
      return message;
    }
    const isThinkingBlock = (b) => b && typeof b === "object" && (b.type === "thinking" || b.type === "redacted_thinking");
    const hasSignedThinking = blocks.some(
      (b) => isThinkingBlock(b) && hasSignedThinkingPart(
        ensureMessageThinkingSignature(b, signatureSessionKey),
        signatureSessionKey
      )
    );
    if (hasSignedThinking) {
      return {
        ...message,
        content: blocks.map(
          (b) => isThinkingBlock(b) ? ensureMessageThinkingSignature(b, signatureSessionKey) : b
        )
      };
    }
    const lastThinking = defaultSignatureStore.get(signatureSessionKey);
    log14.debug("Replacing thinking with sentinels in-place (Messages format)", {
      signatureSessionKey,
      hasCachedSig: !!lastThinking
    });
    return {
      ...message,
      content: blocks.map((b) => {
        if (!isThinkingBlock(b)) return b;
        const _thinkingText = lastThinking ? lastThinking.text : typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
        const cc = b.cache_control;
        const sentinel = { text: "." };
        if (cc) sentinel.cache_control = cc;
        return sentinel;
      })
    };
  });
}
var _lastCacheStats = null;
function getLastCacheStats() {
  return _lastCacheStats;
}
var STREAM_ACTION = "streamGenerateContent";
function fetchInputToUrl(input2) {
  if (typeof input2 === "string") return input2;
  if (input2 instanceof URL) return input2.href;
  const url = input2.url;
  return typeof url === "string" ? url : String(input2);
}
function isGenerativeLanguageRequest(input2) {
  return fetchInputToUrl(input2).includes("generativelanguage.googleapis.com");
}
function prepareAntigravityRequest(input2, init, accessToken, projectId, endpointOverride, headerStyle = "antigravity", forceThinkingRecovery = false, options) {
  const baseInit = { ...init };
  const headers = new Headers(init?.headers ?? {});
  let resolvedProjectId = projectId?.trim() || "";
  let toolDebugMissing = 0;
  const toolDebugSummaries = [];
  let toolDebugPayload;
  let sessionId;
  let needsSignedThinkingWarmup = false;
  let thinkingRecoveryMessage;
  if (!isGenerativeLanguageRequest(input2)) {
    return {
      request: input2,
      init: { ...baseInit, headers },
      streaming: false,
      headerStyle
    };
  }
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  headers.delete("x-session-affinity");
  headers.delete("x-session-id");
  headers.delete("x-parent-session-id");
  headers.delete("x-goog-user-project");
  const urlString = fetchInputToUrl(input2);
  const match = urlString.match(/\/models\/([^:]+):(\w+)/);
  if (!match) {
    return {
      request: input2,
      init: { ...baseInit, headers },
      streaming: false,
      headerStyle
    };
  }
  const [, rawModel = "", rawAction = ""] = match;
  const requestedModel = rawModel;
  const resolved = resolveModelForHeaderStyle(rawModel, headerStyle);
  let effectiveModel = resolved.actualModel;
  const streaming = rawAction === STREAM_ACTION;
  const defaultEndpoint = headerStyle === "gemini-cli" ? GEMINI_CLI_ENDPOINT : ANTIGRAVITY_ENDPOINT;
  const baseEndpoint = endpointOverride ?? defaultEndpoint;
  const transformedUrl = `${baseEndpoint}/v1internal:${rawAction}${streaming ? "?alt=sse" : ""}`;
  const isClaude = isClaudeModel(resolved.actualModel);
  const isClaudeThinking = isClaudeThinkingModel(resolved.actualModel);
  const keepThinkingEnabled = getKeepThinking();
  let tierThinkingBudget = resolved.thinkingBudget;
  let tierThinkingLevel = resolved.thinkingLevel;
  let signatureSessionKey = buildSignatureSessionKey(
    PLUGIN_SESSION_ID,
    effectiveModel,
    void 0,
    resolveProjectKey(projectId)
  );
  let body = baseInit.body;
  if (typeof baseInit.body === "string" && baseInit.body) {
    try {
      const parsedBody = JSON.parse(baseInit.body);
      const isWrapped = typeof parsedBody.project === "string" && "request" in parsedBody;
      if (isWrapped) {
        const wrappedBody = {
          ...parsedBody,
          model: effectiveModel
        };
        if (headerStyle === "antigravity") {
          if (typeof wrappedBody.userAgent !== "string" || !wrappedBody.userAgent) {
            wrappedBody.userAgent = "antigravity";
          }
          if (typeof wrappedBody.requestType !== "string" || !wrappedBody.requestType) {
            wrappedBody.requestType = "agent";
          }
        }
        const requestRoot = wrappedBody.request;
        const requestObjects = [];
        if (requestRoot && typeof requestRoot === "object") {
          requestObjects.push(requestRoot);
          const nested = requestRoot.request;
          if (nested && typeof nested === "object") {
            requestObjects.push(nested);
          }
        }
        const conversationKey = resolveConversationKeyFromRequests(requestObjects);
        const modelForCacheKey = effectiveModel.replace(
          /-(minimal|low|medium|high)$/i,
          ""
        );
        signatureSessionKey = buildSignatureSessionKey(
          PLUGIN_SESSION_ID,
          modelForCacheKey,
          conversationKey,
          resolveProjectKey(parsedBody.project)
        );
        if (requestObjects.length > 0) {
          sessionId = signatureSessionKey;
        }
        for (const req of requestObjects) {
          stripInjectedDebugFromRequestPayload(req);
          if (isClaude) {
            sanitizeCrossModelPayloadInPlace(req, {
              targetModel: effectiveModel
            });
            deepFilterThinkingBlocks(
              req,
              signatureSessionKey,
              getCachedSignature,
              true
            );
            if (isClaudeThinking && keepThinkingEnabled && Array.isArray(req.contents)) {
              ;
              req.contents = ensureThinkingBeforeToolUseInContents(
                req.contents,
                signatureSessionKey
              );
            }
            if (isClaudeThinking && keepThinkingEnabled && Array.isArray(req.messages)) {
              ;
              req.messages = ensureThinkingBeforeToolUseInMessages(
                req.messages,
                signatureSessionKey
              );
            }
            applyToolPairingFixes(req, true);
          }
          if (headerStyle === "antigravity") {
            sanitizeRequestPayloadForAntigravity(req);
            stripUnsupportedAntigravityFields(req);
            configureAntigravityToolCalling(req);
          }
        }
        if (headerStyle === "antigravity" || isClaude) {
          for (const req of requestObjects) {
            if (Array.isArray(req.contents)) {
              const contents = req.contents;
              const lastContent = contents[contents.length - 1];
              if (lastContent?.role === "model" || lastContent?.role === "assistant") {
                contents.push({ role: "user", parts: [{ text: "[Continue]" }] });
              }
            }
            if (Array.isArray(req.messages)) {
              const messages = req.messages;
              const lastMessage = messages[messages.length - 1];
              if (lastMessage?.role === "model" || lastMessage?.role === "assistant") {
                messages.push({ role: "user", parts: [{ text: "[Continue]" }] });
              }
            }
          }
        }
        if (isClaudeThinking && keepThinkingEnabled && sessionId) {
          const hasToolUse = requestObjects.some(
            (req) => Array.isArray(req.contents) && hasToolUseInContents(req.contents) || Array.isArray(req.messages) && hasToolUseInMessages(req.messages)
          );
          const hasSignedThinking = requestObjects.some(
            (req) => Array.isArray(req.contents) && hasSignedThinkingInContents(
              req.contents,
              signatureSessionKey
            ) || Array.isArray(req.messages) && hasSignedThinkingInMessages(
              req.messages,
              signatureSessionKey
            )
          );
          const hasCachedThinking = defaultSignatureStore.has(signatureSessionKey);
          needsSignedThinkingWarmup = hasToolUse && !hasSignedThinking && !hasCachedThinking;
        }
        const wireRequest = requestObjects.at(-1);
        if (wireRequest) {
          if (headerStyle === "antigravity") {
            const metadata = buildAgyAgentRequestMetadata(
              options?.agySession ?? DEFAULT_AGY_REQUEST_SESSION,
              wireRequest,
              effectiveModel,
              options?.agyRequestTimestamp
            );
            wrappedBody.requestId = metadata.requestId;
            wireRequest.sessionId = metadata.sessionId;
            wireRequest.labels = metadata.labels;
            orderAgyRequestPayloadInPlace(wireRequest);
          } else {
            wireRequest.sessionId = signatureSessionKey;
          }
        }
        body = safeStringify(
          headerStyle === "antigravity" ? orderAntigravityEnvelope(wrappedBody) : wrappedBody
        );
      } else {
        const requestPayload = { ...parsedBody };
        if (headerStyle === "antigravity" && isImageGenerationModel(effectiveModel) && isOpenCodeTitleGenerationRequest(requestPayload)) {
          effectiveModel = "gemini-3.5-flash-low";
          tierThinkingBudget = 4e3;
          tierThinkingLevel = void 0;
        }
        const rawGenerationConfig = requestPayload.generationConfig;
        const extraBody = requestPayload.extra_body;
        const variantConfig = extractVariantThinkingConfig(
          requestPayload.providerOptions,
          rawGenerationConfig
        );
        const isGemini3 = effectiveModel.toLowerCase().includes("gemini-3");
        log14.debug(
          `[ThinkingResolution] rawModel=${rawModel} resolvedModel=${effectiveModel} resolvedTier=${tierThinkingLevel ?? "none"} variantLevel=${variantConfig?.thinkingLevel ?? "none"} variantBudget=${variantConfig?.thinkingBudget ?? "none"} providerOptions.google=${JSON.stringify(requestPayload.providerOptions?.google ?? null)} generationConfig.thinkingConfig=${JSON.stringify(rawGenerationConfig?.thinkingConfig ?? null)}`
        );
        delete requestPayload.providerOptions;
        if (variantConfig?.thinkingLevel && isGemini3) {
          const variantModelBase = rawModel.replace(/-preview-customtools$/i, "").replace(/-preview$/i, "").replace(/-(minimal|low|medium|high)$/i, "");
          const variantResolved = resolveModelForHeaderStyle(
            `${variantModelBase}-${variantConfig.thinkingLevel}`,
            headerStyle
          );
          effectiveModel = variantResolved.actualModel;
          tierThinkingBudget = variantResolved.thinkingBudget;
          tierThinkingLevel = variantResolved.thinkingLevel ?? (variantResolved.thinkingBudget ? void 0 : variantConfig.thinkingLevel);
        } else if (variantConfig?.thinkingBudget) {
          if (isGemini3) {
            log14.warn(
              "[Deprecated] Using thinkingBudget for Gemini 3 model. Use thinkingLevel instead."
            );
            tierThinkingLevel = variantConfig.thinkingBudget <= 8192 ? "low" : variantConfig.thinkingBudget <= 16384 ? "medium" : "high";
            tierThinkingBudget = void 0;
          } else {
            tierThinkingBudget = variantConfig.thinkingBudget;
            tierThinkingLevel = void 0;
          }
        }
        const isImageModel = isImageGenerationModel(effectiveModel);
        const userThinkingConfig = isImageModel ? void 0 : extractThinkingConfig(
          requestPayload,
          rawGenerationConfig,
          extraBody
        );
        const hasAssistantHistory = Array.isArray(requestPayload.contents) && requestPayload.contents.some(
          (c) => c?.role === "model" || c?.role === "assistant"
        );
        const effectiveUserThinkingConfig = isImageModel ? void 0 : userThinkingConfig;
        if (isImageModel) {
          const imageConfig = buildImageGenerationConfig();
          const generationConfig = rawGenerationConfig ?? {};
          generationConfig.imageConfig = imageConfig;
          delete generationConfig.thinkingConfig;
          if (!generationConfig.candidateCount) {
            generationConfig.candidateCount = 1;
          }
          requestPayload.generationConfig = generationConfig;
          if (!requestPayload.safetySettings) {
            requestPayload.safetySettings = [
              {
                category: "HARM_CATEGORY_HARASSMENT",
                threshold: "BLOCK_ONLY_HIGH"
              },
              {
                category: "HARM_CATEGORY_HATE_SPEECH",
                threshold: "BLOCK_ONLY_HIGH"
              },
              {
                category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                threshold: "BLOCK_ONLY_HIGH"
              },
              {
                category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                threshold: "BLOCK_ONLY_HIGH"
              },
              {
                category: "HARM_CATEGORY_CIVIC_INTEGRITY",
                threshold: "BLOCK_ONLY_HIGH"
              }
            ];
          }
          delete requestPayload.tools;
          delete requestPayload.toolConfig;
          requestPayload.systemInstruction = {
            parts: [
              {
                text: "You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request."
              }
            ]
          };
        } else {
          const finalThinkingConfig = resolveThinkingConfig(
            effectiveUserThinkingConfig,
            resolved.isThinkingModel ?? isThinkingCapableModel2(effectiveModel),
            isClaude,
            hasAssistantHistory
          );
          const normalizedThinking = normalizeThinkingConfig(finalThinkingConfig);
          if (normalizedThinking) {
            const thinkingBudget = tierThinkingBudget ?? normalizedThinking.thinkingBudget;
            let thinkingConfig;
            if (isClaudeThinking && headerStyle !== "antigravity") {
              thinkingConfig = {
                include_thoughts: normalizedThinking.includeThoughts ?? true,
                ...typeof thinkingBudget === "number" && thinkingBudget > 0 ? { thinking_budget: thinkingBudget } : {}
              };
            } else if (tierThinkingLevel) {
              thinkingConfig = {
                includeThoughts: normalizedThinking.includeThoughts,
                thinkingLevel: tierThinkingLevel
              };
            } else {
              thinkingConfig = {
                includeThoughts: normalizedThinking.includeThoughts,
                ...typeof thinkingBudget === "number" && (thinkingBudget > 0 || thinkingBudget === -1) ? { thinkingBudget } : {}
              };
            }
            if (rawGenerationConfig) {
              rawGenerationConfig.thinkingConfig = thinkingConfig;
              applyAgyGenerationDefaults(
                effectiveModel,
                rawGenerationConfig,
                headerStyle
              );
              if (isClaudeThinking && typeof thinkingBudget === "number" && thinkingBudget > 0) {
                const currentMax = rawGenerationConfig.maxOutputTokens ?? rawGenerationConfig.max_output_tokens;
                if (headerStyle === "antigravity" && !currentMax) {
                  rawGenerationConfig.maxOutputTokens = 64e3;
                } else if (!currentMax || currentMax <= thinkingBudget) {
                  rawGenerationConfig.maxOutputTokens = computeClaudeMaxOutputTokens(thinkingBudget);
                }
                if (rawGenerationConfig.max_output_tokens !== void 0) {
                  delete rawGenerationConfig.max_output_tokens;
                }
              }
              requestPayload.generationConfig = rawGenerationConfig;
            } else {
              const generationConfig = {
                thinkingConfig
              };
              if (isClaudeThinking && typeof thinkingBudget === "number" && thinkingBudget > 0) {
                generationConfig.maxOutputTokens = headerStyle === "antigravity" ? 64e3 : computeClaudeMaxOutputTokens(thinkingBudget);
              }
              applyAgyGenerationDefaults(
                effectiveModel,
                generationConfig,
                headerStyle
              );
              requestPayload.generationConfig = generationConfig;
            }
          } else if (rawGenerationConfig?.thinkingConfig) {
            delete rawGenerationConfig.thinkingConfig;
            applyAgyGenerationDefaults(
              effectiveModel,
              rawGenerationConfig,
              headerStyle
            );
            requestPayload.generationConfig = rawGenerationConfig;
          } else if (rawGenerationConfig) {
            applyAgyGenerationDefaults(
              effectiveModel,
              rawGenerationConfig,
              headerStyle
            );
            requestPayload.generationConfig = rawGenerationConfig;
          }
        }
        if (extraBody) {
          delete extraBody.thinkingConfig;
          delete extraBody.thinking;
        }
        delete requestPayload.thinkingConfig;
        delete requestPayload.thinking;
        if ("system_instruction" in requestPayload) {
          requestPayload.systemInstruction = requestPayload.system_instruction;
          delete requestPayload.system_instruction;
        }
        if (headerStyle !== "antigravity") {
          const cachedContentFromExtra = typeof requestPayload.extra_body === "object" && requestPayload.extra_body ? requestPayload.extra_body.cached_content ?? requestPayload.extra_body.cachedContent : void 0;
          const cachedContent = requestPayload.cached_content ?? requestPayload.cachedContent ?? cachedContentFromExtra;
          if (cachedContent) {
            requestPayload.cachedContent = cachedContent;
          }
          delete requestPayload.cached_content;
          if (requestPayload.extra_body && typeof requestPayload.extra_body === "object") {
            delete requestPayload.extra_body.cached_content;
            delete requestPayload.extra_body.cachedContent;
            if (Object.keys(requestPayload.extra_body).length === 0) {
              delete requestPayload.extra_body;
            }
          }
        }
        const hasTools = Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0;
        if (hasTools) {
          if (isClaude) {
            const functionDeclarations = [];
            const passthroughTools = [];
            const normalizeSchema = (schema) => {
              const createPlaceholderSchema = (base = {}) => ({
                ...base,
                type: "object",
                properties: {
                  [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
                    type: "boolean",
                    description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION
                  }
                },
                required: [EMPTY_SCHEMA_PLACEHOLDER_NAME]
              });
              if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
                toolDebugMissing += 1;
                return createPlaceholderSchema();
              }
              const cleaned = cleanJSONSchemaForAntigravity(schema);
              if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
                toolDebugMissing += 1;
                return createPlaceholderSchema();
              }
              const hasProperties = cleaned.properties && typeof cleaned.properties === "object" && Object.keys(cleaned.properties).length > 0;
              cleaned.type = "object";
              if (!hasProperties) {
                cleaned.properties = {
                  [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
                    type: "boolean",
                    description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION
                  }
                };
                cleaned.required = Array.isArray(cleaned.required) ? Array.from(
                  /* @__PURE__ */ new Set([
                    ...cleaned.required,
                    EMPTY_SCHEMA_PLACEHOLDER_NAME
                  ])
                ) : [EMPTY_SCHEMA_PLACEHOLDER_NAME];
              }
              return cleaned;
            };
            requestPayload.tools.forEach((tool2) => {
              const pushDeclaration = (decl, source) => {
                const schema = decl?.parameters || decl?.parametersJsonSchema || decl?.input_schema || decl?.inputSchema || tool2.parameters || tool2.parametersJsonSchema || tool2.input_schema || tool2.inputSchema || tool2.function?.parameters || tool2.function?.parametersJsonSchema || tool2.function?.input_schema || tool2.function?.inputSchema || tool2.custom?.parameters || tool2.custom?.parametersJsonSchema || tool2.custom?.input_schema;
                let name = decl?.name || tool2.name || tool2.function?.name || tool2.custom?.name || `tool-${functionDeclarations.length}`;
                name = String(name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
                const description = decl?.description || tool2.description || tool2.function?.description || tool2.custom?.description || "";
                functionDeclarations.push({
                  name,
                  description: String(description || ""),
                  parameters: normalizeSchema(schema)
                });
                toolDebugSummaries.push(
                  `decl=${name},src=${source},hasSchema=${schema ? "y" : "n"}`
                );
              };
              if (Array.isArray(tool2.functionDeclarations) && tool2.functionDeclarations.length > 0) {
                tool2.functionDeclarations.forEach((decl) => {
                  pushDeclaration(decl, "functionDeclarations");
                });
                return;
              }
              if (tool2.function || tool2.custom || tool2.parameters || tool2.input_schema || tool2.inputSchema) {
                pushDeclaration(
                  tool2.function ?? tool2.custom ?? tool2,
                  "function/custom"
                );
                return;
              }
              passthroughTools.push(tool2);
            });
            const finalTools = [];
            if (functionDeclarations.length > 0) {
              finalTools.push({ functionDeclarations });
            }
            requestPayload.tools = finalTools.concat(passthroughTools);
          } else {
            const geminiResult = applyGeminiTransforms(requestPayload, {
              model: effectiveModel,
              normalizedThinking: void 0,
              // Thinking config already applied above (lines 816-880)
              tierThinkingBudget,
              tierThinkingLevel
            });
            toolDebugMissing = geminiResult.toolDebugMissing;
            toolDebugSummaries.push(...geminiResult.toolDebugSummaries);
          }
          try {
            toolDebugPayload = JSON.stringify(requestPayload.tools);
          } catch {
            toolDebugPayload = void 0;
          }
          const enableToolHardening = options?.claudeToolHardening ?? true;
          if (enableToolHardening && isClaude && Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0) {
            requestPayload.tools = injectParameterSignatures(
              requestPayload.tools,
              CLAUDE_DESCRIPTION_PROMPT
            );
            injectToolHardeningInstruction(
              requestPayload,
              CLAUDE_TOOL_SYSTEM_INSTRUCTION
            );
          }
          if (isClaudeThinking && Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0) {
            appendClaudeThinkingHint(requestPayload);
          }
        }
        const conversationKey = resolveConversationKey(requestPayload);
        signatureSessionKey = buildSignatureSessionKey(
          PLUGIN_SESSION_ID,
          effectiveModel,
          conversationKey,
          resolveProjectKey(projectId)
        );
        if (isClaude) {
          sanitizeCrossModelPayloadInPlace(requestPayload, {
            targetModel: effectiveModel
          });
          deepFilterThinkingBlocks(
            requestPayload,
            signatureSessionKey,
            getCachedSignature,
            true
          );
          if (isClaudeThinking && keepThinkingEnabled && Array.isArray(requestPayload.contents)) {
            requestPayload.contents = ensureThinkingBeforeToolUseInContents(
              requestPayload.contents,
              signatureSessionKey
            );
          }
          if (isClaudeThinking && keepThinkingEnabled && Array.isArray(requestPayload.messages)) {
            requestPayload.messages = ensureThinkingBeforeToolUseInMessages(
              requestPayload.messages,
              signatureSessionKey
            );
          }
          if (isClaudeThinking && keepThinkingEnabled) {
            const hasToolUse = Array.isArray(requestPayload.contents) && hasToolUseInContents(requestPayload.contents) || Array.isArray(requestPayload.messages) && hasToolUseInMessages(requestPayload.messages);
            const hasSignedThinking = Array.isArray(requestPayload.contents) && hasSignedThinkingInContents(
              requestPayload.contents,
              signatureSessionKey
            ) || Array.isArray(requestPayload.messages) && hasSignedThinkingInMessages(
              requestPayload.messages,
              signatureSessionKey
            );
            const hasCachedThinking = defaultSignatureStore.has(signatureSessionKey);
            needsSignedThinkingWarmup = hasToolUse && !hasSignedThinking && !hasCachedThinking;
          }
        }
        if (isClaude && Array.isArray(requestPayload.contents)) {
          let toolCallCounter = 0;
          const pendingCallIdsByName = /* @__PURE__ */ new Map();
          requestPayload.contents = requestPayload.contents.map(
            (content) => {
              if (!content || !Array.isArray(content.parts)) {
                return content;
              }
              const newParts = content.parts.map((part) => {
                if (part && typeof part === "object" && part.functionCall) {
                  const call = { ...part.functionCall };
                  if (!call.id) {
                    call.id = `tool-call-${++toolCallCounter}`;
                  }
                  const nameKey = typeof call.name === "string" ? call.name : `tool-${toolCallCounter}`;
                  const queue2 = pendingCallIdsByName.get(nameKey) || [];
                  queue2.push(call.id);
                  pendingCallIdsByName.set(nameKey, queue2);
                  return { ...part, functionCall: call };
                }
                return part;
              });
              return { ...content, parts: newParts };
            }
          );
          requestPayload.contents = requestPayload.contents.map(
            (content) => {
              if (!content || !Array.isArray(content.parts)) {
                return content;
              }
              const newParts = content.parts.map((part) => {
                if (part && typeof part === "object" && part.functionResponse) {
                  const resp = { ...part.functionResponse };
                  if (!resp.id && typeof resp.name === "string") {
                    const queue2 = pendingCallIdsByName.get(resp.name);
                    if (queue2 && queue2.length > 0) {
                      resp.id = queue2.shift();
                      pendingCallIdsByName.set(resp.name, queue2);
                    }
                  }
                  return { ...part, functionResponse: resp };
                }
                return part;
              });
              return { ...content, parts: newParts };
            }
          );
          requestPayload.contents = fixToolResponseGrouping(
            requestPayload.contents
          );
        }
        if (Array.isArray(requestPayload.messages)) {
          requestPayload.messages = validateAndFixClaudeToolPairing(
            requestPayload.messages
          );
        }
        if (isClaudeThinking && Array.isArray(requestPayload.contents)) {
          const conversationState = analyzeConversationState(
            requestPayload.contents
          );
          if (forceThinkingRecovery || needsThinkingRecovery(conversationState)) {
            thinkingRecoveryMessage = forceThinkingRecovery ? "Thinking recovery: retrying with fresh turn (API error)" : "Thinking recovery: restarting turn (corrupted context)";
            requestPayload.contents = closeToolLoopForThinking(
              requestPayload.contents
            );
            defaultSignatureStore.delete(signatureSessionKey);
          }
        }
        if (headerStyle === "antigravity" || isClaude) {
          if (Array.isArray(requestPayload.contents)) {
            const lastContent = requestPayload.contents[requestPayload.contents.length - 1];
            if (lastContent?.role === "model" || lastContent?.role === "assistant") {
              requestPayload.contents.push({
                role: "user",
                parts: [{ text: "[Continue]" }]
              });
            }
          }
          if (Array.isArray(requestPayload.messages)) {
            const lastMessage = requestPayload.messages[requestPayload.messages.length - 1];
            if (lastMessage?.role === "model" || lastMessage?.role === "assistant") {
              ;
              requestPayload.messages.push({
                role: "user",
                parts: [{ text: "[Continue]" }]
              });
            }
          }
        }
        if ("model" in requestPayload) {
          delete requestPayload.model;
        }
        stripInjectedDebugFromRequestPayload(requestPayload);
        sanitizeRequestPayloadForAntigravity(requestPayload);
        if (headerStyle === "antigravity") {
          stripUnsupportedAntigravityFields(requestPayload);
          configureAntigravityToolCalling(requestPayload);
        }
        const effectiveProjectId = projectId?.trim() || (headerStyle === "antigravity" ? ANTIGRAVITY_DEFAULT_PROJECT_ID : "");
        resolvedProjectId = effectiveProjectId;
        sessionId = signatureSessionKey;
        const agyMetadata = headerStyle === "antigravity" ? buildAgyAgentRequestMetadata(
          options?.agySession ?? DEFAULT_AGY_REQUEST_SESSION,
          requestPayload,
          effectiveModel,
          options?.agyRequestTimestamp
        ) : null;
        requestPayload.sessionId = agyMetadata?.sessionId ?? signatureSessionKey;
        if (agyMetadata) {
          requestPayload.labels = agyMetadata.labels;
          orderAgyRequestPayloadInPlace(requestPayload);
        }
        const wrappedBody = headerStyle === "antigravity" ? {
          project: effectiveProjectId,
          requestId: agyMetadata?.requestId,
          request: requestPayload,
          model: effectiveModel,
          userAgent: "antigravity",
          requestType: "agent"
        } : {
          project: effectiveProjectId,
          model: effectiveModel,
          request: requestPayload
        };
        body = safeStringify(
          headerStyle === "antigravity" ? orderAntigravityEnvelope(wrappedBody) : wrappedBody
        );
      }
    } catch {
      throw new Error("Failed to build Antigravity request body");
    }
  }
  if (isClaudeThinking) {
    const existing = headers.get("anthropic-beta");
    const interleavedHeader = "interleaved-thinking-2025-05-14";
    if (existing) {
      if (!existing.includes(interleavedHeader)) {
        headers.set("anthropic-beta", `${existing},${interleavedHeader}`);
      }
    } else {
      headers.set("anthropic-beta", interleavedHeader);
    }
  }
  if (headerStyle === "antigravity") {
    const selectedHeaders = getRandomizedHeaders("antigravity", requestedModel);
    const fingerprint = options?.fingerprint ?? getSessionFingerprint();
    const fingerprintHeaders = buildFingerprintHeaders(fingerprint);
    headers.set(
      "User-Agent",
      fingerprintHeaders["User-Agent"] || selectedHeaders["User-Agent"]
    );
    headers.set("Accept-Encoding", "gzip");
  } else {
    const geminiCliHeaders = getRandomizedHeaders("gemini-cli", requestedModel);
    headers.set("User-Agent", geminiCliHeaders["User-Agent"]);
    if (geminiCliHeaders["X-Goog-Api-Client"])
      headers.set("X-Goog-Api-Client", geminiCliHeaders["X-Goog-Api-Client"]);
    if (geminiCliHeaders["Client-Metadata"])
      headers.set("Client-Metadata", geminiCliHeaders["Client-Metadata"]);
  }
  return {
    request: transformedUrl,
    init: {
      ...baseInit,
      headers,
      body
    },
    streaming,
    requestedModel,
    effectiveModel,
    projectId: resolvedProjectId,
    endpoint: transformedUrl,
    sessionId,
    toolDebugMissing,
    toolDebugSummary: toolDebugSummaries.slice(0, 20).join(" | "),
    toolDebugPayload,
    needsSignedThinkingWarmup,
    headerStyle,
    thinkingRecoveryMessage
  };
}
function buildThinkingWarmupBody(bodyText, isClaudeThinking) {
  if (!bodyText || !isClaudeThinking) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const warmupPrompt = "Warmup request for thinking signature.";
  const wireModel = typeof parsed.model === "string" ? parsed.model : "claude-sonnet-4-6";
  const requestObjects = [];
  const updateRequest = (req) => {
    req.contents = [{ role: "user", parts: [{ text: warmupPrompt }] }];
    delete req.tools;
    delete req.toolConfig;
    const generationConfig = req.generationConfig ?? {};
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: AGY_CLAUDE_THINKING_BUDGET
    };
    generationConfig.maxOutputTokens = getAgyMaxOutputTokens(wireModel) ?? computeClaudeMaxOutputTokens(AGY_CLAUDE_THINKING_BUDGET);
    req.generationConfig = generationConfig;
    requestObjects.push(req);
  };
  if (parsed.request && typeof parsed.request === "object") {
    updateRequest(parsed.request);
    const nested = parsed.request.request;
    if (nested && typeof nested === "object") {
      updateRequest(nested);
    }
  } else {
    updateRequest(parsed);
  }
  const wireRequest = requestObjects.at(-1);
  if (wireRequest) {
    const numericSessionId = typeof wireRequest.sessionId === "string" ? wireRequest.sessionId : DEFAULT_AGY_REQUEST_SESSION.numericSessionId;
    const warmupSession = {
      conversationId: crypto2.randomUUID(),
      trajectoryId: crypto2.randomUUID(),
      numericSessionId
    };
    const metadata = buildAgyAgentRequestMetadata(
      warmupSession,
      wireRequest,
      wireModel
    );
    parsed.requestId = metadata.requestId;
    wireRequest.sessionId = metadata.sessionId;
    wireRequest.labels = metadata.labels;
    orderAgyRequestPayloadInPlace(wireRequest);
  }
  return safeStringify(parsed);
}
async function transformAntigravityResponse(response, streaming, debugContext, requestedModel, projectId, endpoint, effectiveModel, sessionId, toolDebugMissing, toolDebugSummary, toolDebugPayload, debugLines, dumpContext) {
  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.includes("application/json");
  const isEventStreamResponse = contentType.includes("text/event-stream");
  const debugText = isDebugTuiEnabled() && Array.isArray(debugLines) && debugLines.length > 0 ? formatDebugLinesForThinking(debugLines) : getKeepThinking() ? SYNTHETIC_THINKING_PLACEHOLDER : void 0;
  const cacheSignatures = shouldCacheThinkingSignatures(effectiveModel);
  if (!isJsonResponse && !isEventStreamResponse) {
    logAntigravityDebugResponse(debugContext, response, {
      note: "Non-JSON response (body omitted)"
    });
    return response;
  }
  if (streaming && response.ok && isEventStreamResponse && response.body) {
    const headers = new Headers(response.headers);
    logAntigravityDebugResponse(debugContext, response, {
      note: "Streaming SSE response (real-time transform)"
    });
    noteGeminiDumpResponse(dumpContext, response);
    const rawDumpTransformer = createGeminiDumpResponseTransform(dumpContext);
    const sourceBody = rawDumpTransformer ? response.body.pipeThrough(rawDumpTransformer) : response.body;
    const streamingTransformer = createStreamingTransformer(
      defaultSignatureStore,
      {
        onCacheSignature: cacheSignature,
        onInjectDebug: injectDebugThinking,
        onUsageMetadata: (usage) => {
          if (effectiveModel) {
            const cacheRead = usage.cachedContentTokenCount;
            const totalInput = usage.promptTokenCount ?? usage.totalTokenCount;
            const hitRate = totalInput > 0 ? Math.round(cacheRead / totalInput * 100) : 0;
            const status = cacheRead > 0 ? "HIT" : "MISS";
            logCacheStats(effectiveModel, cacheRead, 0, totalInput);
            log14.debug(
              `[Cache] ${status} model=${effectiveModel} read=${cacheRead} total=${totalInput} hitRate=${hitRate}%`
            );
            _lastCacheStats = {
              model: effectiveModel,
              read: cacheRead,
              total: totalInput,
              hitRate
            };
          }
        },
        transformThinkingParts
      },
      {
        signatureSessionKey: sessionId,
        debugText,
        cacheSignatures,
        displayedThinkingHashes: effectiveModel && isGemini3Model(effectiveModel) ? sessionDisplayedThinkingHashes : void 0
        // injectSyntheticThinking removed - keep_thinking now unified with debug via debugText
      }
    );
    return new Response(sourceBody.pipeThrough(streamingTransformer), {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
  const responseFallback = response.clone();
  try {
    const headers = new Headers(response.headers);
    const text = await response.text();
    noteGeminiDumpResponse(dumpContext, response);
    appendGeminiDumpResponseText(dumpContext, text);
    if (!response.ok) {
      let errorBody;
      try {
        errorBody = JSON.parse(text);
      } catch {
        errorBody = { error: { message: text } };
      }
      if (errorBody?.error) {
        const rawErrorMessage = typeof errorBody.error.message === "string" && errorBody.error.message.length > 0 ? errorBody.error.message : "Unknown error";
        const errorType = detectErrorType(rawErrorMessage);
        const debugInfo = `

[Debug Info]
Requested Model: ${requestedModel || "Unknown"}
Effective Model: ${effectiveModel || "Unknown"}
Project: ${projectId || "Unknown"}
Endpoint: ${endpoint || "Unknown"}
Status: ${response.status}
Request ID: ${headers.get("x-request-id") || "N/A"}${toolDebugMissing !== void 0 ? `
Tool Debug Missing: ${toolDebugMissing}` : ""}${toolDebugSummary ? `
Tool Debug Summary: ${toolDebugSummary}` : ""}${toolDebugPayload ? `
Tool Debug Payload: ${toolDebugPayload}` : ""}`;
        const injectedDebug = debugText ? `

${debugText}` : "";
        errorBody.error.message = rawErrorMessage + debugInfo + injectedDebug;
        if (errorType === "thinking_block_order") {
          const recoveryError = new Error("THINKING_RECOVERY_NEEDED");
          recoveryError.recoveryType = errorType;
          recoveryError.originalError = errorBody;
          recoveryError.debugInfo = debugInfo;
          throw recoveryError;
        }
        const errorMessage = errorBody.error.message?.toLowerCase() || "";
        if (errorMessage.includes("prompt is too long") || errorMessage.includes("context length exceeded") || errorMessage.includes("context_length_exceeded") || errorMessage.includes("maximum context length")) {
          headers.set("x-antigravity-context-error", "prompt_too_long");
        }
        if (errorMessage.includes("tool_use") && errorMessage.includes("tool_result") && (errorMessage.includes("without") || errorMessage.includes("immediately after"))) {
          headers.set("x-antigravity-context-error", "tool_pairing");
        }
        return new Response(JSON.stringify(errorBody), {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }
      if (errorBody?.error?.details && Array.isArray(errorBody.error.details)) {
        const retryInfo = errorBody.error.details.find(
          (detail) => detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
        );
        if (retryInfo?.retryDelay) {
          const match = retryInfo.retryDelay.match(/^([\d.]+)s$/);
          if (match?.[1]) {
            const retrySeconds = parseFloat(match[1]);
            if (!Number.isNaN(retrySeconds) && retrySeconds > 0) {
              const retryAfterSec = Math.ceil(retrySeconds).toString();
              const retryAfterMs = Math.ceil(retrySeconds * 1e3).toString();
              headers.set("Retry-After", retryAfterSec);
              headers.set("retry-after-ms", retryAfterMs);
            }
          }
        }
      }
    }
    const init = {
      status: response.status,
      statusText: response.statusText,
      headers
    };
    const usageFromSse = streaming && isEventStreamResponse ? extractUsageFromSsePayload(text) : null;
    const parsed = !streaming || !isEventStreamResponse ? parseAntigravityApiBody(text) : null;
    const patched = parsed ? rewriteAntigravityPreviewAccessError(
      parsed,
      response.status,
      requestedModel
    ) : null;
    const effectiveBody = patched ?? parsed ?? void 0;
    const usage = usageFromSse ?? (effectiveBody ? extractUsageMetadata(effectiveBody) : null);
    if (usage && effectiveModel) {
      const cacheRead = usage.cachedContentTokenCount ?? 0;
      const totalInput = usage.promptTokenCount ?? usage.totalTokenCount ?? 0;
      const hitRate = totalInput > 0 ? Math.round(cacheRead / totalInput * 100) : 0;
      const status = cacheRead > 0 ? "HIT" : "MISS";
      logCacheStats(effectiveModel, cacheRead, 0, totalInput);
      log14.debug(
        `[Cache] ${status} model=${effectiveModel} read=${cacheRead} total=${totalInput} hitRate=${hitRate}%`
      );
    }
    if (usage?.cachedContentTokenCount !== void 0) {
      headers.set(
        "x-antigravity-cached-content-token-count",
        String(usage.cachedContentTokenCount)
      );
      if (usage.totalTokenCount !== void 0) {
        headers.set(
          "x-antigravity-total-token-count",
          String(usage.totalTokenCount)
        );
      }
      if (usage.promptTokenCount !== void 0) {
        headers.set(
          "x-antigravity-prompt-token-count",
          String(usage.promptTokenCount)
        );
      }
      if (usage.candidatesTokenCount !== void 0) {
        headers.set(
          "x-antigravity-candidates-token-count",
          String(usage.candidatesTokenCount)
        );
      }
    }
    logAntigravityDebugResponse(debugContext, response, {
      body: text,
      note: streaming ? "Streaming SSE payload (buffered fallback)" : void 0,
      headersOverride: headers
    });
    if (!parsed) {
      return new Response(text, init);
    }
    if (effectiveBody?.response !== void 0) {
      let responseBody = effectiveBody.response;
      if (debugText) {
        responseBody = injectDebugThinking(responseBody, debugText);
      }
      const transformed = transformThinkingParts(responseBody);
      return new Response(JSON.stringify(transformed), init);
    }
    if (patched) {
      return new Response(JSON.stringify(patched), init);
    }
    return new Response(text, init);
  } catch (error) {
    if (error instanceof Error && error.message === "THINKING_RECOVERY_NEEDED") {
      throw error;
    }
    logAntigravityDebugResponse(debugContext, response, {
      error,
      note: "Failed to transform Antigravity response"
    });
    return responseFallback;
  }
}

// src/plugin/session-context.ts
import { resolve as resolve2 } from "node:path";
import { pathToFileURL } from "node:url";
var FALLBACK_SESSION_KEY = "__default__";
function extractOpenCodeSessionIdentity(headers) {
  const normalized = new Headers(headers);
  return {
    sessionId: normalized.get("x-session-affinity") ?? normalized.get("x-session-id"),
    parentSessionId: normalized.get("x-parent-session-id")
  };
}
var AgySessionRegistry = class {
  requestSessions;
  parentSessionIds = /* @__PURE__ */ new Map();
  constructor(directory, options = {}) {
    const workspaceUri = directory ? pathToFileURL(resolve2(directory)).href : "";
    this.requestSessions = new AgyRequestSessionStore(workspaceUri, options);
  }
  getOrCreate(identity) {
    const key = identity.sessionId ?? FALLBACK_SESSION_KEY;
    const request = this.requestSessions.getOrCreate(key);
    this.recordParent(key, identity.parentSessionId);
    this.pruneParentRelationships();
    return request;
  }
  beginRequest(identity) {
    const key = identity.sessionId ?? FALLBACK_SESSION_KEY;
    const scope = this.requestSessions.beginRequest(key);
    this.recordParent(key, identity.parentSessionId);
    this.pruneParentRelationships();
    return scope;
  }
  register(sessionId, parentSessionId = null) {
    this.getOrCreate({ sessionId, parentSessionId });
  }
  getParentSessionId(sessionId) {
    if (!this.requestSessions.has(sessionId)) {
      this.parentSessionIds.delete(sessionId);
      return null;
    }
    return this.parentSessionIds.get(sessionId) ?? null;
  }
  delete(sessionId) {
    this.requestSessions.delete(sessionId);
    this.parentSessionIds.delete(sessionId);
  }
  clear() {
    this.requestSessions.clear();
    this.parentSessionIds.clear();
  }
  get size() {
    return this.requestSessions.size;
  }
  recordParent(key, parentSessionId) {
    if (parentSessionId || !this.parentSessionIds.has(key)) {
      this.parentSessionIds.set(key, parentSessionId);
    }
  }
  pruneParentRelationships() {
    for (const sessionId of this.parentSessionIds.keys()) {
      if (!this.requestSessions.has(sessionId)) {
        this.parentSessionIds.delete(sessionId);
      }
    }
  }
};

// src/plugin/fetch-interceptor.ts
var log15 = createLogger2("fetch-interceptor");
var FIRST_RETRY_DELAY_MS = 1e3;
var defaultAgyTransport = (url, init, options) => fetchWithAgyCliTransport(url, init, options);
var defaultFetchImpl = (input2, init) => globalThis.fetch(input2, init);
function createNoAccountResponse(message, model) {
  const body = {
    error: {
      code: 401,
      message,
      status: "UNAUTHENTICATED"
    }
  };
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "X-Antigravity-Error-Type": "no_accounts",
      "X-Antigravity-Requested-Model": model
    }
  });
}
function terminalFetchError(lastError, fallbackMessage) {
  return lastError ?? new Error(fallbackMessage);
}
function retryAfterMsFromResponse(response, defaultRetryMs = 6e4) {
  const retryAfterMsHeader = response.headers.get("retry-after-ms");
  if (retryAfterMsHeader) {
    const parsed = Number.parseInt(retryAfterMsHeader, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const retryAfterHeader = response.headers.get("retry-after");
  if (retryAfterHeader) {
    const parsed = Number.parseInt(retryAfterHeader, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed * 1e3;
    }
  }
  return defaultRetryMs;
}
function formatWaitTime2(ms) {
  if (ms < 1e3) return `${ms}ms`;
  const seconds = Math.ceil(ms / 1e3);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
function sleep3(ms, signal) {
  return new Promise((resolve3, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("Aborted")
      );
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      resolve3();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(
        signal?.reason instanceof Error ? signal.reason : new Error("Aborted")
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function createFetchInterceptor(context) {
  const {
    client,
    providerId,
    config,
    accountManager,
    quotaManager,
    getAuth,
    agySessionRegistry,
    operatorSettings,
    agyTransport = defaultAgyTransport,
    fetchImpl = defaultFetchImpl
    // directory is part of the contract but not consumed by this interceptor;
    // callers use it when constructing sibling services (e.g. project context).
  } = context;
  void context.directory;
  const retryState = createRetryState();
  const warmupState = createWarmupState();
  let disposed = false;
  const upstreamFetch = fetchImpl;
  const transport = agyTransport;
  async function triggerAsyncQuotaRefreshForAccount(accountIndex, intervalMinutes) {
    if (intervalMinutes <= 0) return;
    const accounts = accountManager.getAccounts();
    const account = accounts[accountIndex];
    if (!account || account.enabled === false) return;
    const intervalMs = intervalMinutes * 60 * 1e3;
    const age = account.cachedQuotaUpdatedAt != null ? Date.now() - account.cachedQuotaUpdatedAt : Infinity;
    if (age < intervalMs) return;
    let singleAccount;
    try {
      const accountsForCheck = accountManager.getAccountsForQuotaCheck();
      singleAccount = accountsForCheck[accountIndex];
      if (!singleAccount) return;
      const expectedRefreshToken = singleAccount.refreshToken;
      const result = await quotaManager.refreshAccount(singleAccount, {
        index: accountIndex
      });
      if (result.status === "ok" && result.quota?.groups) {
        const currentIndex = accountManager.getAccounts().findIndex(
          (entry) => entry.parts.refreshToken === expectedRefreshToken
        );
        if (currentIndex === -1) return;
        accountManager.updateQuotaCache(
          currentIndex,
          result.quota.groups,
          expectedRefreshToken
        );
        accountManager.requestSaveToDisk();
      }
    } catch (err) {
      log15.debug(
        `quota-refresh-failed ${singleAccount ? quotaManager.hashedLogLabel("account", singleAccount) : `idx-${accountIndex}`}`,
        { error: String(err) }
      );
    }
  }
  async function fetch(input2, init) {
    if (disposed) {
      return upstreamFetch(input2, init);
    }
    if (!isGenerativeLanguageRequest(input2)) {
      return upstreamFetch(input2, init);
    }
    const latestAuth = await getAuth();
    if (!isOAuthAuth(latestAuth)) {
      return upstreamFetch(input2, init);
    }
    if (typeof input2 !== "string") {
      if (input2 instanceof Request) {
        const req = input2;
        const headers = new Headers(req.headers);
        if (init?.headers) {
          new Headers(init.headers).forEach((v, k) => {
            headers.set(k, v);
          });
        }
        const bodyBuffer = req.body ? await req.clone().arrayBuffer() : void 0;
        init = {
          method: init?.method ?? req.method,
          headers,
          body: init?.body ?? (bodyBuffer ? Buffer.from(bodyBuffer) : void 0),
          signal: init?.signal ?? req.signal
        };
        input2 = req.url;
      } else {
        input2 = String(input2.href ?? input2);
      }
    }
    const localImageTitle = getImageModelLocalTitle(input2, init);
    if (localImageTitle !== void 0) {
      return createSyntheticTextResponse(localImageTitle, {
        "X-Antigravity-Response-Type": "local_title"
      });
    }
    const requestSessionIdentity = extractOpenCodeSessionIdentity(init?.headers);
    const agyRequestScope = agySessionRegistry.beginRequest(
      requestSessionIdentity
    );
    const agyRequestSession = agyRequestScope.session;
    const accountSessionIdentity = requestSessionIdentity.sessionId ? {
      id: requestSessionIdentity.sessionId,
      parentId: requestSessionIdentity.parentSessionId
    } : void 0;
    const isChildRequest = requestSessionIdentity.parentSessionId !== null;
    if (accountManager.getAccountCount() === 0) {
      const urlString2 = typeof input2 === "string" ? input2 : toUrlString(input2);
      const modelFromUrl = extractModelFromUrl(urlString2) ?? "unknown";
      return createNoAccountResponse(
        "No Antigravity accounts configured. Run `opencode auth login`.",
        modelFromUrl
      );
    }
    const urlString = toUrlString(input2);
    const family = getModelFamilyFromUrl(urlString);
    const model = extractModelFromUrl(urlString);
    const debugLines = [];
    const pushDebug = (line) => {
      if (!isDebugEnabled()) return;
      debugLines.push(line);
    };
    pushDebug(`request=${urlString}`);
    if (requestSessionIdentity.sessionId) {
      pushDebug(
        `[Session] id=${requestSessionIdentity.sessionId} parent=${requestSessionIdentity.parentSessionId ?? "none"} child=${isChildRequest}`
      );
    }
    const cachedStats = getLastCacheStats();
    if (cachedStats) {
      const label = cachedStats.hitRate > 0 ? "HIT" : "MISS";
      pushDebug(
        `[Cache] ${label} model=${cachedStats.model} read=${cachedStats.read} total=${cachedStats.total} hitRate=${cachedStats.hitRate}%`
      );
    }
    let lastFailure = null;
    let lastError = null;
    const abortSignal = init?.signal ?? void 0;
    const checkAborted = () => {
      if (abortSignal?.aborted) {
        throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error("Aborted");
      }
    };
    const quietMode = config.quiet_mode;
    const toastScope = config.toast_scope;
    const operatorRouting = operatorSettings?.get().routing;
    const effectiveConfig = {
      ...config,
      cli_first: operatorRouting?.cli_first ?? config.cli_first,
      quota_style_fallback: operatorRouting?.quota_style_fallback ?? config.quota_style_fallback
    };
    const showToast = async (message, variant) => {
      log15.debug("toast", {
        message,
        variant,
        isChildSession: isChildRequest,
        toastScope
      });
      if (quietMode) return;
      if (abortSignal?.aborted) return;
      if (toastScope === "root_only" && isChildRequest) {
        log15.debug("toast-suppressed-child-session", {
          message,
          variant,
          parentID: requestSessionIdentity.parentSessionId
        });
        return;
      }
      if (variant === "warning" && message.toLowerCase().includes("rate")) {
        if (!retryState.shouldShowRateLimitToast(message)) {
          return;
        }
      }
      try {
        await client.tui.showToast({ body: { message, variant } });
      } catch {
      }
    };
    const hasOtherAccountWithAntigravity = (currentAccount) => {
      if (family !== "gemini") return false;
      return accountManager.hasOtherAccountWithAntigravityAvailable(
        currentAccount.index,
        family,
        model
      );
    };
    let accountSwitchCount = 0;
    const maxAccountSwitches = config.max_account_switches ?? 2;
    let previousAccountIndex = -1;
    let needsCacheWarmup = false;
    while (true) {
      checkAborted();
      const accountCount = accountManager.getAccountCount();
      const routingDecision = resolveHeaderRoutingDecision(
        urlString,
        family,
        effectiveConfig
      );
      const { preferredHeaderStyle, explicitQuota, allowQuotaFallback } = routingDecision;
      if (accountCount === 0) {
        return createNoAccountResponse(
          "No Antigravity accounts available. Run `opencode auth login`.",
          model ?? "unknown"
        );
      }
      const softQuotaCacheTtlMs = computeSoftQuotaCacheTtlMs(
        config.soft_quota_cache_ttl_minutes,
        config.quota_refresh_interval_minutes
      );
      const operatorKillswitch = operatorSettings?.get().killswitch;
      const eligibleIndexes = operatorKillswitch?.enabled ? new Set(
        accountManager.getAccounts().filter((entry) => {
          const decision = evaluateKillswitchForAccount(
            entry,
            family,
            {
              routing: effectiveConfig.cli_first !== void 0 ? {
                cli_first: effectiveConfig.cli_first,
                quota_style_fallback: !!effectiveConfig.quota_style_fallback
              } : { cli_first: false, quota_style_fallback: false },
              killswitch: operatorKillswitch,
              log_level: "info"
            },
            { now: Date.now(), model }
          );
          return decision.allowed;
        }).map((entry) => entry.index)
      ) : null;
      if (eligibleIndexes !== null && eligibleIndexes.size === 0 && accountCount > 0) {
        try {
          throwIfAllKilled({
            family,
            model: model ?? "unknown",
            accounts: accountManager.getAccounts(),
            settings: {
              routing: { cli_first: false, quota_style_fallback: false },
              killswitch: operatorKillswitch ?? {
                enabled: false,
                minimum_remaining_percent: 0
              },
              log_level: "info"
            },
            quotaModel: model
          });
        } catch (error) {
          if (error instanceof AntigravityKillswitchError) {
            log15.warn("killswitch-all-excluded", {
              family,
              model,
              threshold: error.thresholdPercent,
              summaries: error.summaries
            });
            return createSyntheticErrorResponse(
              error.message,
              model ?? "unknown"
            );
          }
          throw error;
        }
      }
      const killedIndexes = eligibleIndexes === null ? void 0 : new Set(
        accountManager.getAccounts().map((entry) => entry.index).filter((index) => !eligibleIndexes.has(index))
      );
      let account = accountManager.getCurrentOrNextForFamily(
        family,
        model,
        config.account_selection_strategy,
        preferredHeaderStyle,
        config.pid_offset_enabled,
        config.soft_quota_threshold_percent,
        softQuotaCacheTtlMs,
        accountSessionIdentity,
        killedIndexes
      );
      if (account && eligibleIndexes !== null && !eligibleIndexes.has(account.index)) {
        pushDebug(
          `killswitch-excluded idx=${account.index} (precomputed eligible set)`
        );
        account = null;
      }
      if (!account && allowQuotaFallback) {
        const alternateHeaderStyle = preferredHeaderStyle === "antigravity" ? "gemini-cli" : "antigravity";
        account = accountManager.getCurrentOrNextForFamily(
          family,
          model,
          config.account_selection_strategy,
          alternateHeaderStyle,
          config.pid_offset_enabled,
          config.soft_quota_threshold_percent,
          softQuotaCacheTtlMs,
          accountSessionIdentity,
          killedIndexes
        );
        if (account) {
          pushDebug(
            `selected-by-fallback idx=${account.index} preferred=${preferredHeaderStyle} alternate=${alternateHeaderStyle}`
          );
        }
        if (account && eligibleIndexes !== null && !eligibleIndexes.has(account.index)) {
          pushDebug(
            `killswitch-excluded idx=${account.index} after fallback (precomputed eligible set)`
          );
          account = null;
        }
      }
      if (!account) {
        if (accountManager.areAllAccountsOverSoftQuota(
          family,
          config.soft_quota_threshold_percent,
          softQuotaCacheTtlMs,
          model
        )) {
          const threshold = config.soft_quota_threshold_percent;
          const softQuotaWaitMs = accountManager.getMinWaitTimeForSoftQuota(
            family,
            threshold,
            softQuotaCacheTtlMs,
            model
          );
          const maxWaitMs2 = (config.max_rate_limit_wait_seconds ?? 300) * 1e3;
          if (softQuotaWaitMs === null || maxWaitMs2 > 0 && softQuotaWaitMs > maxWaitMs2) {
            const waitTimeFormatted = softQuotaWaitMs ? formatWaitTime2(softQuotaWaitMs) : "unknown";
            await showToast(
              `All accounts over ${threshold}% quota threshold. Resets in ${waitTimeFormatted}.`,
              "error"
            );
            return createSyntheticErrorResponse(
              `Quota protection: All ${accountCount} account(s) are over ${threshold}% usage for ${family}. Quota resets in ${waitTimeFormatted}. Add more accounts, wait for quota reset, or set soft_quota_threshold_percent: 100 to disable.`,
              model ?? "unknown"
            );
          }
          pushDebug(
            `all-over-soft-quota family=${family} accounts=${accountCount} waitMs=${softQuotaWaitMs}`
          );
          if (!retryState.softQuotaToastShown()) {
            await showToast(
              `All ${accountCount} account(s) over ${threshold}% quota. Waiting ${formatWaitTime2(softQuotaWaitMs)}...`,
              "warning"
            );
            retryState.markSoftQuotaToastShown();
          }
          await sleep3(softQuotaWaitMs, abortSignal);
          continue;
        }
        const strictWait = !allowQuotaFallback;
        const waitMs = accountManager.getMinWaitTimeForFamily(
          family,
          model,
          preferredHeaderStyle,
          strictWait
        ) || 6e4;
        pushDebug(
          `all-rate-limited family=${family} accounts=${accountCount} waitMs=${waitMs}`
        );
        if (isDebugEnabled()) {
          logAccountContext("All accounts rate-limited", {
            index: -1,
            family,
            totalAccounts: accountCount
          });
          logRateLimitSnapshot(family, accountManager.getAccountsSnapshot());
        }
        const maxWaitMs = (config.max_rate_limit_wait_seconds ?? 300) * 1e3;
        if (maxWaitMs > 0 && waitMs > maxWaitMs) {
          const waitTimeFormatted = formatWaitTime2(waitMs);
          await showToast(
            `Rate limited for ${waitTimeFormatted}. Try again later or add another account.`,
            "error"
          );
          return createSyntheticErrorResponse(
            `All ${accountCount} account(s) rate-limited for ${family}. Quota resets in ${waitTimeFormatted}. Add more accounts with \`opencode auth login\` or wait and retry.`,
            model ?? "unknown"
          );
        }
        if (!retryState.rateLimitToastShown()) {
          const waitSecValue = Math.max(1, Math.ceil(waitMs / 1e3));
          await showToast(
            `All ${accountCount} account(s) rate-limited for ${family}. Waiting ${waitSecValue}s...`,
            "warning"
          );
          retryState.markRateLimitToastShown();
        }
        await sleep3(waitMs, abortSignal);
        continue;
      }
      retryState.resetAllAccountsBlockedToasts();
      pushDebug(
        `selected idx=${account.index} email=${account.email ?? ""} family=${family} accounts=${accountCount} strategy=${config.account_selection_strategy}`
      );
      if (previousAccountIndex >= 0 && previousAccountIndex !== account.index) {
        needsCacheWarmup = config.cache_warmup_on_switch;
        pushDebug(
          `account-switch: ${previousAccountIndex} \u2192 ${account.index}, warmup=${needsCacheWarmup}`
        );
      }
      previousAccountIndex = account.index;
      accountManager.recordSessionUsage(account.index, accountSessionIdentity);
      if (isDebugEnabled()) {
        logAccountContext("Selected", {
          index: account.index,
          email: account.email,
          family,
          totalAccounts: accountCount,
          rateLimitState: account.rateLimitResetTimes
        });
      }
      if (accountCount > 1 && accountManager.shouldShowAccountToast(account.index)) {
        const accountLabel = account.email || `Account ${account.index + 1}`;
        const enabledAccounts = accountManager.getEnabledAccounts();
        const enabledPosition = enabledAccounts.findIndex((a) => a.index === account.index) + 1;
        await showToast(
          `Using ${accountLabel} (${enabledPosition}/${accountCount})`,
          "info"
        );
        accountManager.markToastShown(account.index);
      }
      accountManager.requestSaveToDisk();
      let authRecord = accountManager.toAuthDetails(account);
      if (accessTokenExpired(authRecord)) {
        try {
          const refreshed = await refreshAccessToken(
            authRecord,
            client,
            providerId
          );
          if (!refreshed) {
            const { failures, shouldCooldown, cooldownMs } = retryState.trackAccountFailure(account.index);
            getHealthTracker().recordFailure(account.index);
            lastError = new Error("Antigravity token refresh failed");
            if (shouldCooldown) {
              accountManager.markAccountCoolingDown(
                account,
                cooldownMs,
                "auth-failure"
              );
              accountManager.markRateLimited(
                account,
                cooldownMs,
                family,
                "antigravity",
                model
              );
              pushDebug(
                `token-refresh-failed: cooldown ${cooldownMs}ms after ${failures} failures`
              );
            }
            continue;
          }
          retryState.resetAccountFailureState(account.index);
          accountManager.updateFromAuth(account, refreshed);
          authRecord = refreshed;
          try {
            await accountManager.saveToDisk();
          } catch (error) {
            log15.error("Failed to persist refreshed auth", {
              error: String(error)
            });
          }
        } catch (error) {
          if (error instanceof AntigravityTokenRefreshError && error.code === "invalid_grant") {
            const removed = accountManager.removeAccount(account);
            if (removed) {
              log15.warn(
                "Removed revoked account from pool - reauthenticate via `opencode auth login`"
              );
              try {
                await accountManager.saveToDiskReplace();
              } catch (persistError) {
                log15.error("Failed to persist revoked account removal", {
                  error: String(persistError)
                });
              }
            }
            if (accountManager.getAccountCount() === 0) {
              try {
                await client.auth.set({
                  path: { id: providerId },
                  body: { type: "oauth", refresh: "", access: "", expires: 0 }
                });
              } catch (storeError) {
                log15.error(
                  "Failed to clear stored Antigravity OAuth credentials",
                  {
                    error: String(storeError)
                  }
                );
              }
              return createNoAccountResponse(
                "All Antigravity accounts have invalid refresh tokens. Run `opencode auth login` and reauthenticate.",
                model ?? "unknown"
              );
            }
            lastError = error;
            continue;
          }
          const { failures, shouldCooldown, cooldownMs } = retryState.trackAccountFailure(account.index);
          getHealthTracker().recordFailure(account.index);
          lastError = error instanceof Error ? error : new Error(String(error));
          if (shouldCooldown) {
            accountManager.markAccountCoolingDown(
              account,
              cooldownMs,
              "auth-failure"
            );
            accountManager.markRateLimited(
              account,
              cooldownMs,
              family,
              "antigravity",
              model
            );
            pushDebug(
              `token-refresh-error: cooldown ${cooldownMs}ms after ${failures} failures`
            );
          }
          continue;
        }
      }
      const accessToken = authRecord.access;
      if (!accessToken) {
        lastError = new Error("Missing access token");
        if (accountCount <= 1) {
          return createSyntheticErrorResponse(
            "Missing access token. Run `opencode auth login` to reauthenticate.",
            model ?? "unknown"
          );
        }
        continue;
      }
      let projectContext;
      try {
        projectContext = await ensureProjectContext(authRecord);
        retryState.resetAccountFailureState(account.index);
      } catch (error) {
        const { failures, shouldCooldown, cooldownMs } = retryState.trackAccountFailure(account.index);
        getHealthTracker().recordFailure(account.index);
        lastError = error instanceof Error ? error : new Error(String(error));
        if (shouldCooldown) {
          accountManager.markAccountCoolingDown(
            account,
            cooldownMs,
            "project-error"
          );
          accountManager.markRateLimited(
            account,
            cooldownMs,
            family,
            "antigravity",
            model
          );
          pushDebug(
            `project-context-error: cooldown ${cooldownMs}ms after ${failures} failures`
          );
        }
        continue;
      }
      if (projectContext.auth.refresh !== authRecord.refresh || projectContext.auth.access !== authRecord.access) {
        accountManager.updateFromAuth(account, projectContext.auth);
        authRecord = projectContext.auth;
        try {
          await accountManager.saveToDisk();
        } catch (error) {
          log15.error("Failed to persist project context", {
            error: String(error)
          });
        }
      }
      const runThinkingWarmup = async (prepared, projectId) => {
        if (!config.thinking_warmup) return;
        if (!prepared.needsSignedThinkingWarmup || !prepared.sessionId) return;
        if (!warmupState.trackAttempt(prepared.sessionId)) return;
        const warmupBody = buildThinkingWarmupBody(
          typeof prepared.init.body === "string" ? prepared.init.body : void 0,
          Boolean(
            prepared.effectiveModel?.toLowerCase().includes("claude") && prepared.effectiveModel?.toLowerCase().includes("thinking")
          )
        );
        if (!warmupBody) return;
        const warmupUrl = toWarmupStreamUrl(prepared.request);
        const warmupHeaders = new Headers(prepared.init.headers ?? {});
        warmupHeaders.set("accept", "text/event-stream");
        const warmupInit = {
          ...prepared.init,
          method: prepared.init.method ?? "POST",
          headers: warmupHeaders,
          body: warmupBody
        };
        const warmupDebugContext = startAntigravityDebugRequest({
          originalUrl: warmupUrl,
          resolvedUrl: warmupUrl,
          method: warmupInit.method,
          headers: warmupHeaders,
          body: warmupBody,
          streaming: true,
          projectId
        });
        try {
          pushDebug("thinking-warmup: start");
          const warmupResponse = prepared.headerStyle === "antigravity" ? await transport(warmupUrl, warmupInit, {
            signal: abortSignal,
            onDebug: pushDebug
          }) : await upstreamFetch(warmupUrl, warmupInit);
          const transformed = await transformAntigravityResponse(
            warmupResponse,
            true,
            warmupDebugContext,
            prepared.requestedModel,
            projectId,
            warmupUrl,
            prepared.effectiveModel,
            prepared.sessionId
          );
          await transformed.text();
          warmupState.markSuccess(prepared.sessionId);
          pushDebug("thinking-warmup: done");
        } catch (error) {
          warmupState.clearWarmupAttempt(prepared.sessionId);
          pushDebug(
            `thinking-warmup: failed ${error instanceof Error ? error.message : String(error)}`
          );
        }
      };
      const runCacheWarmupProbe = async (prepared) => {
        if (!needsCacheWarmup) return;
        needsCacheWarmup = false;
        const bodyStr = typeof prepared.init.body === "string" ? prepared.init.body : void 0;
        if (!bodyStr) return;
        try {
          pushDebug("cache-warmup-probe: start");
          const probeInit = {
            ...prepared.init,
            method: "POST",
            body: bodyStr
          };
          const probeResponse = prepared.headerStyle === "antigravity" ? await transport(toUrlString(prepared.request), probeInit, {
            signal: abortSignal,
            onDebug: pushDebug
          }) : await upstreamFetch(toUrlString(prepared.request), probeInit);
          if (probeResponse.body) {
            const reader = probeResponse.body.getReader();
            await reader.read();
            await reader.cancel();
          }
          const status = probeResponse.status;
          if (status >= 400) {
            let errorSnippet = "";
            try {
              const errText = await probeResponse.text().catch(() => "");
              errorSnippet = errText.slice(0, 200);
            } catch {
            }
            pushDebug(
              `cache-warmup-probe: done status=${status}${errorSnippet ? ` error=${errorSnippet}` : ""}`
            );
          } else {
            pushDebug(
              `cache-warmup-probe: done status=${status} (aborted after first chunk)`
            );
          }
        } catch (error) {
          pushDebug(
            `cache-warmup-probe: failed ${error instanceof Error ? error.message : String(error)}`
          );
        }
      };
      let apiRequestCount = 0;
      let shouldSwitchAccount = false;
      let headerStyle = preferredHeaderStyle;
      pushDebug(`headerStyle=${headerStyle} explicit=${explicitQuota}`);
      if (account.fingerprint) {
        pushDebug(
          `fingerprint: deviceId=${account.fingerprint.deviceId.slice(0, 8)}...`
        );
      }
      if (accountManager.isRateLimitedForHeaderStyle(
        account,
        family,
        headerStyle,
        model
      )) {
        if (allowQuotaFallback && family === "gemini" && headerStyle === "antigravity") {
          if (accountManager.hasOtherAccountWithAntigravityAvailable(
            account.index,
            family,
            model
          )) {
            pushDebug(
              `antigravity rate-limited on account ${account.index}, but available on other accounts. Switching.`
            );
            shouldSwitchAccount = true;
          } else {
            const alternateStyle = accountManager.getAvailableHeaderStyle(
              account,
              family,
              model
            );
            const fallbackStyle = resolveQuotaFallbackHeaderStyle({
              family,
              headerStyle,
              alternateStyle
            });
            if (fallbackStyle) {
              await showToast(
                `Antigravity quota exhausted on all accounts. Using Gemini CLI quota.`,
                "warning"
              );
              headerStyle = fallbackStyle;
              pushDebug(
                `all-accounts antigravity exhausted, quota fallback: ${headerStyle}`
              );
            } else {
              shouldSwitchAccount = true;
            }
          }
        } else if (allowQuotaFallback && family === "gemini") {
          const alternateStyle = accountManager.getAvailableHeaderStyle(
            account,
            family,
            model
          );
          const fallbackStyle = resolveQuotaFallbackHeaderStyle({
            family,
            headerStyle,
            alternateStyle
          });
          if (fallbackStyle) {
            const quotaName = headerStyle === "gemini-cli" ? "Gemini CLI" : "Antigravity";
            const altQuotaName = fallbackStyle === "gemini-cli" ? "Gemini CLI" : "Antigravity";
            await showToast(
              `${quotaName} quota exhausted, using ${altQuotaName} quota`,
              "warning"
            );
            headerStyle = fallbackStyle;
            pushDebug(`quota fallback: ${headerStyle}`);
          } else {
            shouldSwitchAccount = true;
          }
        } else {
          shouldSwitchAccount = true;
        }
      }
      let totalCapacityRetries = 0;
      while (!shouldSwitchAccount) {
        let forceThinkingRecovery = false;
        let tokenConsumed = false;
        let capacityRetryCount = 0;
        let lastEndpointIndex = -1;
        for (let i = 0; i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length; i++) {
          if (i !== lastEndpointIndex) {
            capacityRetryCount = 0;
            lastEndpointIndex = i;
          }
          const currentEndpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[i];
          if (headerStyle === "gemini-cli" && currentEndpoint !== "https://cloudcode-pa.googleapis.com") {
            pushDebug(
              `Skipping sandbox endpoint ${currentEndpoint} for gemini-cli headerStyle`
            );
            continue;
          }
          try {
            const prepared = prepareAntigravityRequest(
              input2,
              init,
              accessToken,
              projectContext.effectiveProjectId,
              currentEndpoint,
              headerStyle,
              forceThinkingRecovery,
              {
                claudeToolHardening: config.claude_tool_hardening,
                claudePromptAutoCaching: config.claude_prompt_auto_caching,
                fingerprint: account.fingerprint,
                agySession: agyRequestSession,
                agyRequestTimestamp: agyRequestScope.timestamp
              }
            );
            const originalUrl = toUrlString(input2);
            const resolvedUrl = toUrlString(prepared.request);
            pushDebug(`endpoint=${currentEndpoint}`);
            pushDebug(`resolved=${resolvedUrl}`);
            const debugContext = startAntigravityDebugRequest({
              originalUrl,
              resolvedUrl,
              method: prepared.init.method,
              headers: prepared.init.headers,
              body: prepared.init.body,
              streaming: prepared.streaming,
              projectId: projectContext.effectiveProjectId
            });
            const dumpContext = dumpGeminiRequest({
              originalUrl,
              resolvedUrl,
              method: prepared.init.method,
              headers: prepared.init.headers,
              body: prepared.init.body,
              streaming: prepared.streaming,
              requestedModel: prepared.requestedModel,
              effectiveModel: prepared.effectiveModel,
              sessionId: prepared.sessionId,
              projectId: projectContext.effectiveProjectId
            });
            const createFailureContext = (failureResponse) => ({
              response: failureResponse,
              streaming: prepared.streaming,
              debugContext,
              requestedModel: prepared.requestedModel,
              projectId: prepared.projectId,
              endpoint: prepared.endpoint,
              effectiveModel: prepared.effectiveModel,
              sessionId: prepared.sessionId,
              toolDebugMissing: prepared.toolDebugMissing,
              toolDebugSummary: prepared.toolDebugSummary,
              toolDebugPayload: prepared.toolDebugPayload,
              dumpContext
            });
            await runThinkingWarmup(prepared, projectContext.effectiveProjectId);
            await runCacheWarmupProbe(prepared);
            if (config.request_jitter_max_ms > 0) {
              const jitterMs = Math.floor(
                Math.random() * config.request_jitter_max_ms
              );
              if (jitterMs > 0) {
                await sleep3(jitterMs, abortSignal);
              }
            }
            if (config.account_selection_strategy === "hybrid") {
              tokenConsumed = getTokenTracker().consume(account.index);
            }
            pushDebug(
              `dispatching request via ${prepared.headerStyle} transport`
            );
            const response = prepared.headerStyle === "antigravity" ? await transport(
              toUrlString(prepared.request),
              prepared.init,
              { signal: abortSignal, onDebug: pushDebug }
            ) : await upstreamFetch(prepared.request, prepared.init);
            apiRequestCount++;
            accountManager.recordRequest(account.index, family);
            const requestCounts = accountManager.getDailyRequestCounts(
              account.index
            );
            if (requestCounts) {
              pushDebug(
                `[Quota] account=${account.index} ${family}_today=${requestCounts[family]} total_${family}_today=${accountManager.getTotalDailyRequests(family)}`
              );
            }
            pushDebug(
              `status=${response.status} ${response.statusText} (api_request #${apiRequestCount})`
            );
            noteGeminiDumpResponse(dumpContext, response);
            const sessionKey = requestSessionIdentity.sessionId;
            if (sessionKey) {
              const routingEntry = {
                accountId: `acct-${account.index}`,
                modelFamily: family,
                headerStyle: prepared.headerStyle,
                strategy: config.account_selection_strategy,
                updatedAt: Date.now()
              };
              void upsertSidebarActiveRouting(sessionKey, routingEntry, {
                authoritative: true
              }).catch((error) => {
                log15.debug("sidebar-routing-upsert-failed", {
                  sessionId: sessionKey,
                  error: String(error)
                });
              });
            }
            if (response.status === 429 || response.status === 503 || response.status === 529) {
              if (tokenConsumed) {
                getTokenTracker().refund(account.index);
                tokenConsumed = false;
              }
              const defaultRetryMs = (config.default_retry_after_seconds ?? 60) * 1e3;
              const _maxBackoffMs = (config.max_backoff_seconds ?? 60) * 1e3;
              const headerRetryMs = retryAfterMsFromResponse(
                response,
                defaultRetryMs
              );
              const bodyInfo = await (async () => {
                try {
                  const text = await response.clone().text();
                  try {
                    return JSON.parse(text);
                  } catch {
                    return null;
                  }
                } catch {
                  return null;
                }
              })();
              const reasonInfo = bodyInfo ? extractRateLimitBodyInfo(bodyInfo) : { retryDelayMs: null };
              const serverRetryMs = reasonInfo.retryDelayMs ?? headerRetryMs;
              const rateLimitReason = parseRateLimitReason(
                reasonInfo.reason,
                reasonInfo.message,
                response.status
              );
              if (rateLimitReason === "MODEL_CAPACITY_EXHAUSTED" || rateLimitReason === "SERVER_ERROR") {
                totalCapacityRetries++;
                if (isCapacityRetryBudgetExhausted(totalCapacityRetries)) {
                  pushDebug(
                    `Total capacity retries (${MAX_TOTAL_CAPACITY_RETRIES}) exhausted, switching account`
                  );
                  lastFailure = createFailureContext(response);
                  shouldSwitchAccount = true;
                  break;
                }
                const baseDelayMs = 1e3;
                const maxDelayMs = 8e3;
                const exponentialDelay = Math.min(
                  baseDelayMs * 2 ** capacityRetryCount,
                  maxDelayMs
                );
                const jitter = exponentialDelay * (0.9 + Math.random() * 0.2);
                const waitMs = Math.round(jitter);
                const waitSec = Math.round(waitMs / 1e3);
                pushDebug(
                  `Server busy (${rateLimitReason}) on account ${account.index}, exponential backoff ${waitMs}ms (attempt ${capacityRetryCount + 1}, total ${totalCapacityRetries}/${MAX_TOTAL_CAPACITY_RETRIES})`
                );
                await showToast(
                  `\u23F3 Server busy (${response.status}). Retrying in ${waitSec}s...`,
                  "warning"
                );
                await sleep3(waitMs, abortSignal);
                if (capacityRetryCount < 1) {
                  capacityRetryCount++;
                  i -= 1;
                  continue;
                } else {
                  pushDebug(
                    `Max capacity retries (1) exhausted for endpoint ${currentEndpoint}, regenerating fingerprint...`
                  );
                  const newFingerprint = accountManager.regenerateAccountFingerprint(account.index);
                  if (newFingerprint) {
                    pushDebug(
                      `Fingerprint regenerated for account ${account.index}`
                    );
                  }
                  continue;
                }
              }
              const quotaKey2 = retryState.headerStyleToQuotaKey(
                headerStyle,
                family
              );
              const backoff = retryState.getRateLimitBackoff(
                account.index,
                quotaKey2,
                serverRetryMs
              );
              const smartBackoffMs = calculateBackoffMs(
                rateLimitReason,
                account.consecutiveFailures ?? 0,
                serverRetryMs
              );
              const effectiveDelayMs = Math.max(backoff.delayMs, smartBackoffMs);
              pushDebug(
                `429 idx=${account.index} email=${account.email ?? ""} family=${family} delayMs=${effectiveDelayMs} attempt=${backoff.attempt} reason=${rateLimitReason}`
              );
              if (reasonInfo.message)
                pushDebug(`429 message=${reasonInfo.message}`);
              if (reasonInfo.quotaResetTime)
                pushDebug(`429 quotaResetTime=${reasonInfo.quotaResetTime}`);
              if (reasonInfo.reason)
                pushDebug(`429 reason=${reasonInfo.reason}`);
              logRateLimitEvent(
                account.index,
                account.email,
                family,
                response.status,
                effectiveDelayMs,
                reasonInfo
              );
              await logResponseBody(debugContext, response, 429);
              getHealthTracker().recordRateLimit(account.index);
              const _accountLabel = account.email || `Account ${account.index + 1}`;
              if (backoff.attempt === 1 && rateLimitReason !== "QUOTA_EXHAUSTED") {
                await showToast(`Rate limited. Quick retry in 1s...`, "warning");
                await sleep3(FIRST_RETRY_DELAY_MS, abortSignal);
                if (config.scheduling_mode === "cache_first") {
                  const maxCacheFirstWaitMs = config.max_cache_first_wait_seconds * 1e3;
                  if (effectiveDelayMs <= maxCacheFirstWaitMs) {
                    pushDebug(
                      `cache_first: waiting ${effectiveDelayMs}ms for same account to recover`
                    );
                    await showToast(
                      `\u23F3 Waiting ${Math.ceil(effectiveDelayMs / 1e3)}s for same account (prompt cache preserved)...`,
                      "info"
                    );
                    accountManager.markRateLimitedWithReason(
                      account,
                      family,
                      headerStyle,
                      model,
                      rateLimitReason,
                      serverRetryMs
                    );
                    await sleep3(effectiveDelayMs, abortSignal);
                    i -= 1;
                    continue;
                  }
                  pushDebug(
                    `cache_first: wait ${effectiveDelayMs}ms exceeds max ${maxCacheFirstWaitMs}ms, switching account`
                  );
                }
                if (config.switch_on_first_rate_limit && accountCount > 1) {
                  accountManager.markRateLimitedWithReason(
                    account,
                    family,
                    headerStyle,
                    model,
                    rateLimitReason,
                    serverRetryMs,
                    config.failure_ttl_seconds * 1e3
                  );
                  shouldSwitchAccount = true;
                  break;
                }
                i -= 1;
                continue;
              }
              accountManager.markRateLimitedWithReason(
                account,
                family,
                headerStyle,
                model,
                rateLimitReason,
                serverRetryMs,
                config.failure_ttl_seconds * 1e3
              );
              accountManager.requestSaveToDisk();
              const switchAccountDelayMs = config.switch_account_delay_ms ?? 500;
              if (family === "gemini") {
                if (headerStyle === "antigravity") {
                  if (hasOtherAccountWithAntigravity(account)) {
                    pushDebug(
                      `antigravity exhausted on account ${account.index}, but available on others. Switching account.`
                    );
                    await showToast(
                      `Rate limited again. Switching account in ${formatWaitTime2(switchAccountDelayMs)}...`,
                      "warning"
                    );
                    await sleep3(switchAccountDelayMs, abortSignal);
                    shouldSwitchAccount = true;
                    break;
                  }
                  if (allowQuotaFallback) {
                    const alternateStyle = accountManager.getAvailableHeaderStyle(
                      account,
                      family,
                      model
                    );
                    const fallbackStyle = resolveQuotaFallbackHeaderStyle({
                      family,
                      headerStyle,
                      alternateStyle
                    });
                    if (fallbackStyle) {
                      const safeModelName = model || "this model";
                      await showToast(
                        `Antigravity quota exhausted for ${safeModelName}. Switching to Gemini CLI quota...`,
                        "warning"
                      );
                      headerStyle = fallbackStyle;
                      pushDebug(`quota fallback: ${headerStyle}`);
                      continue;
                    }
                  }
                } else if (headerStyle === "gemini-cli") {
                  if (allowQuotaFallback) {
                    const alternateStyle = accountManager.getAvailableHeaderStyle(
                      account,
                      family,
                      model
                    );
                    const fallbackStyle = resolveQuotaFallbackHeaderStyle({
                      family,
                      headerStyle,
                      alternateStyle
                    });
                    if (fallbackStyle) {
                      const safeModelName = model || "this model";
                      await showToast(
                        `Gemini CLI quota exhausted for ${safeModelName}. Switching to Antigravity quota...`,
                        "warning"
                      );
                      headerStyle = fallbackStyle;
                      pushDebug(`quota fallback: ${headerStyle}`);
                      continue;
                    }
                  }
                }
              }
              if (accountCount > 1) {
                const quotaMsg = reasonInfo.quotaResetTime ? ` (quota resets ${reasonInfo.quotaResetTime})` : ``;
                await showToast(
                  `Rate limited again. Switching account in ${formatWaitTime2(switchAccountDelayMs)}...${quotaMsg}`,
                  "warning"
                );
                await sleep3(switchAccountDelayMs, abortSignal);
              } else {
                const expBackoffMs = Math.min(
                  FIRST_RETRY_DELAY_MS * 2 ** (backoff.attempt - 1),
                  6e4
                );
                const expBackoffFormatted = expBackoffMs >= 1e3 ? `${Math.round(expBackoffMs / 1e3)}s` : `${expBackoffMs}ms`;
                await showToast(
                  `Rate limited. Retrying in ${expBackoffFormatted} (attempt ${backoff.attempt})...`,
                  "warning"
                );
                await sleep3(expBackoffMs, abortSignal);
              }
              lastFailure = createFailureContext(response);
              shouldSwitchAccount = true;
              break;
            }
            const quotaKey = retryState.headerStyleToQuotaKey(
              headerStyle,
              family
            );
            retryState.resetRateLimitState(account.index, quotaKey);
            retryState.resetAccountFailureState(account.index);
            if (response.status === 403) {
              const errorBodyText = await response.clone().text().catch(() => "");
              const extracted = extractAccountAccessErrorDetails(errorBodyText);
              if (extracted.accountIneligible) {
                const ineligibleReason = extracted.message ?? "Google marked this account as ineligible for Antigravity.";
                accountManager.markAccountIneligible(
                  account.index,
                  ineligibleReason
                );
                const label = account.email || `Account ${account.index + 1}`;
                if (accountManager.shouldShowAccountToast(account.index, 6e4)) {
                  await showToast(
                    `${label} is not eligible for Antigravity and has been disabled. Recheck it from opencode auth login > Verify accounts.`,
                    "warning"
                  );
                  accountManager.markToastShown(account.index);
                }
                pushDebug(
                  `account-ineligible: disabled account ${account.index}`
                );
                getHealthTracker().recordFailure(account.index);
                lastFailure = createFailureContext(response);
                shouldSwitchAccount = true;
                break;
              }
              if (extracted.validationRequired) {
                const verificationReason = extracted.message ?? "Google requires account verification.";
                const cooldownMs = 10 * 60 * 1e3;
                accountManager.markAccountVerificationRequired(
                  account.index,
                  verificationReason,
                  extracted.verifyUrl
                );
                accountManager.markAccountCoolingDown(
                  account,
                  cooldownMs,
                  "validation-required"
                );
                accountManager.markRateLimited(
                  account,
                  cooldownMs,
                  family,
                  headerStyle,
                  model
                );
                const label = account.email || `Account ${account.index + 1}`;
                if (accountManager.shouldShowAccountToast(account.index, 6e4)) {
                  await showToast(
                    `\u26A0 ${label} needs verification. Run 'opencode auth login' and use Verify accounts.`,
                    "warning"
                  );
                  accountManager.markToastShown(account.index);
                }
                pushDebug(
                  `verification-required: disabled account ${account.index}`
                );
                getHealthTracker().recordFailure(account.index);
                lastFailure = createFailureContext(response);
                shouldSwitchAccount = true;
                break;
              }
            }
            const shouldRetryEndpoint = response.status === 403 || response.status === 404 || response.status >= 500;
            if (shouldRetryEndpoint && i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
              await logResponseBody(debugContext, response, response.status);
              lastFailure = createFailureContext(response);
              continue;
            }
            if (response.ok) {
              account.consecutiveFailures = 0;
              getHealthTracker().recordSuccess(account.index);
              accountManager.markAccountUsed(account.index);
              void triggerAsyncQuotaRefreshForAccount(
                account.index,
                config.quota_refresh_interval_minutes
              );
              const proactiveThreshold = config.proactive_rotation_threshold_percent ?? 20;
              if (proactiveThreshold > 0 && accountManager.shouldProactivelyRotate(
                family,
                model,
                proactiveThreshold,
                softQuotaCacheTtlMs,
                accountSessionIdentity
              )) {
                const rotated = accountManager.proactivelyRotateForFamily(
                  family,
                  model,
                  headerStyle,
                  config.soft_quota_threshold_percent,
                  softQuotaCacheTtlMs,
                  accountSessionIdentity
                );
                if (rotated) {
                  const remaining = account.cachedQuota?.[resolveQuotaGroup(family, model)]?.remainingFraction;
                  const remainingPct = remaining != null ? `${(remaining * 100).toFixed(1)}%` : "?";
                  pushDebug(
                    `[ProactiveRotation] account ${account.index} quota ${remainingPct} < ${proactiveThreshold}%, pre-switched to account ${rotated.index} for next request`
                  );
                  pushDebug(
                    `[ProactiveRotation] ${account.index} \u2192 ${rotated.index} (warm=${accountManager.wasUsedInSession(rotated.index, accountSessionIdentity)})`
                  );
                }
              }
            }
            logAntigravityDebugResponse(debugContext, response, {
              note: response.ok ? "Success" : `Error ${response.status}`
            });
            if (response.ok && !prepared.streaming) {
              await logResponseBody(debugContext, response, response.status);
            }
            if (!response.ok) {
              await logResponseBody(debugContext, response, response.status);
              if (response.status === 400) {
                const cloned = response.clone();
                const bodyText = await cloned.text();
                if (bodyText.includes("Prompt is too long") || bodyText.includes("prompt_too_long")) {
                  await showToast(
                    "Context too long - use /compact to reduce size",
                    "warning"
                  );
                  const errorMessage = `[Antigravity Error] Context is too long for this model.

Please use /compact to reduce context size, then retry your request.

Alternatively, you can:
- Use /clear to start fresh
- Use /undo to remove recent messages
- Switch to a model with larger context window`;
                  return createSyntheticErrorResponse(
                    errorMessage,
                    prepared.requestedModel
                  );
                }
              }
            }
            if (response.ok && !prepared.streaming) {
              const maxAttempts = config.empty_response_max_attempts ?? 4;
              const retryDelayMs = config.empty_response_retry_delay_ms ?? 2e3;
              const clonedForCheck = response.clone();
              const bodyText = await clonedForCheck.text();
              if (isEmptyResponseBody(bodyText)) {
                const emptyAttemptKey = `${prepared.sessionId ?? "none"}:${prepared.effectiveModel ?? "unknown"}`;
                const currentAttempts = retryState.recordEmptyResponseAttempt(emptyAttemptKey);
                pushDebug(
                  `empty-response: attempt ${currentAttempts}/${maxAttempts}`
                );
                if (currentAttempts < maxAttempts) {
                  await showToast(
                    `Empty response received. Retrying (${currentAttempts}/${maxAttempts})...`,
                    "warning"
                  );
                  await sleep3(retryDelayMs, abortSignal);
                  continue;
                }
                retryState.clearEmptyResponseAttempts();
                return createSyntheticErrorResponse(
                  `Empty response after ${currentAttempts} attempts for model ${prepared.effectiveModel ?? "unknown"}.`,
                  prepared.effectiveModel ?? "unknown"
                );
              }
              const _emptyAttemptKeyClean = `${prepared.sessionId ?? "none"}:${prepared.effectiveModel ?? "unknown"}`;
              retryState.clearEmptyResponseAttempts();
            }
            const transformedResponse = await transformAntigravityResponse(
              response,
              prepared.streaming,
              debugContext,
              prepared.requestedModel,
              prepared.projectId,
              prepared.endpoint,
              prepared.effectiveModel,
              prepared.sessionId,
              prepared.toolDebugMissing,
              prepared.toolDebugSummary,
              prepared.toolDebugPayload,
              debugLines,
              dumpContext
            );
            const contextError = transformedResponse.headers.get(
              "x-antigravity-context-error"
            );
            if (contextError) {
              if (contextError === "prompt_too_long") {
                await showToast(
                  "Context too long - use /compact to reduce size, or trim your request",
                  "warning"
                );
              } else if (contextError === "tool_pairing") {
                await showToast(
                  "Tool call/result mismatch - use /compact to fix, or /undo last message",
                  "warning"
                );
              }
            }
            if (apiRequestCount > 1) {
              pushDebug(
                `[Quota] Total API requests for this user message: ${apiRequestCount} (${apiRequestCount - 1} retries)`
              );
            }
            const dailyCounts = accountManager.getDailyRequestCounts(
              account.index
            );
            if (dailyCounts) {
              pushDebug(
                `[Quota] Account ${account.index} (${account.email ?? "unknown"}) today: claude=${dailyCounts.claude} gemini=${dailyCounts.gemini}`
              );
            }
            const totalToday = accountManager.getTotalDailyRequests(family);
            pushDebug(
              `[Quota] Total ${family} requests today (all accounts): ${totalToday}`
            );
            const cachedQuota = account.cachedQuota;
            if (cachedQuota) {
              const quotaFamily = resolveQuotaGroup(family, model);
              const groupQuota = cachedQuota[quotaFamily];
              if (groupQuota?.remainingFraction != null) {
                const pct = Math.round(groupQuota.remainingFraction * 100);
                pushDebug(
                  `[Quota] Account ${account.index} cached ${quotaFamily} remaining: ${pct}%${groupQuota.resetTime ? ` (resets ${groupQuota.resetTime})` : ""}`
                );
              }
            }
            const sessionSummary = accountManager.getSessionSummary();
            if (sessionSummary.durationMinutes >= 1) {
              const familyTotal = family === "claude" ? sessionSummary.totalClaude : sessionSummary.totalGemini;
              if (familyTotal > 0) {
                const ratePerHour = sessionSummary.requestsPerHour;
                pushDebug(
                  `[Quota] Session: ${sessionSummary.durationMinutes}min, ${familyTotal} ${family} reqs, ~${ratePerHour} reqs/hr, ${sessionSummary.accountsUsed} accounts used`
                );
              }
            }
            return transformedResponse;
          } catch (error) {
            if (tokenConsumed) {
              getTokenTracker().refund(account.index);
              tokenConsumed = false;
            }
            if (error instanceof Error && error.message === "THINKING_RECOVERY_NEEDED") {
              if (!forceThinkingRecovery) {
                pushDebug(
                  "thinking-recovery: API error detected, retrying with forced recovery"
                );
                forceThinkingRecovery = true;
                i = -1;
                continue;
              }
              const recoveryError = error;
              const originalError = recoveryError.originalError || {
                error: { message: "Thinking recovery triggered" }
              };
              const recoveryMessage = `${originalError.error?.message || "Session recovery failed"}

[RECOVERY] Thinking block corruption could not be resolved. Try starting a new session.`;
              return new Response(
                JSON.stringify({
                  type: "error",
                  error: {
                    type: "unrecoverable_error",
                    message: recoveryMessage
                  }
                }),
                {
                  status: 400,
                  headers: { "Content-Type": "application/json" }
                }
              );
            }
            if (i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
              lastError = error instanceof Error ? error : new Error(String(error));
              continue;
            }
            const { failures, shouldCooldown, cooldownMs } = retryState.trackAccountFailure(account.index);
            lastError = error instanceof Error ? error : new Error(String(error));
            if (shouldCooldown) {
              accountManager.markAccountCoolingDown(
                account,
                cooldownMs,
                "network-error"
              );
              accountManager.markRateLimited(
                account,
                cooldownMs,
                family,
                headerStyle,
                model
              );
              pushDebug(
                `endpoint-error: cooldown ${cooldownMs}ms after ${failures} failures`
              );
            }
            shouldSwitchAccount = true;
            break;
          }
        }
      }
      if (shouldSwitchAccount) {
        accountSwitchCount++;
        if (accountSwitchCount > maxAccountSwitches) {
          pushDebug(
            `account-switch-cap: exceeded max_account_switches=${maxAccountSwitches}, giving up`
          );
          if (lastFailure) {
            return transformAntigravityResponse(
              lastFailure.response,
              lastFailure.streaming,
              lastFailure.debugContext,
              lastFailure.requestedModel,
              lastFailure.projectId,
              lastFailure.endpoint,
              lastFailure.effectiveModel,
              lastFailure.sessionId,
              lastFailure.toolDebugMissing,
              lastFailure.toolDebugSummary,
              lastFailure.toolDebugPayload,
              debugLines,
              lastFailure.dumpContext
            );
          }
          throw terminalFetchError(
            lastError,
            `Exceeded max account switches (${maxAccountSwitches}). All accounts rate-limited.`
          );
        }
        if (accountCount <= 1) {
          if (lastFailure) {
            return transformAntigravityResponse(
              lastFailure.response,
              lastFailure.streaming,
              lastFailure.debugContext,
              lastFailure.requestedModel,
              lastFailure.projectId,
              lastFailure.endpoint,
              lastFailure.effectiveModel,
              lastFailure.sessionId,
              lastFailure.toolDebugMissing,
              lastFailure.toolDebugSummary,
              lastFailure.toolDebugPayload,
              debugLines,
              lastFailure.dumpContext
            );
          }
          throw terminalFetchError(
            lastError,
            "All Antigravity endpoints failed"
          );
        }
        continue;
      }
      if (lastFailure) {
        return transformAntigravityResponse(
          lastFailure.response,
          lastFailure.streaming,
          lastFailure.debugContext,
          lastFailure.requestedModel,
          lastFailure.projectId,
          lastFailure.endpoint,
          lastFailure.effectiveModel,
          lastFailure.sessionId,
          lastFailure.toolDebugMissing,
          lastFailure.toolDebugSummary,
          lastFailure.toolDebugPayload,
          debugLines,
          lastFailure.dumpContext
        );
      }
      throw terminalFetchError(lastError, "All Antigravity accounts failed");
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    retryState.dispose();
    warmupState.dispose();
  }
  return { fetch, dispose };
}
function extractRateLimitBodyInfo(body) {
  if (!body || typeof body !== "object") return { retryDelayMs: null };
  const error = body.error;
  const message = error && typeof error === "object" ? error.message : void 0;
  const details = error && typeof error === "object" ? error.details : void 0;
  let reason;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const type = detail["@type"];
      if (typeof type === "string" && type.includes("google.rpc.ErrorInfo")) {
        const detailReason = detail.reason;
        if (typeof detailReason === "string") {
          reason = detailReason;
          break;
        }
      }
    }
    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const type = detail["@type"];
      if (typeof type === "string" && type.includes("google.rpc.RetryInfo")) {
        const retryDelay = detail.retryDelay;
        if (typeof retryDelay === "string") {
          const retryDelayMs = parseDurationToMs(retryDelay);
          if (retryDelayMs !== null) {
            return { retryDelayMs, message, reason };
          }
        }
      }
    }
    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const metadata = detail.metadata;
      if (metadata && typeof metadata === "object") {
        const quotaResetDelay = metadata.quotaResetDelay;
        const quotaResetTime = metadata.quotaResetTimeStamp;
        if (typeof quotaResetDelay === "string") {
          const quotaResetDelayMs = parseDurationToMs(quotaResetDelay);
          if (quotaResetDelayMs !== null) {
            return {
              retryDelayMs: quotaResetDelayMs,
              message,
              quotaResetTime,
              reason
            };
          }
        }
      }
    }
  }
  if (message) {
    const afterMatch = message.match(/reset after\s+([0-9hms.]+)/i);
    const rawDuration = afterMatch?.[1];
    if (rawDuration) {
      const parsed = parseDurationToMs(rawDuration);
      if (parsed !== null) {
        return { retryDelayMs: parsed, message, reason };
      }
    }
  }
  return { retryDelayMs: null, message, reason };
}
function parseDurationToMs(duration) {
  const simpleMatch = duration.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (simpleMatch) {
    const value = parseFloat(simpleMatch[1]);
    const unit = (simpleMatch[2] || "s").toLowerCase();
    switch (unit) {
      case "h":
        return value * 3600 * 1e3;
      case "m":
        return value * 60 * 1e3;
      case "s":
        return value * 1e3;
      case "ms":
        return value;
      default:
        return value * 1e3;
    }
  }
  const compoundRegex = /(\d+(?:\.\d+)?)(h|m(?!s)|s|ms)/gi;
  let totalMs = 0;
  let matchFound = false;
  let match = null;
  while (true) {
    match = compoundRegex.exec(duration);
    if (match === null) break;
    matchFound = true;
    const value = parseFloat(match[1]);
    const unit = match[2]?.toLowerCase();
    switch (unit) {
      case "h":
        totalMs += value * 3600 * 1e3;
        break;
      case "m":
        totalMs += value * 60 * 1e3;
        break;
      case "s":
        totalMs += value * 1e3;
        break;
      case "ms":
        totalMs += value;
        break;
    }
  }
  return matchFound ? totalMs : null;
}

// ../../node_modules/.bun/@opencode-ai+plugin@1.17.13+b766ee0bec30d060/node_modules/@opencode-ai/plugin/dist/tool.js
import { z as z5 } from "zod";
function tool(input2) {
  return input2;
}
tool.schema = z5;

// src/plugin/search.ts
import crypto3 from "node:crypto";
var log16 = createLogger2("search");
var sessionCounter = 0;
var sessionPrefix = `search-${Date.now().toString(36)}`;
function generateRequestId() {
  return `agent/${crypto3.randomUUID()}/${Date.now()}/${crypto3.randomUUID()}/2`;
}
function getSessionId() {
  sessionCounter++;
  return `${sessionPrefix}-${sessionCounter}`;
}
function formatSearchResult(result) {
  const lines = [];
  lines.push("## Search Results\n");
  lines.push(result.text);
  lines.push("");
  if (result.sources.length > 0) {
    lines.push("### Sources");
    for (const source of result.sources) {
      lines.push(`- [${source.title}](${source.url})`);
    }
    lines.push("");
  }
  if (result.urlsRetrieved.length > 0) {
    lines.push("### URLs Retrieved");
    for (const url of result.urlsRetrieved) {
      const status = url.status === "URL_RETRIEVAL_STATUS_SUCCESS" ? "\u2713" : "\u2717";
      lines.push(`- ${status} ${url.url}`);
    }
    lines.push("");
  }
  if (result.searchQueries.length > 0) {
    lines.push("### Search Queries Used");
    for (const q of result.searchQueries) {
      lines.push(`- "${q}"`);
    }
  }
  return lines.join("\n");
}
function parseSearchResponse(data) {
  const result = {
    text: "",
    sources: [],
    searchQueries: [],
    urlsRetrieved: []
  };
  const response = data.response;
  if (!response?.candidates || response.candidates.length === 0) {
    if (data.error) {
      result.text = `Error: ${data.error.message ?? "Unknown error"}`;
    } else if (response?.error) {
      result.text = `Error: ${response.error.message ?? "Unknown error"}`;
    }
    return result;
  }
  const candidate = response.candidates[0];
  if (!candidate) {
    return result;
  }
  if (candidate.content?.parts) {
    result.text = candidate.content.parts.map((p) => p.text ?? "").filter(Boolean).join("\n");
  }
  if (candidate.groundingMetadata) {
    const groundingMeta = candidate.groundingMetadata;
    if (groundingMeta.webSearchQueries) {
      result.searchQueries = groundingMeta.webSearchQueries;
    }
    if (groundingMeta.groundingChunks) {
      for (const chunk of groundingMeta.groundingChunks) {
        if (chunk.web?.uri && chunk.web?.title) {
          result.sources.push({
            title: chunk.web.title,
            url: chunk.web.uri
          });
        }
      }
    }
  }
  if (candidate.urlContextMetadata?.url_metadata) {
    for (const meta of candidate.urlContextMetadata.url_metadata) {
      if (meta.retrieved_url) {
        result.urlsRetrieved.push({
          url: meta.retrieved_url,
          status: meta.url_retrieval_status ?? "UNKNOWN"
        });
      }
    }
  }
  return result;
}
async function executeSearch(args, accessToken, projectId, abortSignal) {
  const { query, urls, thinking = true } = args;
  let prompt = query;
  if (urls && urls.length > 0) {
    const urlList = urls.join("\n");
    prompt = `${query}

URLs to analyze:
${urlList}`;
  }
  const tools = [];
  tools.push({ googleSearch: {} });
  if (urls && urls.length > 0) {
    tools.push({ urlContext: {} });
  }
  const requestPayload = {
    systemInstruction: {
      parts: [{ text: SEARCH_SYSTEM_INSTRUCTION }]
    },
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    tools,
    generationConfig: {
      temperature: 0,
      topP: 1
    }
  };
  const wrappedBody = {
    project: projectId,
    requestId: generateRequestId(),
    request: {
      ...requestPayload,
      sessionId: getSessionId()
    },
    model: SEARCH_MODEL,
    userAgent: "antigravity",
    requestType: "agent"
  };
  const url = `${ANTIGRAVITY_ENDPOINT}/v1internal:generateContent`;
  log16.debug("Executing search", {
    query,
    urlCount: urls?.length ?? 0,
    thinking
  });
  try {
    const fingerprintHeaders = buildFingerprintHeaders(getSessionFingerprint());
    const response = await fetchWithAgyCliTransport(
      url,
      {
        method: "POST",
        headers: {
          "User-Agent": fingerprintHeaders["User-Agent"] ?? getSessionFingerprint().userAgent,
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Accept-Encoding": "gzip"
        },
        body: JSON.stringify(wrappedBody)
      },
      { signal: abortSignal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS) }
    );
    if (!response.ok) {
      const errorText = await response.text();
      log16.debug("Search API error", {
        status: response.status,
        error: errorText
      });
      return `## Search Error

Failed to execute search: ${response.status} ${response.statusText}

${errorText}

Please try again with a different query.`;
    }
    const data = await response.json();
    log16.debug("Search response received", { hasResponse: !!data.response });
    const result = parseSearchResponse(data);
    const formatted = formatSearchResult(result);
    log16.debug("Search response formatted", { resultLength: formatted.length });
    return formatted;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log16.debug("Search execution error", { error: message });
    return `## Search Error

Failed to execute search: ${message}. Please try again with a different query.`;
  }
}

// src/plugin/google-search-tool.ts
var log17 = createLogger2("plugin");
function createGoogleSearchTool({
  getAuth,
  client,
  providerId
}) {
  return tool({
    description: "Search the web using Google Search and analyze URLs. Returns real-time information from the internet with source citations. Use this when you need up-to-date information about current events, recent developments, or any topic that may have changed. You can also provide specific URLs to analyze. IMPORTANT: If the user mentions or provides any URLs in their query, you MUST extract those URLs and pass them in the 'urls' parameter for direct analysis.",
    args: {
      query: tool.schema.string().describe("The search query or question to answer using web search"),
      urls: tool.schema.array(tool.schema.string()).optional().describe(
        "List of specific URLs to fetch and analyze. IMPORTANT: Always extract and include any URLs mentioned by the user in their query here."
      ),
      thinking: tool.schema.boolean().optional().default(true).describe(
        "Enable deep thinking for more thorough analysis (default: true)"
      )
    },
    async execute(args, ctx) {
      log17.debug("Google Search tool called", {
        query: args.query,
        urlCount: args.urls?.length ?? 0
      });
      const auth = await getAuth();
      if (!auth || !isOAuthAuth(auth)) {
        return "Error: Not authenticated with Antigravity. Please run `opencode auth login` to authenticate.";
      }
      const parts = parseRefreshParts(auth.refresh);
      const projectId = parts.managedProjectId || parts.projectId || "unknown";
      let accessToken = auth.access;
      if (!accessToken || accessTokenExpired(auth)) {
        try {
          const refreshed = await refreshAccessToken(auth, client, providerId);
          accessToken = refreshed?.access;
        } catch (error) {
          return `Error: Failed to refresh access token: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      if (!accessToken) {
        return "Error: No valid access token available. Please run `opencode auth login` to re-authenticate.";
      }
      return executeSearch(
        {
          query: args.query,
          urls: args.urls,
          thinking: args.thinking
        },
        accessToken,
        projectId,
        ctx.abort
      );
    }
  });
}

// src/plugin/lifecycle.ts
var NOOP_DRAIN = async () => {
};
function createPluginLifecycle(options) {
  let accountManager = null;
  let refreshQueue = null;
  let disposal = null;
  const producers = [];
  const consumers = [];
  const drainSidebarWrites2 = options.drainSidebarWrites ?? NOOP_DRAIN;
  const disposeAccountRuntime = async () => {
    const oldQueue = refreshQueue;
    const oldManager = accountManager;
    refreshQueue = null;
    accountManager = null;
    await oldQueue?.dispose();
    await oldManager?.dispose();
  };
  const register = (disposable, phase = "consumer") => {
    if (disposal) {
      void disposable.dispose();
      return;
    }
    if (phase === "producer") {
      producers.push(disposable);
    } else {
      consumers.push(disposable);
    }
  };
  return {
    getAccountManager: () => accountManager,
    async replaceAccountRuntime(manager, queue2) {
      await disposeAccountRuntime();
      if (disposal) {
        await queue2?.dispose();
        await manager.dispose();
        return;
      }
      accountManager = manager;
      refreshQueue = queue2;
    },
    register,
    dispose() {
      if (!disposal) {
        disposal = (async () => {
          await disposeAccountRuntime();
          await options.shutdownDiskSignatureCache();
          options.sessionRegistry.clear();
          options.clearFetchState();
          for (const disposable of producers) {
            await disposable.dispose();
          }
          producers.length = 0;
          await drainSidebarWrites2();
          for (const disposable of consumers) {
            await disposable.dispose();
          }
          consumers.length = 0;
        })();
      }
      return disposal;
    }
  };
}

// src/plugin/persist-account-pool.ts
function clampInt(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}
function applyUpserts(current, results, replaceAll) {
  const now = Date.now();
  const accounts = replaceAll ? [] : [...current.accounts];
  const indexByRefreshToken = /* @__PURE__ */ new Map();
  const indexByEmail = /* @__PURE__ */ new Map();
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    if (!acc) continue;
    if (acc.refreshToken) {
      indexByRefreshToken.set(acc.refreshToken, i);
    }
    if (acc.email) {
      indexByEmail.set(acc.email, i);
    }
  }
  for (const result of results) {
    const parts = parseRefreshParts(result.refresh);
    if (!parts.refreshToken) {
      continue;
    }
    const existingByEmail = result.email ? indexByEmail.get(result.email) : void 0;
    const existingByToken = indexByRefreshToken.get(parts.refreshToken);
    const existingIndex = existingByEmail ?? existingByToken;
    if (existingIndex === void 0) {
      const newIndex = accounts.length;
      indexByRefreshToken.set(parts.refreshToken, newIndex);
      if (result.email) {
        indexByEmail.set(result.email, newIndex);
      }
      accounts.push({
        email: result.email,
        label: result.label,
        refreshToken: parts.refreshToken,
        projectId: parts.projectId,
        managedProjectId: parts.managedProjectId,
        addedAt: now,
        lastUsed: now,
        enabled: true
      });
      continue;
    }
    const existing = accounts[existingIndex];
    if (!existing) continue;
    const oldToken = existing.refreshToken;
    accounts[existingIndex] = {
      ...existing,
      email: result.email ?? existing.email,
      label: result.label ?? existing.label,
      refreshToken: parts.refreshToken,
      projectId: parts.projectId ?? existing.projectId,
      managedProjectId: parts.managedProjectId ?? existing.managedProjectId,
      lastUsed: now
    };
    if (oldToken !== parts.refreshToken) {
      indexByRefreshToken.delete(oldToken);
      indexByRefreshToken.set(parts.refreshToken, existingIndex);
    }
  }
  if (accounts.length === 0) {
    return void 0;
  }
  const activeIndex = replaceAll ? 0 : typeof current.activeIndex === "number" && Number.isFinite(current.activeIndex) ? current.activeIndex : 0;
  const clamped = clampInt(activeIndex, 0, accounts.length - 1);
  return {
    version: 4,
    accounts,
    activeIndex: clamped,
    activeIndexByFamily: {
      claude: clamped,
      gemini: clamped
    }
  };
}
async function persistAccountPool(results, replaceAll = false) {
  if (results.length === 0) {
    return;
  }
  const path5 = getStoragePath();
  const emptyV4 = () => ({
    version: 4,
    accounts: [],
    activeIndex: 0
  });
  if (replaceAll) {
    await mutateAccountStorage(
      path5,
      () => applyUpserts(emptyV4(), results, true)
    );
    return;
  }
  await mutateAccountStorage(
    path5,
    (current) => applyUpserts(current, results, false)
  );
}

// src/plugin/index.ts
var logger = createLogger2("plugin");
function quotaAccountIdentity4(refreshToken) {
  return createHash11("sha256").update(refreshToken).digest("hex").slice(0, 16);
}
function registerQuotaManagerProducer(lifecycle, quotaManager) {
  lifecycle.register({ dispose: () => quotaManager.dispose() }, "producer");
}
var createAntigravityPlugin = (providerId, options = {}) => async (input2) => {
  const dependencies = resolvePluginDependencies(
    options.dependencies
  );
  const { client, directory } = input2;
  const config = loadConfig(directory);
  initRuntimeConfig(config);
  initializeDebug(config);
  initLogger(client);
  await initAntigravityVersion();
  if (config.health_score) {
    initHealthTracker({
      initial: config.health_score.initial,
      successReward: config.health_score.success_reward,
      rateLimitPenalty: config.health_score.rate_limit_penalty,
      failurePenalty: config.health_score.failure_penalty,
      recoveryRatePerHour: config.health_score.recovery_rate_per_hour,
      minUsable: config.health_score.min_usable,
      maxScore: config.health_score.max_score
    });
  }
  if (config.token_bucket) {
    initTokenTracker({
      maxTokens: config.token_bucket.max_tokens,
      regenerationRatePerMinute: config.token_bucket.regeneration_rate_per_minute,
      initialTokens: config.token_bucket.initial_tokens
    });
  }
  if (config.keep_thinking) {
    initDiskSignatureCache(config.signature_cache);
  }
  const sessionRegistry = new AgySessionRegistry(directory);
  let cachedGetAuth = null;
  const lifecycle = createPluginLifecycle({
    sessionRegistry,
    shutdownDiskSignatureCache,
    clearFetchState: () => {
      cachedGetAuth = null;
    },
    // Drain pending sidebar writes BEFORE tearing down the RPC server
    // and file logger — a fetch-interceptor routing upsert enqueued at
    // shutdown must land before the host closes the terminal.
    drainSidebarWrites
  });
  const quotaManager = createOpenCodeQuotaManager(client, providerId, {
    // Route quota fetches through the injected transport so e2e and
    // custom-host deployments stay on the loopback/mock server for both
    // the request path and the background poller. Without this the
    // poller always hits the production Antigravity endpoint even when
    // the caller injected a mock transport.
    fetchVia: dependencies.agyTransport,
    // Bind to the live AccountManager so every refresh (manual or
    // background) pushes the freshly-updated quota percentages into the
    // sidebar without an extra RPC. The wrapper reads lazily so the
    // AccountManager reference stays stable across reloads.
    getAccountsForSidebar: () => {
      const manager = lifecycle.getAccountManager();
      if (!manager) return null;
      const activeByFamily = manager.getActiveIndexByFamily();
      return manager.getAccounts().map((entry) => ({
        index: entry.index,
        label: entry.label,
        enabled: entry.enabled,
        current: isAccountCurrent(entry.index, activeByFamily),
        coolingDownUntil: entry.coolingDownUntil,
        cachedQuota: entry.cachedQuota,
        // Carry the identity stamp so the sidebar projection can
        // detect a stale snapshot that landed on the wrong account
        // after an index shift (see `redactAccountForSidebar`).
        cachedQuotaAccountId: entry.cachedQuotaAccountId,
        currentQuotaAccountId: quotaAccountIdentity4(entry.parts.refreshToken),
        tier: toCapturedTier(entry)
      }));
    },
    getActiveIndexByFamily: () => {
      const manager = lifecycle.getAccountManager();
      if (!manager) return null;
      return manager.getActiveIndexByFamily();
    }
  });
  registerQuotaManagerProducer(lifecycle, quotaManager);
  if (config.background_quota_refresh) {
    const poller = new BackgroundQuotaRefresh({
      intervalMs: config.background_quota_refresh_interval_minutes * 6e4,
      sidebarStateFile: getSidebarStateFile(),
      getAccountManager: () => lifecycle.getAccountManager(),
      quotaManager,
      // Resolve plan tier for accounts with stale capturedTierAt. Uses
      // the same token-refresh path as the quota manager without a separate
      // network seam -- tier is best-effort metadata, not quota.
      loadAccountTier: makeTierLoader(client, providerId),
      // Thread the injected clock so e2e tests can control startup
      // jitter and timing without needing a real 30-second wait.
      now: dependencies.clock.now,
      random: dependencies.clock.random
    });
    options._onPollerCreated?.(poller);
    poller.start();
    lifecycle.register({ dispose: () => poller.dispose() }, "producer");
  }
  const operatorSettings = createOperatorSettingsController({
    projectConfigPath: join19(directory, ".opencode", "antigravity.json"),
    // getUserConfigPath() already returns the full file path including
    // 'antigravity.json' — do NOT join again or the path double-nests
    // into <dir>/antigravity.json/antigravity.json.
    userConfigPath: getUserConfigPath()
  });
  setRuntimeLogLevel(operatorSettings.get().log_level);
  lifecycle.register({ dispose: () => operatorSettings.dispose() });
  const sessionRecovery = createSessionRecoveryHook(
    { client, directory },
    config
  );
  const updateChecker = createAutoUpdateCheckerHook(client, directory, {
    showStartupToast: true,
    autoUpdate: config.auto_update
  });
  const event = createEventHandler({
    client,
    config,
    directory,
    lifecycle,
    sessionRegistry,
    sessionRecovery,
    updateChecker,
    logger
  });
  const commandData = createCommandDataService({
    accountManagerView: {
      getAccounts: () => {
        const manager = lifecycle.getAccountManager();
        if (!manager) return [];
        const activeByFamily = manager.getActiveIndexByFamily();
        return manager.getAccounts().map((entry, index) => ({
          index,
          refreshToken: entry.parts.refreshToken,
          label: entry.label,
          enabled: entry.enabled !== false,
          active: isAccountCurrent(index, activeByFamily),
          cachedQuota: entry.cachedQuota,
          cachedQuotaUpdatedAt: entry.cachedQuotaUpdatedAt,
          cachedQuotaAccountId: entry.cachedQuotaAccountId,
          accountIneligible: entry.accountIneligible,
          coolingDownUntil: entry.coolingDownUntil,
          healthScore: getHealthTracker().getScore(entry.index),
          capturedTierId: entry.capturedTierId,
          capturedPaidTierId: entry.capturedPaidTierId,
          capturedTierAt: entry.capturedTierAt
        }));
      },
      getAccountsForQuotaCheck: () => {
        const manager = lifecycle.getAccountManager();
        return manager ? manager.getAccountsForQuotaCheck() : [];
      },
      updateQuotaCache: (index, groups, expectedRefreshToken) => {
        lifecycle.getAccountManager()?.updateQuotaCache(index, groups, expectedRefreshToken);
      },
      requestSaveToDisk: () => {
        lifecycle.getAccountManager()?.requestSaveToDisk();
      },
      flushSaveToDisk: async () => {
        await lifecycle.getAccountManager()?.flushSaveToDisk();
      },
      getActiveIndexByFamily: () => {
        const manager = lifecycle.getAccountManager();
        if (!manager) return { claude: 0, gemini: 0 };
        return manager.getActiveIndexByFamily();
      },
      setAccountEnabled: (index, enabled) => {
        const manager = lifecycle.getAccountManager();
        if (!manager) return false;
        return manager.setAccountEnabled(index, enabled);
      },
      setAccountCurrent: (index) => {
        const manager = lifecycle.getAccountManager();
        if (!manager) return false;
        const account = manager.getAccounts()[index];
        if (!account) return false;
        manager.markSwitched(account, "initial", "claude");
        manager.markSwitched(account, "initial", "gemini");
        return true;
      },
      removeAccountByIndex: (index) => {
        const manager = lifecycle.getAccountManager();
        if (!manager) return false;
        return manager.removeAccountByIndex(index);
      },
      getRefreshTokenAt: (index) => {
        const manager = lifecycle.getAccountManager();
        if (!manager) return void 0;
        return manager.getAccounts()[index]?.parts.refreshToken;
      }
    },
    quotaManager,
    sidebarStateFile: getSidebarStateFile(),
    storage: {
      mutate: (mutator) => mutateAccountStorage2(getStoragePath(), mutator)
    }
  });
  const commandExecuteBefore = createCommandExecuteBefore(
    client,
    operatorSettings,
    pushNotification,
    commandData
  );
  const googleSearchTool = createGoogleSearchTool({
    getAuth: async () => cachedGetAuth ? cachedGetAuth() : null,
    client,
    providerId
  });
  const accountAccess = createAccountAccessService({
    client,
    providerId,
    store: {
      load: loadAccounts,
      mutate: (mutate) => mutateAccountStorage2(getStoragePath(), mutate),
      clear: clearAccounts,
      persistAccountPool
    },
    openBrowser: openBrowserWithSystem,
    prompt: {
      selectAccount: promptAccountIndexForVerification,
      confirmOpenVerificationUrl: promptOpenVerificationUrl
    }
  });
  const authLoader = createAuthLoader({
    client,
    providerId,
    config,
    lifecycle,
    onGetAuth: (getAuth) => {
      cachedGetAuth = getAuth;
    },
    createFetch: ({ accountManager, getAuth }) => createFetchInterceptor({
      client,
      directory,
      providerId,
      config,
      accountManager,
      quotaManager,
      getAuth,
      agySessionRegistry: sessionRegistry,
      operatorSettings,
      agyTransport: dependencies.agyTransport,
      fetchImpl: dependencies.fetchImpl
    })
  });
  const accountOAuth = createAccountCommandOAuthService({
    // Wire the OAuth primitives through the dependency seam (rather
    // than the concrete imports above) so injected overrides from
    // `dependencies.oauth.*` reach this path — the same composition
    // pattern used by every other sub-factory. Without this seam the
    // e2e harness / custom-host deployments would still hit the real
    // Google OAuth endpoints when adding an account.
    authorize: dependencies.oauth.authorize,
    exchange: dependencies.oauth.exchange,
    persist: (result) => accountAccess.persistAccountPool([result], false),
    listAccounts: async () => projectCommandAccountRows(await accountAccess.loadAccounts()),
    // After the new account lands on disk, reload the live
    // AccountManager + fetch interceptor so routing sees it
    // immediately — without waiting for an auth reload.
    onAfterPersist: () => authLoader.reload(async () => {
      const auth = cachedGetAuth ? await cachedGetAuth() : void 0;
      if (auth) return auth;
      throw new Error(
        "No live auth cached for OAuth finish reload \u2014 the host has not yet loaded any account."
      );
    })
  });
  lifecycle.register({ dispose: () => accountOAuth.dispose() });
  const oauthMethods = createOAuthMethods({
    client,
    providerId,
    config,
    lifecycle,
    accountAccess,
    quotaManager,
    getAuth: async () => cachedGetAuth ? cachedGetAuth() : void 0
  });
  const rpcServer = await startRpcServer({
    dir: getRpcDir(directory),
    apply: async (request) => {
      const refreshSidebar = createSidebarRefresher(() => {
        const manager = lifecycle.getAccountManager();
        if (!manager) return null;
        const activeByFamily = manager.getActiveIndexByFamily();
        return manager.getAccounts().map((entry) => ({
          index: entry.index,
          label: entry.label,
          enabled: entry.enabled,
          current: isAccountCurrent(entry.index, activeByFamily),
          coolingDownUntil: entry.coolingDownUntil,
          cachedQuota: entry.cachedQuota,
          // Carry the identity stamp so the sidebar projection can
          // detect a stale snapshot that landed on the wrong account
          // after an index shift (see `redactAccountForSidebar`).
          cachedQuotaAccountId: entry.cachedQuotaAccountId,
          currentQuotaAccountId: quotaAccountIdentity4(
            entry.parts.refreshToken
          ),
          tier: toCapturedTier(entry)
        }));
      });
      const result = await applyCommand(request, {
        client,
        sessionID: request.sessionId ?? "",
        settings: operatorSettings,
        onApplied: refreshSidebar,
        commandData,
        accountOAuth
      });
      setRuntimeLogLevel(operatorSettings.get().log_level);
      return result;
    },
    drain: drainNotifications
  });
  lifecycle.register({ dispose: () => rpcServer.stop() });
  lifecycle.register({ dispose: () => closeDebugLog().catch(() => {
  }) });
  return {
    dispose: async () => {
      await lifecycle.dispose();
    },
    config: async (opencodeConfig) => {
      applyAntigravityProviderCatalog(
        opencodeConfig,
        providerId
      );
      registerAntigravityCommands(
        opencodeConfig
      );
    },
    "command.execute.before": commandExecuteBefore,
    event,
    tool: { google_search: googleSearchTool },
    auth: {
      provider: providerId,
      loader: authLoader,
      methods: oauthMethods
    }
  };
};
var AntigravityCLIOAuthPlugin = createAntigravityPlugin(
  ANTIGRAVITY_PROVIDER_ID
);
var GoogleOAuthPlugin = AntigravityCLIOAuthPlugin;
export {
  AntigravityCLIOAuthPlugin,
  GoogleOAuthPlugin
};
//# sourceMappingURL=index.js.map
