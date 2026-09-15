/**
 * Atomic JSON file writer.
 *
 * Stages the payload at `${path}.${randomUUID()}.tmp` (same directory as
 * the target so the rename is atomic on POSIX, and uses the same NTFS
 * volume on Windows) and renames onto `path`. The `0o600` mode is enforced
 * on the staged file; on POSIX the rename replaces the target's inode so
 * the new file inherits the staged mode bits. Windows ignores POSIX mode
 * bits and relies on the current user's inherited ACL — we do not attempt
 * to harden ACLs from Node.
 *
 * Failures are deliberately NOT masked by a copy fallback: a blind
 * copy-then-unlink after a failing replace can paper over partial writes
 * and let concurrent writers silently corrupt state. The caller decides
 * whether to retry, surface, or back off.
 */
/**
 * Atomically serialize `value` as pretty-printed JSON and rename it onto
 * `path`. Throws if any step fails; the staged temp file is removed before
 * rethrow so no `${path}.<uuid>.tmp` is left behind.
 */
export declare function writeJsonAtomic(path: string, value: unknown): Promise<void>;
//# sourceMappingURL=atomic-write.d.ts.map