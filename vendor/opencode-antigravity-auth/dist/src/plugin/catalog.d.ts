export declare function applyAntigravityProviderCatalog(config: Record<string, unknown>, providerId: string): void;
/**
 * Register every modal command with the host `config.command` map.
 *
 * Existing entries are preserved — the host may ship its own slash
 * commands (e.g. `init`, `undo`, …) and the merge must not blow them
 * away. `/gemini-dump` is registered in addition to the modal
 * `antigravity-dump` so legacy sessions keep working.
 *
 * This function is the FIRST of three places that must agree on the
 * set of modal commands — see the three-wiring test in
 * `commands.test.ts` for the invariant.
 */
export declare function registerAntigravityCommands(config: Record<string, unknown>): void;
export declare const ANTIGRAVITY_COMMAND_NAMES: {
    readonly quota: "antigravity-quota";
    readonly account: "antigravity-account";
    readonly routing: "antigravity-routing";
    readonly killswitch: "antigravity-killswitch";
    readonly dump: "antigravity-dump";
    readonly logging: "antigravity-logging";
};
//# sourceMappingURL=catalog.d.ts.map