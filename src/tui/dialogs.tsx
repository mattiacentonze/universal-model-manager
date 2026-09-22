import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import {
  type AccountEntry,
  completeStep,
  dedupeAliases,
  loadConfig,
  type ProviderKind,
  type RouterRoutingMode,
  resetManager,
  saveConfig,
  syncUnifiedRouting,
  UNIFIED_ROUTING_MODES,
  type UnifiedRoutingMode,
} from "../manager/index.js";
import {
  getAccounts,
  loginActionFor,
  type NativeAction,
  reorderByManagerIds,
  routingModeAction,
  setMainByManagerId,
} from "../manager/provider-accounts.js";
import { allAdapters, getAdapter } from "../manager/provider-adapter.js";
import { findPortFile } from "../manager/quota-poller.js";
import { getOpenCodeConfigDir } from "../shared/paths.js";
import { dispatchNative } from "./native.js";
import {
  type CatalogModel,
  catalogModels,
  catalogVariants,
  chainTargets,
  type FallbackTarget,
  formatCleanModelName,
  missingTiers,
  nextMissingStep,
  TIERS,
  type TierName,
  tierVariantOptions,
} from "./wizard-core.js";

type Api = TuiPluginApi;
const configDir = () => getOpenCodeConfigDir();
const cfg = () => loadConfig(undefined, configDir());

const RESTART = "A restart may be required for config changes to take effect.";

/** Open a dialog at the widest size so long labels stay readable. */
function openDialog(api: Api, render: () => any) {
  api.ui.dialog.replace(render);
  api.ui.dialog.setSize("xlarge");
}

/** Friendly toast on native dispatch result. */
function toastResult(api: Api, res: { ok: boolean; text: string }) {
  api.ui.toast({
    variant: res.ok ? "success" : "error",
    title: res.ok ? "Dispatched" : "Not dispatched",
    message: res.text,
  });
}

function errorToast(api: Api, text: string) {
  api.ui.toast({ variant: "error", title: "Invalid", message: text });
}

function closeDialog(api: Api) {
  api.ui.dialog?.clear?.();
}

async function _applyRpcCommandSilently(provider: "antigravity" | "openai", command: string, args: string) {
  try {
    const portEntry = await findPortFile(provider);
    if (!portEntry) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const effectiveCommand =
      provider === "antigravity" && command === "google-routing" ? "antigravity-routing" : command;
    await fetch(`http://127.0.0.1:${portEntry.port}/rpc/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${portEntry.token}`,
      },
      body: JSON.stringify({ command: effectiveCommand, arguments: args }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
  } catch {}
}

/** OpenAI routing preference via the native /openai-routing command. */
const _openaiRouting = (): NativeAction => ({ ...routingModeAction("main-first"), command: "/openai-routing" });

/** Validate a model id and return a friendly error string, or null when valid. */
function modelError(id: string): string | null {
  if (!id.trim()) return "A model id is required.";
  if (!/^[^/]+\/[^/]+$/.test(id.trim())) return "Model id must be provider/model (e.g. openai/gpt-4o).";
  return null;
}

function openWizardAfter(api: Api, step?: string) {
  const p = step ?? nextMissingStep(cfg(), configDir());
  if (p === null) {
    openDialog(api, () => (
      <api.ui.DialogAlert
        title="Wizard complete"
        message={`All configured providers and settings are valid. ${RESTART}`}
        onConfirm={() => api.ui.dialog.clear()}
      />
    ));
    return;
  }
  if (p === "accounts") accountsWizard(api);
  else if (p === "tiers") tiersWizard(api);
  else routerWizard(api);
}

/* ------------------------------- Accounts ------------------------------- */

function accountsWizard(api: Api) {
  const accounts = getAccounts(configDir());
  const realReady = accounts.some((a) => a.configured);
  const authOpts = (provider: "openai" | "antigravity") => ({
    title: `Login to ${provider === "openai" ? "OpenAI / ChatGPT" : "Google Antigravity"} (native)`,
    value: `login-${provider}`,
    onSelect: () => {
      dispatchNative(api, loginActionFor(provider)).then((res) => toastResult(api, res));
      accountsWizard(api);
    },
  });
  const confirmAccounts = (skipAuth?: boolean) => {
    completeStep("accounts", { accounts: cfg().accounts, accountsSkipAuth: skipAuth }, undefined, configDir());
    openWizardAfter(api, "tiers");
  };
  openDialog(api, () => (
    <api.ui.DialogSelect
      title="Provider accounts"
      placeholder="Select"
      options={[
        {
          title: accounts.length ? `Found ${accounts.length} real account(s)` : "No real accounts found yet",
          value: "status",
          description: realReady
            ? "At least one provider has real credentials — you can continue."
            : "Login a provider or skip auth for an external provider (e.g. IIT).",
        },
        authOpts("openai"),
        authOpts("antigravity"),
        {
          title: realReady ? "Continue to model tiers" : "Continue anyway (login later)",
          value: "continue",
          description: realReady
            ? "At least one real provider is authenticated."
            : "Proceed now; you can log in later from the settings.",
          onSelect: () => confirmAccounts(false),
        },
        {
          title: "Skip native auth (use external provider, e.g. IIT)",
          value: "skip-auth",
          description:
            "Explicitly skip logging into OpenAI/Antigravity here; you authenticate an external provider externally.",
          onSelect: () => confirmAccounts(true),
        },
        { title: "Close", value: "close", onSelect: () => api.ui.dialog.clear() },
      ]}
    />
  ));
}

/**
 * Real account management: enumerate real provider accounts and route actions
 * (login / set-main / order) to native commands — no fake local state.
 *  - OpenAI's primary cannot be swapped from config, so "set main" here maps to
 *    the native ROUTING preference (/openai-routing), never a false "replaces
 *    primary" claim.
 *  - Antigravity main is written to the real store AND the runtime "current"
 *    command is dispatched via native so the live AccountManager stays in sync.
 */
export type { UnifiedRoutingMode };

export const UNIFIED_ROUTING_OPTIONS: Array<{
  title: string;
  value: UnifiedRoutingMode;
  description: string;
}> = [
  {
    title: "Main first (recommended)",
    value: "main-first",
    description: "Prefer primary model/account, switch only on failure.",
  },
  {
    title: "Load balancing",
    value: "load-balancing",
    description: "Distribute requests across accounts evenly.",
  },
  {
    title: "Latency based",
    value: "latency-based",
    description: "Route to lowest-latency account using moving-average telemetry.",
  },
  {
    title: "Cost based",
    value: "cost-based",
    description: "Route to cheapest account based on usage and pricing telemetry.",
  },
  {
    title: "Usage based",
    value: "usage-based",
    description: "Route to account with most quota headroom.",
  },
];

export function promptRoutingScope(api: Api, title: string, onSelectScope: (scope: "session" | "all") => void) {
  openDialog(api, () => (
    <api.ui.DialogSelect
      title={`${title} - Choose scope`}
      placeholder="Select scope"
      options={[
        {
          title: "Apply to all sessions (save to config)",
          value: "all",
          description: "Persists to configuration. A restart may be required for background sessions.",
          onSelect: () => {
            closeDialog(api);
            onSelectScope("all");
          },
        },
        {
          title: "Apply to current session only",
          value: "session",
          description: "Active immediately for the current conversation without modifying persistent config.",
          onSelect: () => {
            closeDialog(api);
            onSelectScope("session");
          },
        },
      ]}
    />
  ));
}

export function openRoutingSelector(
  api: Api,
  target: "manager" | "openai" | "google" | "opencode",
  onDone?: () => void,
) {
  const titleMap = {
    manager: "Model Manager routing mode",
    openai: "OpenAI account routing mode",
    google: "Google account routing strategy",
    opencode: "OpenCode Zen routing mode",
  };
  const title = titleMap[target];

  openDialog(api, () => (
    <api.ui.DialogSelect
      title={title}
      placeholder="Select routing mode"
      options={[
        ...UNIFIED_ROUTING_OPTIONS.map((opt) => ({
          title: opt.title,
          value: opt.value,
          description: opt.description,
          onSelect: () => {
            closeDialog(api);
            void syncUnifiedRouting(api, opt.value).then(() => {
              onDone?.();
            });
          },
        })),
        {
          title: "< Back",
          value: "__back",
          onSelect: () => {
            if (onDone) onDone();
            else closeDialog(api);
          },
        },
      ]}
    />
  ));
}

export function getOpenAIRoutingMode(): string {
  try {
    const c = cfg();
    if (c.router?.routing?.mode) return c.router.routing.mode;
    const p = join(configDir(), "openai-auth.json");
    if (existsSync(p)) {
      const data = JSON.parse(readFileSync(p, "utf8"));
      return data?.routing?.mode || "main-first";
    }
  } catch {}
  return "main-first";
}

export function setOpenAIRoutingMode(api: Api, mode: UnifiedRoutingMode, _scope: "session" | "all" = "all") {
  void syncUnifiedRouting(api, mode);
}

export function getGoogleRoutingMode(dir = configDir()): UnifiedRoutingMode {
  try {
    const p = join(dir, "google.json");
    if (existsSync(p)) {
      const data = JSON.parse(readFileSync(p, "utf8"));
      const m = data?.account_selection_strategy || data?.routing_mode;
      if (m === "round-robin") return "load-balancing";
      if (m === "hybrid" || m === "sticky-balanced" || m === "balanced") return "load-balancing";
      if (m === "sticky" || m === "main-first") return "main-first";
      if (UNIFIED_ROUTING_MODES.includes(m)) return m;
    }
    const agPath = join(dir, "antigravity.json");
    if (existsSync(agPath)) {
      const data = JSON.parse(readFileSync(agPath, "utf8"));
      const m = data?.account_selection_strategy || data?.routing_mode;
      if (m === "round-robin") return "load-balancing";
      if (m === "hybrid" || m === "sticky-balanced" || m === "balanced") return "load-balancing";
      if (m === "sticky" || m === "main-first") return "main-first";
      if (UNIFIED_ROUTING_MODES.includes(m)) return m;
    }
    const c = loadConfig(undefined, dir);
    if (c.router?.routing?.mode) return c.router.routing.mode;
  } catch {}
  return "main-first";
}

export function setGoogleRoutingMode(api: Api, mode: UnifiedRoutingMode, _scope: "session" | "all" = "all") {
  void syncUnifiedRouting(api, mode);
}

export function setOpenCodeZenRoutingMode(api: Api, mode: UnifiedRoutingMode, _scope: "session" | "all" = "all") {
  void syncUnifiedRouting(api, mode);
}

export function setRouterRoutingMode(
  api: Api,
  mode: RouterRoutingMode | UnifiedRoutingMode,
  _scope: "session" | "all" = "all",
) {
  const unified: UnifiedRoutingMode = (
    mode === "sticky"
      ? "main-first"
      : mode === "balanced" || mode === "sticky-balanced" || mode === "round-robin"
        ? "load-balancing"
        : mode
  ) as UnifiedRoutingMode;
  void syncUnifiedRouting(api, unified);
}

/**
 * Generic 3-level account management dialog, provider-agnostic:
 *   Level 1 (providers) -> Level 2 (accounts of a provider, priority order)
 *   -> Level 3 (per-account actions).
 * All providers share one code path via the adapter registry.
 */

/** Reorder an account by `delta` positions within its own provider's slice of cfg.accounts. */
function moveAccount(cfg: ReturnType<typeof loadConfig>, accountId: string, delta: number): AccountEntry[] {
  const accounts = [...cfg.accounts];
  const idx = accounts.findIndex((a) => a.id === accountId);
  if (idx === -1) return accounts;
  const kind = accounts[idx].kind;
  const kindIdx = accounts.findIndex((a) => a.kind === kind);
  const kindEnd = accounts.findIndex((a, i) => i > kindIdx && a.kind !== kind);
  const sliceStart = kindIdx;
  const sliceEnd = kindEnd === -1 ? accounts.length : kindEnd;
  const rel = idx - sliceStart;
  const target = rel + delta;
  if (target < 0 || target >= sliceEnd - sliceStart) return accounts;
  const slice = accounts.slice(sliceStart, sliceEnd);
  const [moved] = slice.splice(rel, 1);
  slice.splice(target, 0, moved);
  return [...accounts.slice(0, sliceStart), ...slice, ...accounts.slice(sliceEnd)];
}

/** Level 3: per-account actions (rename, move, delete, set main). */
function accountActions(api: Api, kind: ProviderKind, accountId: string) {
  const refresh = () => accountActions(api, kind, accountId);
  const back = () => providerAccounts(api, kind);
  const account = cfg().accounts.find((a) => a.id === accountId);
  if (!account) {
    back();
    return;
  }
  const title = `${account.alias ? `[${account.alias}] ` : ""}${account.label}`;
  const accountsOfKind = cfg().accounts.filter((a) => a.kind === kind);
  const index = accountsOfKind.findIndex((a) => a.id === accountId);
  const isFirst = index === 0;
  const isLast = index === accountsOfKind.length - 1;

  const persistOrder = (next: AccountEntry[]) => {
    const orderedIds = next.filter((a) => a.kind === kind).map((a) => a.id);
    const c = cfg();
    c.accounts = next;
    saveConfig(c);
    void reorderByManagerIds(configDir(), orderedIds).then((res) => {
      if (res.kind === "delegate") {
        dispatchNative(api, res.action).then((r) => toastResult(api, r));
      } else {
        api.ui.toast({ variant: res.kind === "applied" ? "success" : "error", title: "Reorder", message: res.text });
      }
    });
  };

  openDialog(api, () => (
    <api.ui.DialogSelect
      title={title}
      placeholder="Select action"
      options={[
        ...(!account.main
          ? [
              {
                title: "Set as main account",
                value: "set-main",
                description: `Designate ${account.label} as the primary active account`,
                onSelect: async () => {
                  await setMainByManagerId(configDir(), accountId);
                  api.ui.toast({
                    variant: "success",
                    title: "Main account updated",
                    message: `${account.label} is now main.`,
                  });
                  refresh();
                },
              },
            ]
          : []),
        {
          title: `Rename alias (current: ${account.alias || "none"})`,
          value: "rename-alias",
          description: "Set a short identifier used in fallback chains (e.g. work, personal)",
          onSelect: () => {
            openDialog(api, () => (
              <api.ui.DialogPrompt
                title={`Rename alias for ${account.label}`}
                placeholder="alias (e.g. work, personal)"
                value={account.alias ?? ""}
                onCancel={refresh}
                onConfirm={(alias) => {
                  const c = cfg();
                  const acc = c.accounts.find((x) => x.id === accountId);
                  if (acc) acc.alias = alias.trim() || undefined;
                  c.accounts = dedupeAliases(c.accounts);
                  saveConfig(c);
                  api.ui.toast({ variant: "success", title: "Alias updated", message: RESTART });
                  refresh();
                }}
              />
            ));
          },
        },
        ...(!isFirst
          ? [
              {
                title: "Move up",
                value: "move-up",
                description: "Increase this account's priority",
                onSelect: () => {
                  persistOrder(moveAccount(cfg(), accountId, -1));
                  api.ui.toast({ variant: "success", title: "Account moved up", message: RESTART });
                  refresh();
                },
              },
            ]
          : []),
        ...(!isLast
          ? [
              {
                title: "Move down",
                value: "move-down",
                description: "Decrease this account's priority",
                onSelect: () => {
                  persistOrder(moveAccount(cfg(), accountId, 1));
                  api.ui.toast({ variant: "success", title: "Account moved down", message: RESTART });
                  refresh();
                },
              },
            ]
          : []),
        {
          title: "Delete account",
          value: "delete",
          description: "Remove this account from the manager",
          onSelect: () => {
            openDialog(api, () => (
              <api.ui.DialogConfirm
                title={`Delete ${title}?`}
                message={`Remove ${account.label} from the manager account list?`}
                onConfirm={() => {
                  const c = cfg();
                  c.accounts = c.accounts.filter((a) => a.id !== accountId);
                  saveConfig(c);
                  api.ui.toast({ variant: "success", title: "Account removed", message: RESTART });
                  back();
                }}
                onCancel={refresh}
              />
            ));
          },
        },
        { title: "< Back", value: "__back", onSelect: back },
      ]}
    />
  ));
}

/** Level 2: accounts of one provider in priority order (main first, then fallbacks). */
function providerAccounts(api: Api, kind: ProviderKind) {
  const adapter = getAdapter(kind);
  const accounts = cfg().accounts.filter((a) => a.kind === kind);
  const ordered = [...accounts].sort((a, b) => Number(b.main) - Number(a.main));

  openDialog(api, () => (
    <api.ui.DialogSelect
      title={`${adapter.displayName} accounts`}
      placeholder="Select account"
      options={[
        ...ordered.map((a, i) => ({
          title: `${a.alias ? `[${a.alias}] ` : ""}${a.label}${a.main ? " (main)" : ""}`,
          value: a.id,
          description: `Priority ${i + 1} — click to manage`,
          onSelect: () => accountActions(api, kind, a.id),
        })),
        { title: "< Back", value: "__back", onSelect: () => accountsSettings(api) },
      ]}
    />
  ));
}

/** Level 1: providers that have at least one account, plus "Add a new account". */
export function accountsSettings(api: Api) {
  const accounts = cfg().accounts;
  const kinds = [...new Set(accounts.map((a) => a.kind))];
  const refresh = () => accountsSettings(api);

  const addAccount = () => {
    openDialog(api, () => (
      <api.ui.DialogSelect
        title="Add a new account"
        placeholder="Select provider"
        options={[
          ...allAdapters().map((adapter) => ({
            title: adapter.displayName,
            value: adapter.kind,
            description: "Run the native login flow to add an account",
            onSelect: () => {
              dispatchNative(api, adapter.loginAction()).then((res) => {
                toastResult(api, res);
                refresh();
              });
            },
          })),
          { title: "< Back", value: "__back", onSelect: refresh },
        ]}
      />
    ));
  };

  openDialog(api, () => (
    <api.ui.DialogSelect
      title="Accounts"
      placeholder="Select a provider or action"
      options={[
        {
          title: "Add a new account",
          value: "__add",
          description: "Login to a provider via the native connect flow",
          onSelect: addAccount,
        },
        ...kinds.map((kind) => {
          const adapter = getAdapter(kind);
          const count = accounts.filter((a) => a.kind === kind).length;
          return {
            title: adapter.displayName,
            value: kind,
            description: `${count} account${count === 1 ? "" : "s"} — click to manage`,
            onSelect: () => providerAccounts(api, kind),
          };
        }),
        { title: "Close", value: "close", onSelect: () => api.ui.dialog.clear() },
      ]}
    />
  ));
}

/* -------------------------------- Tiers --------------------------------- */

function persistChain(api: Api, tier: TierName, patch: Record<string, unknown>) {
  try {
    completeStep("tiers", { [tier]: patch } as never, undefined, configDir());
  } catch (err) {
    errorToast(api, err instanceof Error ? err.message : "Could not save chain.");
  }
}

/** Provider → model → variant → fallback picker using the real catalog when available. */
function pickModel(api: Api, tier: TierName) {
  const models = catalogModels(api);
  const providers = [...new Set(models.map((m) => m.provider))];
  openDialog(api, () => (
    <api.ui.DialogSelect
      title={`${tier}: choose provider`}
      placeholder="Select provider"
      options={[
        ...providers.map((p) => ({
          title: p,
          value: p,
          onSelect: () => {
            const of = models.filter((m) => m.provider === p);
            openDialog(api, () => (
              <api.ui.DialogSelect
                title={`${tier}: choose model (${p})`}
                placeholder="Select model"
                options={[
                  ...of.map((m) => ({
                    title: m.label,
                    value: m.id,
                    description: m.variant ? `variant: ${m.variant}` : undefined,
                    onSelect: () => {
                      persistChain(api, tier, { model: m.id });
                      pickVariant(api, tier, m);
                    },
                  })),
                  { title: "Custom model id (manual)", value: "__custom", onSelect: () => promptModelId(api, tier, p) },
                  { title: "Back", value: "__back", onSelect: () => pickModel(api, tier) },
                ]}
              />
            ));
          },
        })),
        { title: "Custom provider id (manual)", value: "__custom", onSelect: () => promptModelId(api, tier, "") },
        { title: "Cancel", value: "__cancel", onSelect: () => showTier(api, tier) },
      ]}
    />
  ));
}

function promptModelId(api: Api, tier: TierName, provider: string) {
  openDialog(api, () => (
    <api.ui.DialogPrompt
      title={`${tier}: custom model id (provider/model)`}
      description={() => <text>Enter a full model id like openai/gpt-4o.</text>}
      placeholder="provider/model"
      value={provider ? `${provider}/` : ""}
      onCancel={() => pickModel(api, tier)}
      onConfirm={(id) => {
        const err = modelError(id);
        if (err) {
          errorToast(api, err);
          promptModelId(api, tier, provider);
          return;
        }
        const full = id.includes("/") ? id : provider ? `${provider}/${id}` : id;
        const m: CatalogModel = { provider: provider || full.split("/")[0], id: full, label: full };
        persistChain(api, tier, { model: full });
        pickVariant(api, tier, m);
      }}
    />
  ));
}

function pickVariant(api: Api, tier: TierName, m: CatalogModel) {
  const current = cfg().router.tiers[tier].variant;
  const known = catalogVariants(m.id, catalogModels(api));
  const variants = tierVariantOptions(m.id, known, current);
  openDialog(api, () => (
    <api.ui.DialogSelect
      title={`${tier}: variant for ${m.label}`}
      placeholder="Select variant"
      options={[
        ...variants.map((v) => ({
          title: v.value ?? "Default (no variant)",
          value: v.value ?? "",
          onSelect: () => {
            persistChain(api, tier, { model: m.id, variant: v.value });
            fallbackEditor(api, tier, m.id, v.value);
          },
        })),
        { title: "Cancel", value: "__cancel", onSelect: () => showTier(api, tier) },
      ]}
    />
  ));
}

/** Ordered fallback target editor (model + variant), source of truth = tierTargets. */
function fallbackEditor(api: Api, tier: TierName, model: string, variant: string | undefined) {
  openDialog(api, () => fallbackOptions(api, tier, model, variant));
}

function renderTargets(_api: Api, tier: TierName): FallbackTarget[] {
  try {
    return chainTargets(cfg().router.tiers[tier]);
  } catch {
    return [];
  }
}

/**
 * Format a model target as:
 *   [alias/]provider/model[(variant)]
 * Example without alias: `openai/gpt-6-astra (medium)`
 * Example with alias: `work/openai/gpt-6-astra (medium)`
 * No leading slash if no alias!
 */
export function formatTargetRaw(item: { model: string; alias?: string; variant?: string }): string {
  if (!item.model) return "";
  const aliasPart = item.alias ? `${item.alias}/` : "";
  const variantPart = item.variant ? ` (${item.variant})` : "";
  return `${aliasPart}${item.model}${variantPart}`;
}

/**
 * Format a full chain:
 *   primary -> fallback1 -> fallback2
 */
export function formatChainString(
  primary: { model: string; alias?: string; variant?: string },
  fallbacks: Array<{ model: string; alias?: string; variant?: string } | string>,
): string {
  const parts: string[] = [];
  if (primary.model) {
    parts.push(formatTargetRaw(primary));
  }
  for (const fb of fallbacks) {
    if (typeof fb === "string") {
      if (fb) parts.push(formatTargetRaw({ model: fb }));
    } else if (fb?.model) {
      parts.push(formatTargetRaw(fb));
    }
  }
  return parts.join(" -> ");
}

/** Display form of a fallback target: alias/provider/model (variant). */
function targetLabel(t: FallbackTarget): string {
  return formatTargetRaw(t);
}

/** Build a fallback target, omitting empty alias/variant keys. */
function makeTarget(alias: string, model: string, variant?: string): FallbackTarget {
  const t: FallbackTarget = { model, ...(variant ? { variant } : {}) };
  if (alias) t.alias = alias;
  return t;
}

function fallbackOptions(
  api: Api,
  tier: TierName,
  model: string,
  variant: string | undefined,
  targets?: FallbackTarget[],
) {
  const list = targets ?? renderTargets(api, tier);
  const commit = (next: FallbackTarget[]) => {
    persistChain(api, tier, { model, variant, targets: next });
    fallbackEditor(api, tier, model, variant);
  };
  const models = catalogModels(api);
  const aliases = [
    ...new Set(
      cfg()
        .accounts.map((a) => a.alias)
        .filter((x): x is string => !!x),
    ),
  ];

  const addFallbackTarget = () => {
    openDialog(api, () => (
      <api.ui.DialogSelect
        title={`${tier.toUpperCase()}: choose fallback model`}
        placeholder="Select model from catalog"
        options={[
          ...models.map((m) => ({
            title: m.label,
            value: m.id,
            description: m.id,
            onSelect: () => {
              const variants = catalogVariants(m.id, models);
              if (variants.length > 0) {
                openDialog(api, () => (
                  <api.ui.DialogSelect
                    title={`${tier.toUpperCase()}: variant for ${m.label}`}
                    placeholder="Select reasoning variant"
                    options={[
                      {
                        title: "Default (no variant)",
                        value: "",
                        onSelect: () => pickAliasForModel(m.id, undefined),
                      },
                      ...variants.map((v) => ({
                        title: v,
                        value: v,
                        onSelect: () => pickAliasForModel(m.id, v),
                      })),
                      {
                        title: "< Back",
                        value: "__back",
                        onSelect: () => addFallbackTarget(),
                      },
                    ]}
                  />
                ));
              } else {
                pickAliasForModel(m.id, undefined);
              }
            },
          })),
          {
            title: "Custom model id (manual)",
            value: "__custom",
            onSelect: () => {
              openDialog(api, () => (
                <api.ui.DialogPrompt
                  title={`${tier.toUpperCase()}: custom model id`}
                  placeholder="provider/model"
                  onCancel={() => fallbackEditor(api, tier, model, variant)}
                  onConfirm={(id) => {
                    const err = modelError(id);
                    if (err) {
                      errorToast(api, err);
                      return;
                    }
                    pickAliasForModel(id.trim(), undefined);
                  }}
                />
              ));
            },
          },
          {
            title: "< Back",
            value: "__back",
            onSelect: () => fallbackEditor(api, tier, model, variant),
          },
        ]}
      />
    ));
  };

  const pickAliasForModel = (modelId: string, modelVariant?: string) => {
    openDialog(api, () => (
      <api.ui.DialogSelect
        title={`${tier.toUpperCase()}: account alias for ${formatCleanModelName(modelId)}`}
        placeholder="Select account alias"
        options={[
          {
            title: "No alias (default)",
            value: "__none",
            description: "Use default provider account",
            onSelect: () => commit([...list, makeTarget("", modelId, modelVariant)]),
          },
          ...aliases.map((a) => ({
            title: a,
            value: a,
            onSelect: () => commit([...list, makeTarget(a, modelId, modelVariant)]),
          })),
          {
            title: "Custom alias (manual)",
            value: "__custom",
            onSelect: () => {
              openDialog(api, () => (
                <api.ui.DialogPrompt
                  title={`${tier.toUpperCase()}: custom alias`}
                  placeholder="alias"
                  onCancel={() => fallbackEditor(api, tier, model, variant)}
                  onConfirm={(a) => commit([...list, makeTarget(a.trim() || "main", modelId, modelVariant)])}
                />
              ));
            },
          },
          {
            title: "< Back",
            value: "__back",
            onSelect: () => addFallbackTarget(),
          },
        ]}
      />
    ));
  };

  const opts: { title: string; value: string; onSelect?: () => void; description?: string }[] = [
    {
      title: "+ Add fallback",
      value: "__add",
      description: "Choose a model to append to chain",
      onSelect: () => addFallbackTarget(),
    },
    ...list.map((t, i) => ({
      title: `Fallback ${i + 1}: ${targetLabel(t)}`,
      value: t.model,
      description: "Select to reorder/remove/rename",
      onSelect: () => {
        const sub: { title: string; value: string; onSelect?: () => void }[] = [
          ...(i > 0
            ? [
                {
                  title: "Move up",
                  value: "up",
                  onSelect: () => {
                    const n = [...list];
                    [n[i - 1], n[i]] = [n[i], n[i - 1]];
                    commit(n);
                  },
                },
              ]
            : []),
          ...(i < list.length - 1
            ? [
                {
                  title: "Move down",
                  value: "down",
                  onSelect: () => {
                    const n = [...list];
                    [n[i + 1], n[i]] = [n[i], n[i + 1]];
                    commit(n);
                  },
                },
              ]
            : []),
          {
            title: "Rename alias",
            value: "rename",
            onSelect: () => {
              openDialog(api, () => (
                <api.ui.DialogPrompt
                  title={`${tier.toUpperCase()}: rename alias for ${t.model}`}
                  placeholder="alias"
                  value={t.alias ?? ""}
                  onCancel={() => fallbackEditor(api, tier, model, variant)}
                  onConfirm={(a) => {
                    const n = [...list];
                    n[i] = { ...n[i], alias: a.trim() || undefined };
                    commit(n);
                  }}
                />
              ));
            },
          },
          { title: "Remove", value: "remove", onSelect: () => commit(list.filter((_, j) => j !== i)) },
          { title: "< Back", value: "__back", onSelect: () => fallbackEditor(api, tier, model, variant) },
        ];
        openDialog(api, () => (
          <api.ui.DialogSelect
            title={`${tier.toUpperCase()}: ${targetLabel(t)}`}
            placeholder="Select action"
            options={sub}
          />
        ));
      },
    })),
    { title: "< Done / Back", value: "__done", onSelect: () => routerSettings(api) },
  ];
  return (
    <api.ui.DialogSelect
      title={`${tier.toUpperCase()}: ${formatChainString({ model, variant }, list)}`}
      placeholder="Select"
      options={opts}
    />
  );
}

/** Tier menu: model / variant / fallback edits plus resume navigation. */
function showTier(api: Api, tier: TierName) {
  const chain = cfg().router.tiers[tier];
  openDialog(api, () => (
    <api.ui.DialogSelect
      title={`Set up ${tier.toUpperCase()} tier`}
      placeholder="Select"
      options={[
        {
          title: `${tier.toUpperCase()} current: ${formatCleanModelName(chain.model) || "unset"}${chain.variant ? ` (${chain.variant})` : ""}`,
          value: "status",
        },
        { title: "Choose model", value: "model", onSelect: () => pickModel(api, tier) },
        ...(chain.model
          ? [
              {
                title: "Edit variant",
                value: "variant",
                onSelect: () =>
                  pickVariant(api, tier, {
                    provider: chain.model.split("/")[0],
                    id: chain.model,
                    label: formatCleanModelName(chain.model),
                    variant: chain.variant,
                  }),
              },
            ]
          : []),
        ...(chain.model
          ? [
              {
                title: "Edit fallback order",
                value: "fb",
                onSelect: () => fallbackEditor(api, tier, chain.model, chain.variant),
              },
            ]
          : []),
        { title: "< Back", value: "back", onSelect: () => routerSettings(api) },
        { title: "Cancel", value: "close", onSelect: () => api.ui.dialog.clear() },
      ]}
    />
  ));
}

/** Walk each missing tier in order, resuming at the first gap (no skipping). */
function tiersWizard(api: Api) {
  const missing = missingTiers(cfg());
  const tier = missing[0] ?? TIERS[0];
  const chain = cfg().router.tiers[tier] ?? { model: "", fallback: [] };
  const confirmTier = () => {
    if (chain.model) persistChain(api, tier, { model: chain.model, variant: chain.variant, fallback: chain.fallback });
    const rest = missingTiers(cfg());
    if (rest.length === 0) openWizardAfter(api, "router");
    else tiersWizard(api);
  };
  openDialog(api, () => (
    <api.ui.DialogSelect
      title={`Set up ${tier} tier (${missing.includes(tier) ? "needs confirmation" : `>${missing.length} remaining`})`}
      placeholder="Select"
      options={[
        {
          title: `${tier} current: ${formatCleanModelName(chain.model) || "unset"}${chain.variant ? ` (${chain.variant})` : ""}`,
          value: "status",
          description: "Defaults are suggestions — confirm each tier to mark it done.",
        },
        { title: "Choose model", value: "model", onSelect: () => pickModel(api, tier) },
        ...(chain.model
          ? [
              {
                title: "Edit variant",
                value: "variant",
                onSelect: () =>
                  pickVariant(api, tier, {
                    provider: chain.model.split("/")[0],
                    id: chain.model,
                    label: formatCleanModelName(chain.model),
                    variant: chain.variant,
                  }),
              },
            ]
          : []),
        ...(chain.model
          ? [
              {
                title: "Edit fallback order",
                value: "fb",
                onSelect: () => fallbackEditor(api, tier, chain.model, chain.variant),
              },
            ]
          : []),
        ...(chain.model
          ? [{ title: "Confirm this tier (accept current)", value: "confirm", onSelect: confirmTier }]
          : []),
        {
          title: "Skip to next tier",
          value: "skip",
          onSelect: () => {
            const rest = missing.slice(1);
            if (rest.length === 0) openWizardAfter(api, missingTiers(cfg()).length === 0 ? "router" : undefined);
            else showTier(api, rest[0]);
          },
        },
        { title: "Cancel", value: "close", onSelect: () => api.ui.dialog.clear() },
      ]}
    />
  ));
}

/* -------------------------------- Router & Orchestrator -------------------------------- */

function routerWizard(api: Api) {
  const r = cfg().router;
  const saveOrchestrator = (orchestrator: string, enabled: boolean) => {
    const err = modelError(orchestrator);
    if (err) {
      errorToast(api, err);
      return;
    }
    completeStep("router", { orchestrator, enabled }, undefined, configDir());
    api.ui.toast({ variant: "success", title: "Router saved", message: RESTART });
    openWizardAfter(api);
  };
  openDialog(api, () => (
    <api.ui.DialogSelect
      title="Router + orchestrator"
      placeholder="Select"
      options={[
        { title: `Router: ${r.enabled ? "enabled" : "disabled"}`, value: "status" },
        {
          title: r.enabled ? "Disable router" : "Enable router",
          value: "toggle",
          onSelect: () =>
            openDialog(api, () => (
              <api.ui.DialogPrompt
                title="Router orchestrator"
                description={() => <text>Current: {formatCleanModelName(r.orchestrator)}</text>}
                placeholder="provider/model"
                value={r.orchestrator}
                onCancel={() => routerWizard(api)}
                onConfirm={(orchestrator) => saveOrchestrator(orchestrator, !r.enabled)}
              />
            )),
        },
        { title: "Complete wizard", value: "complete", onSelect: () => openWizardAfter(api) },
        { title: "Close", value: "close", onSelect: () => api.ui.dialog.clear() },
      ]}
    />
  ));
}

/** Rich orchestrator configuration menu (model list, variant, account, fallbacks). */
function orchestratorMenu(api: Api) {
  const r = cfg().router;
  const currentVariant = r.orchestratorVariant;
  const currentFallbacks = r.orchestratorFallbacks ?? [];

  const saveOrch = (patch: {
    orchestrator?: string;
    orchestratorVariant?: string;
    orchestratorFallbacks?: string[];
  }) => {
    const nextOrch = patch.orchestrator ?? r.orchestrator;
    const nextVariant = patch.orchestratorVariant !== undefined ? patch.orchestratorVariant : r.orchestratorVariant;
    const nextFallbacks =
      patch.orchestratorFallbacks !== undefined ? patch.orchestratorFallbacks : r.orchestratorFallbacks;

    completeStep(
      "router",
      {
        orchestrator: nextOrch,
        enabled: r.enabled,
        orchestratorVariant: nextVariant || undefined,
        orchestratorFallbacks: nextFallbacks,
      },
      undefined,
      configDir(),
    );
    api.ui.toast({ variant: "success", title: "Orchestrator updated", message: RESTART });
  };

  openDialog(api, () => (
    <api.ui.DialogSelect
      title={`Orchestrator: ${formatChainString({ model: r.orchestrator, variant: currentVariant }, currentFallbacks)}`}
      placeholder="Select setting to adjust"
      options={[
        {
          title: `Current model: ${formatCleanModelName(r.orchestrator)}`,
          value: "current",
          description: r.orchestrator,
        },
        {
          title: "Choose model",
          value: "model",
          description: "Pick orchestrator model from catalog",
          onSelect: () => pickOrchestratorModel(api, saveOrch),
        },
        ...(catalogVariants(r.orchestrator, catalogModels(api)).length > 0 || currentVariant
          ? [
              {
                title: `Reasoning variant: ${currentVariant || "default"}`,
                value: "variant",
                description: "Select reasoning effort / variant",
                onSelect: () =>
                  pickOrchestratorVariant(api, r.orchestrator, currentVariant, (v) => {
                    saveOrch({ orchestratorVariant: v });
                    orchestratorMenu(api);
                  }),
              },
            ]
          : []),
        {
          title: "Provider account",
          value: "account",
          description: "Select account or add account for orchestrator",
          onSelect: () => pickOrchestratorAccount(api, r.orchestrator),
        },
        {
          title: `Fallback models (${currentFallbacks.length})`,
          value: "fallbacks",
          description: currentFallbacks.map((f) => formatCleanModelName(f)).join(", ") || "None configured",
          onSelect: () =>
            orchestratorFallbacksEditor(api, currentFallbacks, (fbs) => {
              saveOrch({ orchestratorFallbacks: fbs });
            }),
        },
        {
          title: "< Back",
          value: "__back",
          onSelect: () => routerSettings(api),
        },
      ]}
    />
  ));
}

function pickOrchestratorModel(
  api: Api,
  saveOrch: (p: { orchestrator?: string; orchestratorVariant?: string }) => void,
) {
  const models = catalogModels(api);

  openDialog(api, () => (
    <api.ui.DialogSelect
      title="Orchestrator: choose model"
      placeholder="Select model"
      options={[
        ...models.map((m) => ({
          title: m.label,
          value: m.id,
          description: m.id,
          onSelect: () => {
            const variants = catalogVariants(m.id, models);
            if (variants.length > 0) {
              pickOrchestratorVariant(api, m.id, undefined, (v) => {
                saveOrch({ orchestrator: m.id, orchestratorVariant: v });
                orchestratorMenu(api);
              });
            } else {
              saveOrch({ orchestrator: m.id, orchestratorVariant: undefined });
              orchestratorMenu(api);
            }
          },
        })),
        {
          title: "Custom model id (manual)",
          value: "__custom",
          onSelect: () => {
            openDialog(api, () => (
              <api.ui.DialogPrompt
                title="Orchestrator: custom model id"
                placeholder="provider/model"
                onCancel={() => orchestratorMenu(api)}
                onConfirm={(id) => {
                  const err = modelError(id);
                  if (err) {
                    errorToast(api, err);
                    return;
                  }
                  saveOrch({ orchestrator: id.trim() });
                  orchestratorMenu(api);
                }}
              />
            ));
          },
        },
        {
          title: "< Back",
          value: "__back",
          onSelect: () => orchestratorMenu(api),
        },
      ]}
    />
  ));
}

function pickOrchestratorVariant(
  api: Api,
  modelId: string,
  current: string | undefined,
  onVariant: (variant: string | undefined) => void,
) {
  const models = catalogModels(api);
  const variants = tierVariantOptions(modelId, catalogVariants(modelId, models), current);

  openDialog(api, () => (
    <api.ui.DialogSelect
      title={`Variant for ${formatCleanModelName(modelId)}`}
      placeholder="Select reasoning variant"
      options={[
        ...variants.map((v) => ({
          title: v.value ?? "Default (no variant)",
          value: v.value ?? "",
          onSelect: () => onVariant(v.value),
        })),
        {
          title: "< Back",
          value: "__back",
          onSelect: () => orchestratorMenu(api),
        },
      ]}
    />
  ));
}

function pickOrchestratorAccount(api: Api, modelId: string) {
  const provider = modelId.split("/")[0] || "";
  const allAccounts = cfg().accounts;
  const providerAccounts = allAccounts.filter(
    (a) => a.kind === provider || (provider === "google" && a.kind === "antigravity"),
  );
  const kind = (provider === "google" ? "antigravity" : provider) as "openai" | "antigravity" | "chatgpt-web";

  openDialog(api, () => (
    <api.ui.DialogSelect
      title={`Account for orchestrator (${formatCleanModelName(modelId)})`}
      placeholder="Select account"
      options={[
        {
          title: "Default (main account)",
          value: "__default",
          description: "Use whichever account is designated as main",
          onSelect: () => {
            api.ui.toast({ variant: "success", title: "Account", message: "Orchestrator will use main account." });
            orchestratorMenu(api);
          },
        },
        ...providerAccounts.map((a) => ({
          title: `${a.alias ? `[${a.alias}] ` : ""}${a.label}${a.main ? " (main)" : ""}`,
          value: a.id,
          description: a.configured ? "Configured" : "Needs login",
          onSelect: () => {
            if (!a.main) {
              void setMainByManagerId(configDir(), a.id);
              api.ui.toast({ variant: "success", title: "Main account updated", message: `${a.label} is now main.` });
            }
            orchestratorMenu(api);
          },
        })),
        {
          title: `+ Add new account (${provider || "provider"})`,
          value: "__add_account",
          description: `Login with a new ${provider} account`,
          onSelect: () => {
            const act = loginActionFor(kind);
            if (act) {
              dispatchNative(api, act).then((res) => {
                toastResult(api, res);
                orchestratorMenu(api);
              });
            } else {
              accountsWizard(api);
            }
          },
        },
        {
          title: "< Back",
          value: "__back",
          onSelect: () => orchestratorMenu(api),
        },
      ]}
    />
  ));
}

function orchestratorFallbacksEditor(api: Api, currentFallbacks: string[], onSave: (fallbacks: string[]) => void) {
  const list = [...currentFallbacks];
  const models = catalogModels(api);

  const commit = (next: string[]) => {
    onSave(next);
    orchestratorFallbacksEditor(api, next, onSave);
  };

  openDialog(api, () => (
    <api.ui.DialogSelect
      title={`Orchestrator fallbacks (${list.length})`}
      placeholder="Select option"
      options={[
        {
          title: "+ Add fallback model",
          value: "__add",
          onSelect: () => {
            openDialog(api, () => (
              <api.ui.DialogSelect
                title="Choose fallback model for orchestrator"
                placeholder="Select model"
                options={[
                  ...models.map((m) => ({
                    title: m.label,
                    value: m.id,
                    description: m.id,
                    onSelect: () => commit([...list, m.id]),
                  })),
                  {
                    title: "Custom model id (manual)",
                    value: "__custom",
                    onSelect: () => {
                      openDialog(api, () => (
                        <api.ui.DialogPrompt
                          title="Custom fallback model id"
                          placeholder="provider/model"
                          onCancel={() => orchestratorFallbacksEditor(api, list, onSave)}
                          onConfirm={(id) => {
                            const err = modelError(id);
                            if (err) {
                              errorToast(api, err);
                              return;
                            }
                            commit([...list, id.trim()]);
                          }}
                        />
                      ));
                    },
                  },
                  {
                    title: "< Back",
                    value: "__back",
                    onSelect: () => orchestratorFallbacksEditor(api, list, onSave),
                  },
                ]}
              />
            ));
          },
        },
        ...list.map((m, i) => ({
          title: `Fallback ${i + 1}: ${formatCleanModelName(m)}`,
          value: m,
          description: m,
          onSelect: () => {
            const sub: { title: string; value: string; onSelect?: () => void }[] = [
              ...(i > 0
                ? [
                    {
                      title: "Move up",
                      value: "up",
                      onSelect: () => {
                        const n = [...list];
                        [n[i - 1], n[i]] = [n[i], n[i - 1]];
                        commit(n);
                      },
                    },
                  ]
                : []),
              ...(i < list.length - 1
                ? [
                    {
                      title: "Move down",
                      value: "down",
                      onSelect: () => {
                        const n = [...list];
                        [n[i + 1], n[i]] = [n[i], n[i + 1]];
                        commit(n);
                      },
                    },
                  ]
                : []),
              {
                title: "Remove",
                value: "remove",
                onSelect: () => commit(list.filter((_, j) => j !== i)),
              },
              {
                title: "< Back",
                value: "__back",
                onSelect: () => orchestratorFallbacksEditor(api, list, onSave),
              },
            ];
            openDialog(api, () => (
              <api.ui.DialogSelect
                title={`Fallback ${i + 1}: ${formatCleanModelName(m)}`}
                placeholder="Select action"
                options={sub}
              />
            ));
          },
        })),
        {
          title: "< Done / Back",
          value: "__done",
          onSelect: () => orchestratorMenu(api),
        },
      ]}
    />
  ));
}

/** Settings: router toggle, orchestrator, per-tier full chain editor. */
export function routerSettings(api: Api) {
  const r = cfg().router;
  const refresh = () => routerSettings(api);
  openDialog(api, () => (
    <api.ui.DialogSelect
      title="Router settings"
      placeholder="Select"
      options={[
        {
          title: `Router: ${r.enabled ? "enabled" : "disabled"} (toggle)`,
          value: "toggle",
          description: r.enabled ? "Delegation routing active" : "Routing disabled",
          onSelect: () => {
            completeStep("router", { orchestrator: r.orchestrator, enabled: !r.enabled }, undefined, configDir());
            api.ui.toast({ variant: "success", title: "Router toggled", message: RESTART });
            refresh();
          },
        },
        {
          title: `Orchestrator: ${formatChainString({ model: r.orchestrator, variant: r.orchestratorVariant }, r.orchestratorFallbacks ?? [])}`,
          value: "orch",
          onSelect: () => orchestratorMenu(api),
        },
        ...TIERS.map((t) => {
          const chain = r.tiers[t];
          return {
            title: `${t.toUpperCase()}: ${formatChainString({ model: chain.model, variant: chain.variant }, renderTargets(api, t))}`,
            value: t,
            onSelect: () => fallbackEditor(api, t, chain.model, chain.variant),
          };
        }),
        { title: "Close", value: "close", onSelect: () => api.ui.dialog.clear() },
      ]}
    />
  ));
}

export function openWizard(api: Api) {
  openWizardAfter(api);
}

/** Move an element in a list by a signed delta, returning a new array. */
function moveInList<T>(list: T[], index: number, delta: number): T[] {
  const next = [...list];
  const target = index + delta;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Per-tier provider fallback list editor (ordered providers). */
function editProviderList(api: Api, tier: "orchestrator" | "fast" | "medium" | "heavy") {
  const list = [...(cfg().router.providerFallbacks?.[tier] ?? [])];

  const commit = (next: string[]) => {
    const c = cfg();
    c.router = {
      ...c.router,
      providerFallbacks: { ...c.router.providerFallbacks, [tier]: next },
    };
    saveConfig(c);
    api.ui.toast({ variant: "success", title: "Provider fallbacks updated", message: RESTART });
    editProviderList(api, tier);
  };

  openDialog(api, () => (
    <api.ui.DialogSelect
      title={`${tier}: provider fallbacks (${list.length})`}
      placeholder="Select option"
      options={[
        {
          title: "+ Add provider",
          value: "__add",
          onSelect: () => {
            openDialog(api, () => (
              <api.ui.DialogPrompt
                title={`${tier}: add provider`}
                description={() => <text>Enter a provider name (e.g. google).</text>}
                placeholder="provider"
                onCancel={() => editProviderList(api, tier)}
                onConfirm={(name) => {
                  const trimmed = name.trim();
                  if (!trimmed) {
                    errorToast(api, "Provider name is required.");
                    return;
                  }
                  commit([...list, trimmed]);
                }}
              />
            ));
          },
        },
        ...list.map((provider, i) => ({
          title: `${i + 1}: ${provider}`,
          value: provider,
          description: provider,
          onSelect: () => {
            const sub: { title: string; value: string; onSelect?: () => void }[] = [
              ...(i > 0
                ? [
                    {
                      title: "Move up",
                      value: "up",
                      onSelect: () => commit(moveInList(list, i, -1)),
                    },
                  ]
                : []),
              ...(i < list.length - 1
                ? [
                    {
                      title: "Move down",
                      value: "down",
                      onSelect: () => commit(moveInList(list, i, 1)),
                    },
                  ]
                : []),
              {
                title: "Remove",
                value: "remove",
                onSelect: () => commit(list.filter((_, j) => j !== i)),
              },
              {
                title: "< Back",
                value: "__back",
                onSelect: () => editProviderList(api, tier),
              },
            ];
            openDialog(api, () => (
              <api.ui.DialogSelect title={`${i + 1}: ${provider}`} placeholder="Select action" options={sub} />
            ));
          },
        })),
        {
          title: "< Back",
          value: "__back",
          onSelect: () => fallbackSettings(api),
        },
      ]}
    />
  ));
}

/** Settings: per-tier provider-level fallback lists. */
export function fallbackSettings(api: Api) {
  const pf = cfg().router.providerFallbacks;
  openDialog(api, () => (
    <api.ui.DialogSelect
      title="Provider fallbacks"
      placeholder="Select tier"
      options={[
        ...(["orchestrator", "fast", "medium", "heavy"] as const).map((t) => ({
          title: `${t.toUpperCase()}: ${(pf?.[t] ?? []).join(", ") || "-"}`,
          value: t,
          onSelect: () => editProviderList(api, t),
        })),
        { title: "Close", value: "close", onSelect: () => api.ui.dialog.clear() },
      ]}
    />
  ));
}

export function showReset(api: Api) {
  openDialog(api, () => (
    <api.ui.DialogConfirm
      title="Reset manager config & wizard?"
      message={`This resets the manager config and wizard progress to defaults. Provider credentials are NOT touched. ${RESTART}`}
      onConfirm={() => {
        resetManager();
        openDialog(api, () => (
          <api.ui.DialogAlert
            title="Reset"
            message={`Manager config & wizard reset. Credentials untouched. ${RESTART}`}
            onConfirm={() => api.ui.dialog.clear()}
          />
        ));
      }}
      onCancel={() => api.ui.dialog.clear()}
    />
  ));
}
