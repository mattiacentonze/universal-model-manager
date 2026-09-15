/**
 * Where the account store lives.
 *
 * This is the ONLY definition. It used to be duplicated verbatim in both
 * `accounts.ts` and `refresh-file-lock.ts`, because `accounts.ts` imports the
 * lock and the reverse import would have been a cycle. Two copies of a path
 * resolver is a bad trade for that: the lock and the write must agree on the
 * exact file, and if the copies ever drifted, a writer would take a lock on one
 * path while writing another — mutual exclusion silently lost on a file holding
 * credentials. Nothing would fail a test, since each copy works on its own.
 *
 * This module imports nothing from either side, so both can depend on it.
 */
export declare const ACCOUNT_FILE_NAME = "openai-auth.json";
export declare const ACCOUNT_STATE_FILE_NAME = "openai-auth-state.json";
export declare function getAccountStoragePath(): string;
/** Derive the state-file path from the config path without reading env vars. */
export declare function deriveStatePath(configPath: string): string;
/**
 * Detect path aliases without requiring either file to exist. This is defense
 * in depth: hardlinks and bind mounts can still make distinct paths share a
 * file, because neither is distinguishable through pathname identity.
 */
export declare function accountPathsCollide(configPath: string, statePath: string, platform?: NodeJS.Platform): boolean;
export declare function getAccountStatePath(configPath?: string): string;
