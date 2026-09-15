/**
 * Persistent runtime operator settings.
 *
 * The /antigravity-* slash commands mutate this struct. The controller:
 *
 *   1. Loads the operator slice from the project config (if present)
 *      or the user config on first access, so a fresh plugin boot
 *      sees the user's previous choices.
 *   2. Updates the runtime settings immediately so the same plugin
 *      instance picks up the change without waiting for the file
 *      write to land.
 *   3. Serializes the change through `config/writer.ts` (fenced lock
 *      + atomic rename) so a crash mid-write cannot corrupt the
 *      persisted file.
 *   4. Exposes a single idempotent `dispose()` so it can be hooked
 *      into the plugin lifecycle without leaking timers or listeners.
 *
 * No raw OAuth refresh tokens ever live in this struct — killswitch
 * account overrides are keyed by sha256(refreshToken).slice(0,12).
 */
import { type OperatorSettings } from './config/operator-settings-schema';
export type { OperatorSettings } from './config/operator-settings-schema';
export { emptyOperatorSettings } from './config/operator-settings-schema';
export interface OperatorSettingsControllerOptions {
    projectConfigPath: string;
    userConfigPath: string;
}
export interface OperatorSettingsController {
    get(): OperatorSettings;
    update(mutator: (draft: OperatorSettings) => void): Promise<void>;
    dispose(): Promise<void>;
}
export declare function createOperatorSettingsController(options: OperatorSettingsControllerOptions): OperatorSettingsController;
/**
 * Hash a refresh token into the stable 12-char account key used by
 * the killswitch accounts override map. Centralizing the hash here
 * keeps the truncation invariant in one place.
 */
export declare function accountKeyForRefreshToken(refreshToken: string): string;
//# sourceMappingURL=operator-settings.d.ts.map