/**
 * Host-path adapter for account storage.
 *
 * Resolves the on-disk path for the OpenCode config directory, handles
 * the legacy Windows migration, and keeps the .gitignore in sync. All
 * data operations are delegated to `@cortexkit/antigravity-auth-core`'s
 * lock-held account-storage engine.
 *
 * The split keeps this module harness-specific (it knows about
 * `OPENCODE_CONFIG_DIR`, `%APPDATA%`, and OpenCode-specific gitignore
 * entries) while the schema, migrations, and lock semantics live in
 * core.
 */
import type { AccountMetadataV2, AccountMetadataV3, AccountModelFamily, AccountStorageUnreadableReason, AccountStorageV2, AccountStorageV4, AnyAccountStorage, CooldownReason, HeaderStyle, RateLimitStateV2, RateLimitStateV3 } from '@cortexkit/antigravity-auth-core';
import { AccountStorageUnreadableError, deduplicateAccountsByEmail as coreDeduplicateAccountsByEmail, mergeAccountStorage as coreMergeAccountStorage, migrateV2ToV3 as coreMigrateV2ToV3, mutateAccountStorage as coreMutateAccountStorage } from '@cortexkit/antigravity-auth-core';
/**
 * @deprecated use `AccountModelFamily` from `@cortexkit/antigravity-auth-core`.
 * Retained under the old name so existing call sites continue to compile.
 */
export type ModelFamily = AccountModelFamily;
export type { AccountMetadataV2, AccountMetadataV3, AccountStorageUnreadableReason, AccountStorageV2, AccountStorageV4, AnyAccountStorage, CooldownReason, HeaderStyle, RateLimitStateV2, RateLimitStateV3, };
/**
 * Re-export the typed unreadable-storage error so consumers can
 * `instanceof`-check without pulling core into their own dependency
 * graph. When the on-disk accounts file exists but cannot be parsed
 * as a valid v4 (corrupt JSON, schema mismatch, unknown version, or
 * an I/O error other than ENOENT), every read/write here throws this
 * — never silently overwrites the user's data.
 */
export { AccountStorageUnreadableError };
/**
 * Backward-compat re-exports for harnesses still importing
 * `deduplicateAccountsByEmail` / `mergeAccountStorage` / `migrateV2ToV3`
 * from `./storage`. The definitions live in core; the adapter exposes
 * them so legacy test files compile without modification.
 */
export declare const deduplicateAccountsByEmail: typeof coreDeduplicateAccountsByEmail;
export declare const mergeAccountStorage: typeof coreMergeAccountStorage;
export declare const migrateV2ToV3: typeof coreMigrateV2ToV3;
export declare const mutateAccountStorage: typeof coreMutateAccountStorage;
/**
 * Files/directories that should be gitignored in the config directory.
 * These contain sensitive data or machine-specific state.
 */
export declare const GITIGNORE_ENTRIES: string[];
/**
 * Ensures a .gitignore file exists in the config directory with entries
 * for sensitive files. Creates the file if missing, or appends missing
 * entries if it already exists.
 */
export declare function ensureGitignore(configDir: string): Promise<void>;
/**
 * Synchronous version of ensureGitignore for use in sync code paths.
 */
export declare function ensureGitignoreSync(configDir: string): void;
/**
 * Gets the config directory path, with the following precedence:
 * 1. OPENCODE_CONFIG_DIR env var (if set)
 * 2. ~/.config/opencode (all platforms, including Windows)
 *
 * On Windows, also checks for legacy %APPDATA%\opencode path for migration.
 */
declare function getConfigDir(): string;
export declare function getStoragePath(): string;
/**
 * Gets the config directory path. Exported for use by other modules.
 */
export { getConfigDir };
export declare function loadAccounts(): Promise<AccountStorageV4 | null>;
/**
 * Merge `storage` into the persisted pool. Use this for non-destructive
 * writes (quota cache, eligibility, last-used) so concurrent writers
 * do not silently drop each other's data.
 */
export declare function saveAccounts(storage: AccountStorageV4): Promise<void>;
/**
 * Save accounts storage by replacing the entire file (no merge).
 * Required for destructive operations like delete where the next-state
 * must replace — never be merged with — what is on disk.
 */
export declare function saveAccountsReplace(storage: AccountStorageV4): Promise<void>;
export declare function clearAccounts(): Promise<void>;
/**
 * Locate a stored account by its refresh token under the lock-held
 * mutator and apply `mutate(account)`. Returns the (possibly mutated)
 * account, or `undefined` when the token no longer matches any stored
 * account. Concurrent writers that add/remove accounts will not
 * disturb the lookup — the read happens while the lock is held.
 *
 * `mutate` may mutate `account` in place and return `true` to commit
 * the change; returning `false` is treated as "no change" and skips
 * the write.
 */
export declare function mutateAccountByRefreshToken(refreshToken: string, mutate: (account: AccountMetadataV3) => boolean): Promise<AccountMetadataV3 | undefined>;
//# sourceMappingURL=storage.d.ts.map