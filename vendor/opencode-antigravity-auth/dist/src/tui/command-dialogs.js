import { jsx as _jsx, jsxs as _jsxs } from "@opentui/solid/jsx-runtime";
/**
 * Mount the dialog for `payload.command` on the live TUI.
 *
 * The dispatcher branches on `payload.command` — each branch is
 * self-contained: render the data body, render the host DialogSelect
 * below it with the real actions, wire `onSelect` to await `apply(...)`,
 * then toast the result and clear (or replace for multi-step flows).
 * Unknown commands throw so a future command registered in
 * `MODAL_COMMANDS` without a dispatcher branch fails loudly at the first
 * dialog open.
 */
export function openCommandDialog(api, payload, apply) {
    if (payload.command === 'antigravity-dump') {
        renderDumpDialog(api, payload, apply);
        return;
    }
    if (payload.command === 'antigravity-logging') {
        renderLoggingDialog(api, payload, apply);
        return;
    }
    if (payload.command === 'antigravity-quota') {
        throw new Error('antigravity-quota is rendered by the TUI quota panel');
    }
    if (payload.command === 'antigravity-account') {
        renderAccountDialog(api, payload, apply);
        return;
    }
    if (payload.command === 'antigravity-routing') {
        renderRoutingDialog(api, payload, apply);
        return;
    }
    if (payload.command === 'antigravity-killswitch') {
        renderKillswitchDialog(api, payload, apply);
        return;
    }
    const exhaustiveCheck = payload.command;
    throw new Error(`Unknown command ${exhaustiveCheck}`);
}
// ---------------------------------------------------------------------------
// Fully wired branches — non-data-first dialogs.
// ---------------------------------------------------------------------------
/**
 * /antigravity-dump: three actions (on / off / status). Each selection
 * applies through the RPC, toasts the result text, and clears the
 * dialog. Status is a read-only check that still goes through apply so
 * the dump helper runs once and reports the current state.
 */
function renderDumpDialog(api, _payload, apply) {
    const DialogSelect = (api.ui.DialogSelect);
    api.ui.dialog.setSize('xlarge');
    api.ui.dialog.replace(() => (_jsx(DialogSelect, { title: 'Antigravity wire dump', options: [
            {
                title: 'Turn dump on',
                value: 'on',
                description: 'Write request and response bodies to the dump dir.',
            },
            {
                title: 'Turn dump off',
                value: 'off',
                description: 'Stop writing new dump files.',
            },
            {
                title: 'Show dump status',
                value: 'status',
                description: 'Display whether dumps are enabled and where they go.',
            },
        ], onSelect: (option) => {
            void apply('antigravity-dump', String(option.value)).then((result) => {
                api.ui.toast({ message: result.text });
                api.ui.dialog.clear();
            });
        } })));
}
/**
 * /antigravity-logging: every log level as an option. The dispatcher
 * forwards the level as the apply arg; the apply path persists it
 * through `OperatorSettingsController` and toasts the resolution text.
 */
function renderLoggingDialog(api, payload, apply) {
    const DialogSelect = (api.ui.DialogSelect);
    const current = payload.knobs.log_level ?? 'info';
    api.ui.dialog.setSize('xlarge');
    api.ui.dialog.replace(() => (_jsx(DialogSelect, { title: 'Antigravity logging', current: current, options: [
            { title: 'Error', value: 'error', description: 'Errors only.' },
            { title: 'Warn', value: 'warn', description: 'Warnings and errors.' },
            {
                title: 'Info',
                value: 'info',
                description: 'Default. Includes informational events.',
            },
            {
                title: 'Debug',
                value: 'debug',
                description: 'Includes debug-level events.',
            },
            {
                title: 'Trace',
                value: 'trace',
                description: 'Most verbose — every diagnostic event.',
            },
        ], onSelect: (option) => {
            void apply('antigravity-logging', String(option.value)).then((result) => {
                api.ui.toast({ message: result.text });
                api.ui.dialog.clear();
            });
        } })));
}
// ---------------------------------------------------------------------------
// Shared helpers — render data rows as plain text in the dialog body.
// ---------------------------------------------------------------------------
function formatQuotaRowLine(row) {
    const status = row.enabled ? '' : ' (disabled)';
    const current = row.current ? ' *' : '';
    if (row.quota.length === 0) {
        return `${row.label}${status}${current}: no cached quota`;
    }
    const parts = row.quota.map((q) => {
        const pct = q.remainingPercent == null ? '–%' : `${q.remainingPercent}%`;
        return `${q.label} ${pct}`;
    });
    return `${row.label}${status}${current}: ${parts.join(', ')}`;
}
/**
 * /antigravity-account data-first dialog.
 *
 * The body lists each account row as a plain `<text>` node (cache-only
 * — no network I/O on open). The DialogSelect carries ONLY real
 * actions: Add account… and one drill-in entry per row. Drill-in
 * navigates to a row-level subdialog that exposes toggle / set-current
 * / remove with a DialogConfirm gate for the destructive path.
 *
 * Each action calls `apply('antigravity-account', '<verb> <index>')`,
 * which the apply path translates into a locked-storage mutation.
 * The service returns fresh `CommandAccountRow[]`; the dialog mutates
 * its closed-over payload and re-renders via `renderMain()` so the
 * user never sees a clear-then-redraw gap.
 */
function renderAccountDialog(api, initialPayload, apply) {
    // Closed-over payload: every render reads from the latest snapshot.
    const payload = { ...initialPayload };
    const rowsFromKnobs = () => {
        const raw = payload.knobs.accounts;
        return Array.isArray(raw) ? raw : [];
    };
    const runApply = async (args, options) => {
        const result = await apply('antigravity-account', args, options);
        api.ui.toast({ message: result.text });
        const next = result.knobs.accounts;
        if (Array.isArray(next)) {
            payload.knobs = {
                ...payload.knobs,
                accounts: next,
            };
            renderMain();
            return next;
        }
        renderMain();
        return null;
    };
    const updateAccounts = (knobs) => {
        const accounts = knobs.accounts;
        if (!Array.isArray(accounts))
            return;
        payload.knobs = {
            ...payload.knobs,
            accounts: accounts,
        };
    };
    const openOAuthLabelPrompt = (code, oauthUrl) => {
        const DialogPrompt = api.ui.DialogPrompt;
        api.ui.dialog.setSize('xlarge');
        api.ui.dialog.replace(() => (_jsx(DialogPrompt, { title: 'OAuth sign-in \u2014 label', description: () => (_jsx("text", { children: "A short name for this account (optional)." })), placeholder: 'e.g. work', value: '', onConfirm: (value) => {
                const label = value.trim();
                const args = label
                    ? `add-oauth-finish ${code} --label ${label}`
                    : `add-oauth-finish ${code}`;
                void apply('antigravity-account', args, { timeoutMs: 120_000 })
                    .then((result) => {
                    api.ui.toast({ message: result.text });
                    updateAccounts(result.knobs);
                    renderMain();
                })
                    .catch(() => {
                    api.ui.toast({ message: 'OAuth account add failed' });
                    renderMain();
                });
            }, onCancel: () => openOAuthCodePrompt(oauthUrl) })));
    };
    const openOAuthCodePrompt = (oauthUrl) => {
        const DialogPrompt = api.ui.DialogPrompt;
        api.ui.dialog.setSize('xlarge');
        api.ui.dialog.replace(() => (_jsx(DialogPrompt, { title: 'OAuth sign-in \u2014 enter code', description: () => (_jsx("text", { children: "After signing in, paste the full callback URL or authorization code." })), placeholder: 'Paste callback URL or code here', value: '', onConfirm: (value) => {
                const code = value.trim();
                if (!code) {
                    // Empty submit must keep the user inside the flow, not
                    // silently drop them back to the account list. Surface the
                    // validation message and reopen the same prompt so the
                    // user can paste again.
                    api.ui.toast({
                        message: 'Please paste the callback URL or authorization code.',
                    });
                    openOAuthCodePrompt(oauthUrl);
                    return;
                }
                openOAuthLabelPrompt(code, oauthUrl);
            }, onCancel: () => openOAuthUrlScreen(oauthUrl) })));
    };
    const openOAuthUrlScreen = (oauthUrl) => {
        const DialogSelect = (api.ui.DialogSelect);
        api.ui.dialog.setSize('xlarge');
        api.ui.dialog.replace(() => (_jsx(DialogSelect, { title: 'OAuth sign-in', options: [
                {
                    title: 'Copy URL to clipboard',
                    value: 'copy',
                    description: oauthUrl,
                },
                {
                    title: 'Enter sign-in code',
                    value: 'code',
                    description: 'Open the URL in your browser, sign in, then paste the callback URL or code.',
                },
                { title: 'Cancel', value: 'cancel' },
            ], onSelect: (option) => {
                if (option.value === 'cancel') {
                    renderMain();
                    return;
                }
                if (option.value === 'copy') {
                    const copied = api.renderer.copyToClipboardOSC52(oauthUrl);
                    api.ui.toast({
                        message: copied
                            ? 'URL copied to clipboard'
                            : 'Copy unavailable — select the URL text above to copy',
                    });
                    openOAuthUrlScreen(oauthUrl);
                    return;
                }
                openOAuthCodePrompt(oauthUrl);
            } })));
    };
    const openAddOAuthStart = () => {
        void apply('antigravity-account', 'add-oauth-start', {
            timeoutMs: 120_000,
        })
            .then((result) => {
            updateAccounts(result.knobs);
            const oauthUrl = result.knobs.oauthUrl;
            if (typeof oauthUrl === 'string' && oauthUrl.length > 0) {
                openOAuthUrlScreen(oauthUrl);
                return;
            }
            api.ui.toast({ message: result.text });
            renderMain();
        })
            .catch(() => {
            api.ui.toast({ message: 'OAuth account add failed' });
            renderMain();
        });
    };
    const renderManageRow = (row) => {
        const DialogSelect = (api.ui.DialogSelect);
        api.ui.dialog.setSize('xlarge');
        api.ui.dialog.replace(() => (_jsxs("box", { flexDirection: 'column', padding: 1, width: '100%', children: [_jsx("text", { children: row.label }), _jsx("text", { children: row.quota.length === 0
                        ? 'no cached quota'
                        : row.quota
                            .map((q) => q.remainingPercent == null
                            ? `${q.label} –%`
                            : `${q.label} ${q.remainingPercent}%`)
                            .join(', ') }), _jsx("box", { marginTop: 1, children: _jsx(DialogSelect, { title: `Manage ${row.label}`, options: [
                            {
                                title: row.enabled ? 'Disable account' : 'Enable account',
                                value: `toggle ${row.index}`,
                                description: row.enabled
                                    ? 'Skip this account in rotation when its quota is low.'
                                    : 'Include this account in rotation again.',
                            },
                            {
                                title: 'Set as current',
                                value: `current ${row.index}`,
                                description: 'Pin this account as the active Claude + Gemini choice.',
                            },
                            {
                                title: 'Remove account…',
                                value: `__remove_prompt__ ${row.index}`,
                                description: 'Permanently delete this account from the local pool.',
                            },
                            {
                                title: 'Back',
                                value: '__back__',
                                description: 'Return to the account list.',
                            },
                        ], onSelect: (option) => {
                            const raw = String(option.value);
                            if (raw === '__back__') {
                                renderMain();
                                return;
                            }
                            if (raw.startsWith('__remove_prompt__ ')) {
                                const targetIndex = Number.parseInt(raw.split(' ')[1] ?? '', 10);
                                promptRemove(targetIndex);
                                return;
                            }
                            if (raw.startsWith('toggle ') || raw.startsWith('current ')) {
                                void runApply(raw, { timeoutMs: 2_000 }).catch(() => {
                                    api.ui.toast({
                                        message: `${row.label}: action failed`,
                                    });
                                });
                                return;
                            }
                            api.ui.toast({
                                message: `${row.label}: unknown action`,
                            });
                        } }) })] })));
    };
    const promptRemove = (index) => {
        const DialogConfirm = api.ui.DialogConfirm;
        const row = rowsFromKnobs()[index];
        api.ui.dialog.setSize('xlarge');
        api.ui.dialog.replace(() => (_jsx(DialogConfirm, { title: 'Remove account', message: `Permanently remove ${row?.label ?? `account ${index + 1}`} from the local pool? This cannot be undone.`, onConfirm: async () => {
                try {
                    const next = await runApply(`remove ${index}`, {
                        timeoutMs: 2_000,
                    });
                    if (next === null) {
                        renderMain();
                    }
                }
                catch {
                    api.ui.toast({ message: 'Account remove failed' });
                    renderMain();
                }
            }, onCancel: () => {
                renderMain();
            } })));
    };
    const renderMain = () => {
        const DialogSelect = (api.ui.DialogSelect);
        api.ui.dialog.setSize('xlarge');
        const rows = rowsFromKnobs();
        const bodyLines = rows.length
            ? rows.map(formatQuotaRowLine)
            : ['No accounts configured. Add one via the menu below.'];
        api.ui.dialog.replace(() => (_jsxs("box", { flexDirection: 'column', padding: 1, width: '100%', children: [bodyLines.map((line) => (_jsx("text", { children: line }))), _jsx("box", { marginTop: 1, children: _jsx(DialogSelect, { title: 'Antigravity accounts', options: [
                            {
                                title: 'Add account…',
                                value: 'add',
                                description: 'Open the OAuth flow to add a new account (120s timeout).',
                            },
                            ...rows.map((row) => ({
                                title: row.label,
                                value: `__manage__ ${row.index}`,
                                description: row.enabled
                                    ? row.current
                                        ? 'Current account — toggle, remove, or back.'
                                        : 'Enabled — toggle, set as current, or remove.'
                                    : 'Disabled — toggle to re-enable, or remove.',
                            })),
                            { title: 'Back', value: 'back' },
                        ], onSelect: (option) => {
                            const raw = String(option.value);
                            if (raw === 'back') {
                                api.ui.dialog.clear();
                                return;
                            }
                            if (raw === 'add') {
                                openAddOAuthStart();
                                return;
                            }
                            if (raw.startsWith('__manage__ ')) {
                                const targetIndex = Number.parseInt(raw.split(' ')[1] ?? '', 10);
                                const target = rows[targetIndex];
                                if (target)
                                    renderManageRow(target);
                                return;
                            }
                            api.ui.toast({ message: 'Unknown action' });
                        } }) })] })));
    };
    renderMain();
}
/**
 * /antigravity-routing data-first dialog.
 *
 * The body lists the current persisted values (`cli_first`,
 * `quota_style_fallback`) as plain `<text>` nodes so the data is
 * visible without filtering the action list. The DialogSelect carries
 * ONLY real toggle actions — each row flips exactly one flag, awaits
 * apply, toasts the result, and re-renders in place from the
 * freshly-returned state.
 *
 * Re-render contract mirrors the quota/account dialogs: the
 * closed-over `payload.knobs` is mutated with the apply response and
 * `renderMain()` is re-invoked. The dialog stack never sees a
 * `clear()` between apply and re-render.
 *
 * Error path: when apply returns a `knobs.error === true` payload
 * (lock contention, unreadable config), the dispatcher does NOT swap
 * the closed-over payload — the dialog stays mounted on the previous
 * state so the user can retry or back out. The error message was
 * already toasted by `runApply`.
 */
function renderRoutingDialog(api, initialPayload, apply) {
    // Closed-over payload: every render reads from the latest snapshot.
    const payload = { ...initialPayload };
    const readRouting = () => ({
        cliFirst: payload.knobs.cli_first === true,
        quotaFallback: payload.knobs.quota_style_fallback === true,
    });
    const runApply = async (args) => {
        const result = await apply('antigravity-routing', args, {
            timeoutMs: 2_000,
        });
        api.ui.toast({ message: result.text });
        if (result.knobs.error === true) {
            return;
        }
        payload.knobs = {
            ...payload.knobs,
            cli_first: result.knobs.cli_first,
            quota_style_fallback: result.knobs.quota_style_fallback,
        };
        renderMain();
    };
    const renderMain = () => {
        const DialogSelect = (api.ui.DialogSelect);
        api.ui.dialog.setSize('xlarge');
        const { cliFirst, quotaFallback } = readRouting();
        const bodyLines = [
            `cli_first: ${cliFirst ? 'on' : 'off'}`,
            `quota_style_fallback: ${quotaFallback ? 'on' : 'off'}`,
        ];
        api.ui.dialog.replace(() => (_jsxs("box", { flexDirection: 'column', padding: 1, width: '100%', children: [bodyLines.map((line) => (_jsx("text", { children: line }))), _jsx("box", { marginTop: 1, children: _jsx(DialogSelect, { title: 'Antigravity routing', options: [
                            {
                                title: `${cliFirst ? '●' : '○'} cli_first: ${cliFirst}`,
                                value: `cli_first=${!cliFirst}`,
                                description: cliFirst
                                    ? 'CLI is preferred before Antigravity. Click to turn off.'
                                    : 'Antigravity runs before CLI. Click to turn on.',
                            },
                            {
                                title: `${quotaFallback ? '●' : '○'} quota_style_fallback: ${quotaFallback}`,
                                value: `quota_style_fallback=${!quotaFallback}`,
                                description: quotaFallback
                                    ? 'Falls back to the alternate quota style on exhaustion. Click to turn off.'
                                    : 'No quota-style fallback today. Click to turn on.',
                            },
                            { title: 'Back', value: 'back' },
                        ], onSelect: (option) => {
                            const raw = String(option.value);
                            if (raw === 'back') {
                                api.ui.dialog.clear();
                                return;
                            }
                            if (!raw.startsWith('cli_first=') &&
                                !raw.startsWith('quota_style_fallback=')) {
                                api.ui.toast({ message: 'Unknown routing action' });
                                return;
                            }
                            void runApply(raw).catch(() => {
                                api.ui.toast({ message: 'Routing update failed' });
                                renderMain();
                            });
                        } }) })] })));
    };
    renderMain();
}
/**
 * /antigravity-killswitch data-first dialog.
 *
 * The body lists the current persisted killswitch state (`enabled`,
 * `minimum_remaining_percent`, and the per-account override map) as
 * plain `<text>` nodes. The DialogSelect carries ONLY real actions:
 * the global enabled toggle, the threshold-edit prompt, and a Back
 * affordance. The threshold edit opens a DialogPrompt for a fresh
 * integer in `0..100`; out-of-range input stays at the prompt without
 * applying.
 *
 * Re-render contract matches the routing dialog: the closed-over
 * `payload.knobs` is swapped to the apply response on success and
 * `renderMain()` re-runs. Errors leave the payload untouched.
 */
function renderKillswitchDialog(api, initialPayload, apply) {
    const payload = { ...initialPayload };
    const readKillswitch = () => {
        const enabled = payload.knobs.enabled === true;
        const rawMin = payload.knobs.minimum_remaining_percent;
        const minimum = typeof rawMin === 'number' && Number.isFinite(rawMin)
            ? Math.max(0, Math.min(100, Math.round(rawMin)))
            : 0;
        const rawAccounts = payload.knobs.accounts;
        const accounts = rawAccounts &&
            typeof rawAccounts === 'object' &&
            !Array.isArray(rawAccounts)
            ? rawAccounts
            : {};
        return { enabled, minimum, accounts };
    };
    const runApply = async (args) => {
        const result = await apply('antigravity-killswitch', args, {
            timeoutMs: 2_000,
        });
        api.ui.toast({ message: result.text });
        if (result.knobs.error === true) {
            return;
        }
        payload.knobs = {
            ...payload.knobs,
            enabled: result.knobs.enabled,
            minimum_remaining_percent: result.knobs.minimum_remaining_percent,
            accounts: result.knobs.accounts ?? {},
        };
        renderMain();
    };
    const openThresholdPrompt = (currentMinimum) => {
        const DialogPrompt = api.ui.DialogPrompt;
        api.ui.dialog.setSize('xlarge');
        api.ui.dialog.replace(() => (_jsx(DialogPrompt, { title: 'Antigravity killswitch \u2014 set threshold', description: () => (_jsx("text", { children: "Enter a new minimum_remaining_percent (0-100). Empty input cancels." })), placeholder: `${currentMinimum}`, value: `${currentMinimum}`, onConfirm: (value) => {
                const trimmed = value.trim();
                if (!trimmed) {
                    renderMain();
                    return;
                }
                const parsed = Number.parseInt(trimmed, 10);
                if (!Number.isInteger(parsed) ||
                    parsed < 0 ||
                    parsed > 100 ||
                    String(parsed) !== trimmed) {
                    api.ui.toast({
                        message: 'Threshold must be an integer between 0 and 100',
                    });
                    openThresholdPrompt(currentMinimum);
                    return;
                }
                void runApply(`minimum_remaining_percent=${parsed}`).catch(() => {
                    api.ui.toast({ message: 'Killswitch update failed' });
                    renderMain();
                });
            }, onCancel: () => {
                renderMain();
            } })));
    };
    const renderMain = () => {
        const DialogSelect = (api.ui.DialogSelect);
        api.ui.dialog.setSize('xlarge');
        const { enabled, minimum, accounts } = readKillswitch();
        const accountKeys = Object.keys(accounts);
        const bodyLines = [
            `Killswitch: ${enabled ? 'enabled' : 'disabled'}`,
            `Minimum remaining percent: ${minimum}%`,
            ...(accountKeys.length > 0
                ? [
                    'Per-account overrides:',
                    ...accountKeys.map((key) => `  ${key}: ${accounts[key] ?? 0}%`),
                ]
                : []),
        ];
        api.ui.dialog.replace(() => (_jsxs("box", { flexDirection: 'column', padding: 1, width: '100%', children: [bodyLines.map((line) => (_jsx("text", { children: line }))), _jsx("box", { marginTop: 1, children: _jsx(DialogSelect, { title: 'Antigravity killswitch', options: [
                            {
                                title: `${enabled ? '●' : '○'} Killswitch: ${enabled ? 'enabled' : 'disabled'}`,
                                value: `enabled=${!enabled}`,
                                description: enabled
                                    ? 'Drop candidates below the floor before dispatch. Click to turn off.'
                                    : 'Resume candidate selection regardless of quota. Click to turn on.',
                            },
                            {
                                title: `Set minimum remaining percent (${minimum}%)`,
                                value: '__edit_threshold__',
                                description: 'Prompt for a new global floor (0-100). Per-account overrides are listed above.',
                            },
                            { title: 'Back', value: 'back' },
                        ], onSelect: (option) => {
                            const raw = String(option.value);
                            if (raw === 'back') {
                                api.ui.dialog.clear();
                                return;
                            }
                            if (raw === '__edit_threshold__') {
                                openThresholdPrompt(minimum);
                                return;
                            }
                            if (raw === 'enabled=true' || raw === 'enabled=false') {
                                void runApply(raw).catch(() => {
                                    api.ui.toast({ message: 'Killswitch update failed' });
                                    renderMain();
                                });
                                return;
                            }
                            api.ui.toast({ message: 'Unknown killswitch action' });
                        } }) })] })));
    };
    renderMain();
}
//# sourceMappingURL=command-dialogs.js.map