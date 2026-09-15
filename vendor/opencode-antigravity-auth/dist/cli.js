#!/usr/bin/env node

// src/cli.ts
import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

// ../core/dist/account-storage.js
import { chmod, copyFile, mkdir as mkdir3, readFile as readFile2, unlink as unlink2 } from "node:fs/promises";

// ../core/dist/atomic-write.js
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
async function writeJsonAtomic(path2, value) {
  const serialized = `${JSON.stringify(value, null, 2)}
`;
  const tempPath = `${path2}.${randomUUID()}.tmp`;
  await mkdir(dirname(path2), { recursive: true });
  let renamed = false;
  try {
    await writeFile(tempPath, serialized, {
      encoding: "utf8",
      mode: 384
    });
    await rename(tempPath, path2);
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
async function readLockPayload(path2) {
  try {
    const text = await readFile(path2, "utf8");
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.ownerId === "string" && typeof parsed.expiresAt === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
async function readMarkerPayload(path2) {
  try {
    const text = await readFile(path2, "utf8");
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
  await new Promise((resolve) => setTimeout(resolve, ms));
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
  let lostPromise = new Promise((resolve) => {
    lostResolve = resolve;
  });
  const markLost = () => {
    if (lost)
      return;
    lost = true;
    if (renewTimer !== null) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
    const resolve = lostResolve;
    lostResolve = null;
    resolve?.();
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
  const log8 = (level, message, extra) => {
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
    debug: (message, extra) => log8("debug", message, extra),
    info: (message, extra) => log8("info", message, extra),
    warn: (message, extra) => log8("warn", message, extra),
    error: (message, extra) => log8("error", message, extra)
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
var DEFAULT_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var DEFAULT_BUILD_BACKUP_PATH = (path2, now) => `${path2}.corrupt-${now.toISOString().replace(/[:.]/g, "-")}`;
async function ensureSecurePermissions(path2) {
  try {
    await chmod(path2, 384);
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
async function readAndNormalizeV4(path2) {
  let raw;
  try {
    raw = await readFile2(path2, "utf-8");
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
async function loadAccountStorage(path2) {
  const buildBackupPath = DEFAULT_BUILD_BACKUP_PATH;
  const now = () => /* @__PURE__ */ new Date();
  await ensureSecurePermissions(path2);
  const outcome = await readAndNormalizeV4(path2);
  if (outcome.state === "missing") {
    return null;
  }
  if (outcome.state === "unreadable") {
    const backupPath = await backupCorruptFile(path2, buildBackupPath, now());
    throw new AccountStorageUnreadableError(`Account storage at ${path2} is unreadable (${outcome.reason}: ${outcome.detail}).` + (backupPath ? ` A backup was written to ${backupPath}. The plugin will refuse to write until the file is removed or repaired.` : " A backup could not be written; the file has been left in place. The plugin will refuse to write until the file is removed or repaired."), {
      path: path2,
      reason: outcome.reason,
      detail: outcome.detail,
      backupPath
    });
  }
  if (outcome.storage.version === 4) {
    const onDiskVersion = await readVersionOnly(path2);
    if (onDiskVersion !== null && onDiskVersion !== 4) {
      try {
        await saveAccountStorage(path2, outcome.storage);
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
async function readVersionOnly(path2) {
  try {
    const raw = await readFile2(path2, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "number" ? parsed.version : null;
  } catch {
    return null;
  }
}
async function acquireWithRetry(path2, sleep2) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const lock = await acquireFencedFileLock({
      path: path2,
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
        await sleep2(delay);
      }
    }
  }
  throw new AccountStorageLockContentionError(`account storage lock contention at ${path2} after ${RETRY_DELAYS_MS.length + 1} attempts`, {
    path: path2,
    attempts: RETRY_DELAYS_MS.length + 1
  });
}
async function mutateAccountStorage(path2, mutate, options = {}) {
  const sleep2 = options.sleep ?? DEFAULT_SLEEP;
  const buildBackupPath = options.buildBackupPath ?? DEFAULT_BUILD_BACKUP_PATH;
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  const lock = await acquireWithRetry(path2, sleep2);
  try {
    const outcome = await readAndNormalizeV4(path2);
    if (outcome.state === "unreadable") {
      const backupPath = await backupCorruptFile(path2, buildBackupPath, now());
      throw new AccountStorageUnreadableError(`Refusing to write: account storage at ${path2} is unreadable (${outcome.reason}: ${outcome.detail}).` + (backupPath ? ` A backup of the existing file was written to ${backupPath} and the on-disk file has been left untouched. Repair or remove the existing file before retrying.` : " A backup could not be written; the on-disk file has been left untouched. Repair or remove the existing file before retrying."), {
        path: path2,
        reason: outcome.reason,
        detail: outcome.detail,
        backupPath
      });
    }
    const existing = outcome.state === "ok" ? outcome.storage : { version: 4, accounts: [], activeIndex: 0 };
    const next = await mutate(existing);
    const finalStorage = next ?? existing;
    await lock.assertOwned();
    await writeJsonAtomic(path2, finalStorage);
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
async function saveAccountStorage(path2, incoming) {
  return mutateAccountStorage(path2, (current) => mergeAccountStorage(current, incoming));
}

// ../core/dist/auth.js
var ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1e3;
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
var AGY_CLI_VERSION = "1.1.24";
var AGY_CLI_CHANGE_LIST = "974782877";
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
function getResolverAliasMap() {
  return RESOLVER_ALIASES;
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

// ../core/dist/account-manager.js
var ACCOUNT_SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1e3;

// ../core/dist/agy-request-metadata.js
var DEFAULT_SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1e3;

// ../core/dist/agy-transport.js
import { Buffer as Buffer2 } from "node:buffer";
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
    return Buffer2.alloc(0);
  if (typeof body === "string")
    return Buffer2.from(body);
  if (body instanceof Uint8Array)
    return Buffer2.from(body);
  if (body instanceof ArrayBuffer)
    return Buffer2.from(body);
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
  return new Promise((resolve, reject) => {
    let buffer = Buffer2.alloc(0);
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
      buffer = Buffer2.concat([buffer, chunk]);
      const marker = buffer.indexOf("\r\n\r\n");
      if (marker === -1)
        return;
      const head = buffer.subarray(0, marker).toString("latin1");
      const leftover = buffer.subarray(marker + 4);
      cleanup(() => resolve({ head, leftover }));
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
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      onDebug?.(`agy transport proxy connect timeout after ${timeoutMs}ms`);
      proxySocket.destroy();
      reject(new Error(`Antigravity request timed out connecting to HTTPS proxy after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => clearTimeout(timeout);
    proxySocket.once("connect", () => {
      cleanup();
      resolve();
    });
    proxySocket.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
  const targetHost = targetUrl.hostname;
  const targetPort = Number(targetUrl.port || DEFAULT_HTTPS_PORT);
  const auth = proxyUrl.username ? `Proxy-Authorization: Basic ${Buffer2.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64")}\r
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
  return await new Promise((resolve, reject) => {
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
      resolve(tlsSocket);
    });
    tlsSocket.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}
async function connectDirect(targetUrl, timeoutMs, onDebug) {
  return await new Promise((resolve, reject) => {
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
      resolve(socket);
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
  const path2 = `${url.pathname}${url.search}`;
  const headerLines = buildAgyCliHeaderPairs(url.toString(), init).map(([key, value]) => `${key}: ${value}`).join("\r\n");
  const head = Buffer2.from(`${method} ${path2} HTTP/1.1\r
${headerLines}\r
\r
`);
  if (body.byteLength === 0) {
    return head;
  }
  if (!shouldUseChunkedBody(url)) {
    return Buffer2.concat([head, body]);
  }
  return Buffer2.concat([
    head,
    Buffer2.from(`${body.byteLength.toString(16)}\r
`),
    body,
    Buffer2.from("\r\n0\r\n\r\n")
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
  buffer = Buffer2.alloc(0);
  _transform(chunk, _encoding, callback) {
    this.buffer = Buffer2.concat([this.buffer, chunk]);
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
        this.buffer = Buffer2.alloc(0);
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
import { createHash, randomBytes } from "node:crypto";

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
var ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";
var ANTIGRAVITY_VERSION_FALLBACK = "1.18.3";
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
var ANTIGRAVITY_PROVIDER_ID = "google";

// ../core/dist/fetch-timeout.js
var ACTIVE_FETCH_TIMEOUT_MS = 15e3;
async function fetchWithActiveTimeout(input, init = {}, options = {}) {
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
    return await fetchImpl(input, { ...init, signal: composedSignal });
  } finally {
    timeoutSignal.removeEventListener("abort", onTimeoutAbort);
  }
}

// ../core/dist/antigravity/oauth.js
var log2 = createLogger("oauth");
function generatePkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url")
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
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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
import { createHash as createHash2 } from "node:crypto";
var log4 = createLogger("quota-manager");
var QUOTA_MANAGER_DEFAULT_BASE_BACKOFF_MS = 3e4;
var QUOTA_MANAGER_DEFAULT_MAX_BACKOFF_MS = 10 * 60 * 1e3;
var QUOTA_MANAGER_DEFAULT_TIMEOUT_MS = 1e4;
function defaultKeyOf(account) {
  if (account.email)
    return `e:${account.email.toLowerCase()}`;
  const token = account.refreshToken || "";
  return `t:${createHash2("sha256").update(token).digest("hex").slice(0, 16)}`;
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
  return createHash2("sha256").update(key).digest("hex").slice(0, 8);
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

// ../core/dist/transform/model-resolver.js
var MODEL_ALIASES = getResolverAliasMap();

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

// src/plugin/storage.ts
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  promises as fs,
  mkdirSync as mkdirSync2,
  readFileSync,
  renameSync,
  unlinkSync as unlinkSync2,
  writeFileSync
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname3, join as join3 } from "node:path";

// src/plugin/debug.ts
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync
} from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
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
function deriveDebugPolicy(input) {
  const envDebugFlag = input.envDebugFlag ?? "";
  const debugLevel = input.configDebug ? envDebugFlag === "2" || envDebugFlag === "verbose" ? 2 : 1 : parseDebugLevel(envDebugFlag);
  const debugEnabled = debugLevel >= 1;
  const verboseEnabled = debugLevel >= 2;
  const debugTuiEnabled = debugEnabled && (input.configDebugTui || isTruthyFlag2(input.envDebugTuiFlag));
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

// src/plugin/debug.ts
var debugState = null;
function getConfigDir() {
  const platform = process.platform;
  if (platform === "win32") {
    return join2(
      env.APPDATA || join2(homedir(), "AppData", "Roaming"),
      "opencode"
    );
  }
  const xdgConfig2 = env.XDG_CONFIG_HOME || join2(homedir(), ".config");
  return join2(xdgConfig2, "opencode");
}
function getLogsDir(customLogDir) {
  const logsDir = customLogDir || join2(getConfigDir(), "antigravity-logs");
  try {
    mkdirSync(logsDir, { recursive: true, mode: 448 });
  } catch {
  }
  return logsDir;
}
function createLogFilePath(customLogDir) {
  const logsDir = getLogsDir(customLogDir);
  cleanupOldLogs(logsDir, 25);
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  return join2(logsDir, `antigravity-debug-${timestamp}.log`);
}
function cleanupOldLogs(logsDir, maxFiles) {
  try {
    const files = readdirSync(logsDir).filter(
      (file) => file.startsWith("antigravity-debug-") && file.endsWith(".log")
    ).map((file) => join2(logsDir, file));
    if (files.length <= maxFiles) {
      return;
    }
    const sortedFiles = files.map((file) => ({
      file,
      mtime: statSync(file).mtimeMs
    })).sort((a, b) => b.mtime - a.mtime);
    for (let i = maxFiles; i < sortedFiles.length; i++) {
      try {
        unlinkSync(sortedFiles[i].file);
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
function isDebugTuiEnabled() {
  return getDebugState().debugTuiEnabled;
}
function logDebug(line) {
  getDebugState().logWriter(line);
}
function runWithDebugEnabled(action) {
  if (!getDebugState().debugEnabled) return;
  action();
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

// src/plugin/logger.ts
var ENV_CONSOLE_LOG2 = "OPENCODE_ANTIGRAVITY_CONSOLE_LOG";
var LEVEL_PRIORITY = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
var _client = null;
var _configuredLevel = "debug";
function shouldEmit(level) {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[_configuredLevel];
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
  const log8 = (level, message, extra) => {
    emitLog(service, level, message, extra);
  };
  return {
    debug: (message, extra) => log8("debug", message, extra),
    info: (message, extra) => log8("info", message, extra),
    warn: (message, extra) => log8("warn", message, extra),
    error: (message, extra) => log8("error", message, extra)
  };
}

// src/plugin/storage.ts
var log5 = createLogger2("storage");
var GITIGNORE_ENTRIES = [
  "antigravity-accounts.json",
  "antigravity-accounts.json.*.tmp",
  "antigravity-signature-cache.json",
  "antigravity-logs/"
];
async function ensureGitignore(configDir) {
  const gitignorePath = join3(configDir, ".gitignore");
  try {
    let content;
    let existingLines = [];
    try {
      content = await fs.readFile(gitignorePath, "utf-8");
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
      await fs.writeFile(
        gitignorePath,
        `${missingEntries.join("\n")}
`,
        "utf-8"
      );
      log5.info("Created .gitignore in config directory");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      await fs.appendFile(
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
  return join3(
    process.env.APPDATA || join3(homedir2(), "AppData", "Roaming"),
    "opencode"
  );
}
function getConfigDir2() {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }
  const xdgConfig2 = process.env.XDG_CONFIG_HOME || join3(homedir2(), ".config");
  return join3(xdgConfig2, "opencode");
}
function migrateLegacyWindowsConfig() {
  if (process.platform !== "win32") {
    return false;
  }
  const newPath = join3(getConfigDir2(), "antigravity-accounts.json");
  const legacyPath = join3(
    getLegacyWindowsConfigDir(),
    "antigravity-accounts.json"
  );
  if (!existsSync(legacyPath) || existsSync(newPath)) {
    return false;
  }
  try {
    const newConfigDir = getConfigDir2();
    mkdirSync2(newConfigDir, { recursive: true });
    try {
      renameSync(legacyPath, newPath);
      log5.info("Migrated Windows config via rename", {
        from: legacyPath,
        to: newPath
      });
    } catch {
      copyFileSync(legacyPath, newPath);
      unlinkSync2(legacyPath);
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
  const newPath = join3(getConfigDir2(), "antigravity-accounts.json");
  if (process.platform === "win32") {
    migrateLegacyWindowsConfig();
    if (!existsSync(newPath)) {
      const legacyPath = join3(
        getLegacyWindowsConfigDir(),
        "antigravity-accounts.json"
      );
      if (existsSync(legacyPath)) {
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
  const path2 = getStoragePath();
  await ensureGitignore(dirname3(path2));
  return loadAccountStorage(path2);
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
  const path2 = getStoragePath();
  const emptyV4 = () => ({
    version: 4,
    accounts: [],
    activeIndex: 0
  });
  if (replaceAll) {
    await mutateAccountStorage(
      path2,
      () => applyUpserts(emptyV4(), results, true)
    );
    return;
  }
  await mutateAccountStorage(
    path2,
    (current) => applyUpserts(current, results, false)
  );
}

// ../../node_modules/.bun/xdg-basedir@5.1.0/node_modules/xdg-basedir/index.js
import os from "os";
import path from "path";
var homeDirectory = os.homedir();
var { env: env2 } = process;
var xdgData = env2.XDG_DATA_HOME || (homeDirectory ? path.join(homeDirectory, ".local", "share") : void 0);
var xdgConfig = env2.XDG_CONFIG_HOME || (homeDirectory ? path.join(homeDirectory, ".config") : void 0);
var xdgState = env2.XDG_STATE_HOME || (homeDirectory ? path.join(homeDirectory, ".local", "state") : void 0);
var xdgCache = env2.XDG_CACHE_HOME || (homeDirectory ? path.join(homeDirectory, ".cache") : void 0);
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
var ACTIVE_ROUTING_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var sidebarWriteChain = Promise.resolve();

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
var SIGNATURE_CACHE_TTL_MS = 60 * 60 * 1e3;

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

// src/plugin/quota.ts
var log7 = createLogger2("quota");
async function checkAccountsQuotaWith(accounts, fetchAccountQuota) {
  const manager = createQuotaManager({
    fetchAccountQuota,
    keyOf: defaultKeyOf
  });
  try {
    return await manager.refreshAccounts(accounts, {
      indexFor: (account) => accounts.indexOf(account),
      force: true
    });
  } finally {
    manager.dispose();
  }
}
async function checkAccountsQuotaStandalone(accounts, options) {
  if (!options.refresh) {
    return accounts.map((account, index) => ({
      index,
      email: account.email,
      status: account.enabled === false ? "disabled" : "ok",
      disabled: account.enabled === false,
      quota: {
        groups: account.cachedQuota ?? {},
        modelCount: Object.keys(account.cachedQuota ?? {}).length
      }
    }));
  }
  return checkAccountsQuotaWith(
    accounts,
    makeFetchAccountQuota(void 0, ANTIGRAVITY_PROVIDER_ID)
  );
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

// src/plugin/server.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { createServer } from "node:http";
var redirectUri = new URL(ANTIGRAVITY_REDIRECT_URI);
var callbackPath = redirectUri.pathname || "/";
function isOrbStackDockerHost() {
  if (!existsSync2("/.dockerenv")) {
    return false;
  }
  try {
    if (existsSync2("/proc/version")) {
      const version = readFileSync2("/proc/version", "utf8").toLowerCase();
      if (version.includes("orbstack")) {
        return true;
      }
    }
    const hostname = process.env.HOSTNAME || "";
    if (hostname.startsWith("orbstack-") || hostname.endsWith(".orb") || hostname === "orbstack") {
      return true;
    }
    if (existsSync2("/etc/resolv.conf")) {
      const resolv = readFileSync2("/etc/resolv.conf", "utf8");
      if (resolv.includes("orb.local") || resolv.includes("orbstack")) {
        return true;
      }
    }
    if (process.platform === "linux" && existsSync2("/.dockerenv")) {
      if (existsSync2("/run/host-services")) {
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
    const release = readFileSync2("/proc/version", "utf8").toLowerCase();
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
  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = (url) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve(url);
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
  const server = createServer((request, response) => {
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
  await new Promise((resolve, reject) => {
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
      resolve();
    });
  });
  server.on("error", (error) => {
    rejectCallback(error instanceof Error ? error : new Error(String(error)));
  });
  return {
    waitForCallback: () => callbackPromise,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
          return;
        }
        if (!settled) {
          rejectCallback(new Error("OAuth listener closed before callback"));
        }
        resolve();
      });
    })
  };
}

// src/cli.ts
var HELP = `Usage: antigravity-auth <command> [options]

Commands:
  login [--project <id>] [--no-browser]
  list [--json]
  quota [--json] [--refresh]

Options:
  --help  Show help
`;
function parseArgs(argv) {
  const [command, ...args] = argv;
  if (command === "--help") {
    return args.length === 0 ? { ok: true, value: { command: "help" } } : { ok: false, error: `Unknown argument: ${args[0]}` };
  }
  if (!command) return { ok: false, error: "Missing command" };
  if (command === "login") {
    let projectId;
    let noBrowser = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--no-browser") {
        noBrowser = true;
        continue;
      }
      if (arg === "--project") {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          return { ok: false, error: "Missing value for --project" };
        }
        projectId = value;
        index += 1;
        continue;
      }
      return { ok: false, error: `Unknown option for login: ${arg}` };
    }
    return { ok: true, value: { command, projectId, noBrowser } };
  }
  if (command === "list") {
    let json = false;
    for (const arg of args) {
      if (arg === "--json") json = true;
      else return { ok: false, error: `Unknown option for list: ${arg}` };
    }
    return { ok: true, value: { command, json } };
  }
  if (command === "quota") {
    let json = false;
    let refresh = false;
    for (const arg of args) {
      if (arg === "--json") json = true;
      else if (arg === "--refresh") refresh = true;
      else return { ok: false, error: `Unknown option for quota: ${arg}` };
    }
    return { ok: true, value: { command, json, refresh } };
  }
  return { ok: false, error: `Unknown command: ${command}` };
}
function accountStatus(account) {
  if (account.enabled === false) return "disabled";
  if (account.accountIneligible) return "ineligible";
  if (account.verificationRequired) return "verification-required";
  return "active";
}
function accountSummary(storage) {
  return {
    accounts: (storage?.accounts ?? []).map((account, index) => ({
      index: index + 1,
      email: account.email ?? `Account ${index + 1}`,
      status: accountStatus(account)
    }))
  };
}
function formatTable(headers, rows) {
  const widths = headers.map(
    (header, column) => Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0))
  );
  const formatRow = (row) => row.map(
    (value, column) => column === row.length - 1 ? value : value.padEnd((widths[column] ?? value.length) + 2)
  ).join("");
  return `${[formatRow(headers), ...rows.map(formatRow)].join("\n")}
`;
}
function quotaSummary(results) {
  return {
    accounts: results.map((result) => ({
      index: result.index + 1,
      email: result.email ?? `Account ${result.index + 1}`,
      status: result.status,
      ...result.error ? { error: result.error } : {},
      groups: Object.entries(result.quota?.groups ?? {}).map(
        ([name, group]) => ({
          name,
          ...typeof group.remainingFraction === "number" ? { remainingPercent: group.remainingFraction * 100 } : {},
          ...group.resetTime ? { resetTime: group.resetTime } : {}
        })
      )
    }))
  };
}
function formatQuotaTable(results) {
  const rows = [];
  for (const account of quotaSummary(results).accounts) {
    if (account.groups.length === 0) {
      rows.push([account.email, account.status, "-", "-", account.error ?? "-"]);
      continue;
    }
    for (const group of account.groups) {
      rows.push([
        account.email,
        account.status,
        group.name,
        group.remainingPercent === void 0 ? "-" : `${group.remainingPercent}%`,
        group.resetTime ?? "-"
      ]);
    }
  }
  return formatTable(["ACCOUNT", "STATUS", "GROUP", "REMAINING", "RESET"], rows);
}
async function runCli(argv, deps) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    deps.stderr.write(`${parsed.error}
`);
    return 2;
  }
  if (parsed.value.command === "help") {
    deps.stdout.write(HELP);
    return 0;
  }
  try {
    if (parsed.value.command === "login") {
      const result = await deps.performLogin(
        {
          projectId: parsed.value.projectId,
          noBrowser: parsed.value.noBrowser,
          isHeadless: deps.isHeadless?.() ?? false,
          refreshAccountIndex: void 0,
          accounts: [],
          startFresh: true
        },
        deps.openBrowser
      );
      deps.stdout.write(
        `Authenticated ${result.email ?? "Antigravity account"}
`
      );
      return 0;
    }
    const storage = await deps.loadAccounts();
    if (parsed.value.command === "list") {
      const summary = accountSummary(storage);
      deps.stdout.write(
        parsed.value.json ? `${JSON.stringify(summary)}
` : formatTable(
          ["INDEX", "EMAIL", "STATUS"],
          summary.accounts.map((account) => [
            String(account.index),
            account.email,
            account.status
          ])
        )
      );
      return 0;
    }
    const results = await deps.getQuota(storage?.accounts ?? [], {
      refresh: parsed.value.refresh
    });
    deps.stdout.write(
      parsed.value.json ? `${JSON.stringify(quotaSummary(results))}
` : formatQuotaTable(results)
    );
    return 0;
  } catch (error) {
    deps.stderr.write(
      `${error instanceof Error ? error.message : String(error)}
`
    );
    return 1;
  }
}
var execFileAsync = promisify(execFile);
async function openBrowserDefault(url) {
  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
    return;
  }
  await execFileAsync(process.platform === "darwin" ? "open" : "xdg-open", [
    url
  ]);
}
function createDefaultCliDependencies() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    prompt: async (message) => {
      const readline = createInterface({
        input: process.stdin,
        output: process.stdout
      });
      try {
        return (await readline.question(message)).trim();
      } finally {
        readline.close();
      }
    },
    openBrowser: openBrowserDefault,
    isHeadless: () => Boolean(
      process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.OPENCODE_HEADLESS
    ),
    performLogin: async (request, openBrowser) => performOAuthLogin(request, {
      authorize: authorizeAntigravity,
      exchange: exchangeAntigravity,
      startListener: startOAuthListener,
      openBrowser,
      upsert: async (result) => {
        await persistAccountPool(
          [result],
          request.startFresh && request.accounts.length === 0
        );
      }
    }),
    loadAccounts,
    getQuota: (accounts, options) => checkAccountsQuotaStandalone(accounts, options)
  };
}
if (import.meta.main) {
  process.exitCode = await runCli(
    process.argv.slice(2),
    createDefaultCliDependencies()
  );
}
export {
  createDefaultCliDependencies,
  performOAuthLogin,
  runCli
};
//# sourceMappingURL=cli.js.map
