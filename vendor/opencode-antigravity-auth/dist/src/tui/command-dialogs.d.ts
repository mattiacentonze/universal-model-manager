/** @jsxImportSource @opentui/solid */
/**
 * Imperative command-dialog dispatcher for the /antigravity-* slash commands.
 *
 * Mirrors the fleet sibling layout (see `anthropic-auth-live` /
 * `openai-auth-live` `packages/opencode/src/tui/command-dialogs.tsx`):
 * each command's dialog opens with its data/status content rendered into the
 * dialog BODY as a column of plain `<text>` nodes — non-selectable,
 * non-searchable — and a separate `<DialogSelect>` below carries ONLY the
 * real actions with proper `{title, description}` shapes the host renders
 * on separate lines. The earlier implementation crammed the data rows into
 * `DialogSelect`'s `placeholder` (which participates in type-ahead search)
 * and concatenated label+description into a single highlighted option line;
 * this rewrite separates data from actions the way the host expects.
 *
 * Contract:
 * - Every main/subdialog calls `api.ui.dialog.setSize('xlarge')` before
 *   `api.ui.dialog.replace()` so the host reserves enough width for the
 *   longest line in any branch.
 * - `apply(command, args, options?)` is the RPC apply path the dispatch
 *   site (the module-scoped poll in `tui.tsx`) supplies. The dispatcher
 *   forwards `options.timeoutMs` so a long-running apply (account add /
 *   refresh, future quota refresh) gets the right RPC timeout.
 * - All `DialogSelect` options must remain VISIBLE — the host's
 *   `disabled: true` is a hard hide, so this file must never set it.
 *   Invalid actions stay visible with an explanatory description and are
 *   rejected in `onSelect`. The `no hide-property option scan` test in
 *   the verification gates pins this contract.
 * - `onSelect` awaits the apply, toasts the result, then either clears
 *   the dialog or replaces it for multi-step flows. The dialog stack
 *   never sees a `clear()` between apply and re-render so the user
 *   always sees feedback (per the dispatcher contract).
 */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import type { CommandModalName, OpenDialogPayload } from '../rpc/protocol';
/**
 * Apply handler the dispatcher calls when the user selects a dialog
 * option. Mirrors `ApplyRequest` from `rpc/protocol` plus the
 * `RpcRequestOptions.timeoutMs` knob the RPC client already accepts —
 * the call site in `tui.tsx` forwards these directly into
 * `rpcClient.apply(request, options)`.
 */
export type ApplyFn = (command: CommandModalName, args: string, options?: {
    timeoutMs?: number;
}) => Promise<{
    text: string;
    knobs: Record<string, unknown>;
}>;
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
export declare function openCommandDialog(api: TuiPluginApi, payload: OpenDialogPayload, apply: ApplyFn): void;
//# sourceMappingURL=command-dialogs.d.ts.map