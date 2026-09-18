import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import {
  TIERS,
  type TierName,
  type CatalogModel,
  type FallbackTarget,
  catalogModels,
  catalogVariants,
  chainTargets,
  formatCleanModelName,
  missingTiers,
  nextMissingStep,
  tierVariantOptions,
} from "./wizard-core.js";
import {
  type NativeAction,
  getAccounts,
  getAntigravityAccounts,
  loginActionFor,
  setMainByManagerId,
  routingModeAction,
} from "../manager/provider-accounts.js";
import {
  completeStep,
  loadConfig,
  resetManager,
  saveConfig,
  syncUnifiedRouting,
  type RouterRoutingMode,
  type UnifiedRoutingMode,
  UNIFIED_ROUTING_MODES,
} from "../manager/index.js";
import { getOpenCodeConfigDir } from "../shared/paths.js";
import { dispatchNative } from "./native.js";
import { listChromeProfiles, importFromChromeProfile } from "../chatgpt-web/chrome-importer.js";
import { findPortFile } from "../manager/quota-poller.js";

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
  api.ui.toast({ variant: res.ok ? "success" : "error", title: res.ok ? "Dispatched" : "Not dispatched", message: res.text });
}

function errorToast(api: Api, text: string) {
  api.ui.toast({ variant: "error", title: "Invalid", message: text });
}

function closeDialog(api: Api) {
  api.ui.dialog?.clear?.();
}

async function applyRpcCommandSilently(provider: "antigravity" | "openai", command: string, args: string) {
  try {
    const portEntry = await findPortFile(provider);
    if (!portEntry) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const effectiveCommand = provider === "antigravity" && command === "google-routing" ? "antigravity-routing" : command;
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
const openaiRouting = (): NativeAction => ({ ...routingModeAction("main-first"), command: "/openai-routing" });

/** Rename a manager account's alias (used in fallback targets and the right column). */
function renameAccountAlias(api: Api) {
  const accounts = cfg().accounts;
  openDialog(api, () => (
    <api.ui.DialogSelect
      title="Rename account alias"
      placeholder="Select account"
      options={[
        ...accounts.map(a => ({
          title: `${a.alias ?? a.label} (${a.kind})`,
          value: a.id,
          onSelect: () => {
            openDialog(api, () => (
              <api.ui.DialogPrompt title={`Rename alias for ${a.label}`} placeholder="alias" value={a.alias ?? ""} onCancel={() => renameAccountAlias(api)} onConfirm={alias => {
                const c = cfg();
                const acc = c.accounts.find(x => x.id === a.id);
                if (acc) acc.alias = alias.trim() || undefined;
                saveConfig(c);
                api.ui.toast({ variant: "success", title: "Alias renamed", message: RESTART });
                accountsSettings(api);
              }} />
            ));
          },
        })),
        { title: "Back", value: "__back", onSelect: () => accountsSettings(api) },
      ]}
    />
  ));
}

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
  const realReady = accounts.some(a => a.configured);
  const authOpts = (provider: "openai" | "antigravity") => ({
    title: `Login to ${provider === "openai" ? "OpenAI / ChatGPT" : "Google Antigravity"} (native)`,
    value: `login-${provider}`,
    onSelect: () => {
      dispatchNative(api, loginActionFor(provider)).then(res => toastResult(api, res));
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
        { title: accounts.length ? `Found ${accounts.length} real account(s)` : "No real accounts found yet", value: "status", description: realReady ? "At least one provider has real credentials — you can continue." : "Login a provider or skip auth for an external provider (e.g. IIT)." },
        authOpts("openai"),
        authOpts("antigravity"),
        {
          title: realReady ? "Continue to model tiers" : "Continue anyway (login later)",
          value: "continue",
          description: realReady ? "At least one real provider is authenticated." : "Proceed now; you can log in later from the settings.",
          onSelect: () => confirmAccounts(false),
        },
        {
          title: "Skip native auth (use external provider, e.g. IIT)",
          value: "skip-auth",
          description: "Explicitly skip logging into OpenAI/Antigravity here; you authenticate an external provider externally.",
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

export function promptRoutingScope(
  api: Api,
  title: string,
  onSelectScope: (scope: "session" | "all") => void
) {
  openDialog(api, () => (
    <api.ui.DialogSelect
      title={`${title} - Choose scope`}
      placeholder="Select scope"
      options={[
        {
          title: "Apply to all sessions (save to config)",
          value: "all",
          description: "Persists to configuration. A restart may be required for background sessions.",
          onSelect: () => { closeDialog(api); onSelectScope("all"); },
        },
        {
          title: "Apply to current session only",
          value: "session",
          description: "Active immediately for the current conversation without modifying persistent config.",
          onSelect: () => { closeDialog(api); onSelectScope("session"); },
        },
      ]}
    />
  ));
}

export function openRoutingSelector(
  api: Api,
  target: "manager" | "openai" | "google" | "opencode",
  onDone?: () => void
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
        ...UNIFIED_ROUTING_OPTIONS.map(opt => ({
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
        { title: "< Back", value: "__back", onSelect: () => { if (onDone) onDone(); else closeDialog(api); } },
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

export function setOpenAIRoutingMode(api: Api, mode: UnifiedRoutingMode, scope: "session" | "all" = "all") {
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

export function setGoogleRoutingMode(api: Api, mode: UnifiedRoutingMode, scope: "session" | "all" = "all") {
  void syncUnifiedRouting(api, mode);
}

export function setOpenCodeZenRoutingMode(api: Api, mode: UnifiedRoutingMode, scope: "session" | "all" = "all") {
  void syncUnifiedRouting(api, mode);
}

export function setRouterRoutingMode(api: Api, mode: RouterRoutingMode | UnifiedRoutingMode, scope: "session" | "all" = "all") {
  const unified: UnifiedRoutingMode = (
    mode === "sticky" ? "main-first" :
    mode === "balanced" || mode === "sticky-balanced" || mode === "round-robin" ? "load-balancing" :
    mode
  ) as UnifiedRoutingMode;
  void syncUnifiedRouting(api, unified);
}

/**
 * Consolidated account & routing management dialog:
 * Actionable cards for each Google and OpenAI account, alias management,
 * native OAuth login triggers, and live routing mode controls.
 */
export function accountsSettings(api: Api) {
  const accounts = cfg().accounts;
  const refresh = () => accountsSettings(api);

  const googleAccounts = accounts.filter(a => a.kind === "antigravity");
  const openaiAccounts = accounts.filter(a => a.kind === "openai");
  const webAccounts = accounts.filter(a => a.kind === "chatgpt-web");

  const openAccountActions = (a: (typeof accounts)[0]) => {
    const providerName = a.kind === "antigravity" ? "Google" : a.kind === "openai" ? "OpenAI" : "ChatGPT Web";
    openDialog(api, () => (
      <api.ui.DialogSelect
        title={`[${providerName}] ${a.alias ? `[${a.alias}] ` : ""}${a.label}`}
        placeholder="Select action"
        options={[
          ...(!a.main
            ? [{
                title: "Set as main account",
                value: `main-${a.id}`,
                description: `Designate ${a.label} as the primary active account for ${providerName}`,
                onSelect: async () => {
                  await setMainByManagerId(configDir(), a.id);
                  api.ui.toast({ variant: "success", title: "Main account updated", message: `${a.label} is now main.` });
                  refresh();
                },
              }]
            : [{
                title: "Active main account (already set)",
                value: "is-main",
                description: "This is currently the active main account for this provider.",
              }]),
          {
            title: `Rename alias (current: ${a.alias || "none"})`,
            value: "rename-alias",
            description: "Set a short identifier used in fallback chains (e.g. work, personal)",
            onSelect: () => {
              openDialog(api, () => (
                <api.ui.DialogPrompt
                  title={`Rename alias for ${a.label}`}
                  placeholder="alias (e.g. work, personal)"
                  value={a.alias ?? ""}
                  onCancel={refresh}
                  onConfirm={alias => {
                    const c = cfg();
                    const acc = c.accounts.find(x => x.id === a.id);
                    if (acc) acc.alias = alias.trim() || undefined;
                    saveConfig(c);
                    api.ui.toast({ variant: "success", title: "Alias updated", message: RESTART });
                    refresh();
                  }}
                />
              ));
            },
          },
          ...(a.alias
            ? [{
                title: "Remove alias",
                value: "remove-alias",
                description: "Clear the custom alias for this account",
                onSelect: () => {
                  const c = cfg();
                  const acc = c.accounts.find(x => x.id === a.id);
                  if (acc) acc.alias = undefined;
                  saveConfig(c);
                  api.ui.toast({ variant: "success", title: "Alias removed", message: RESTART });
                  refresh();
                },
              }]
            : []),
          {
            title: "< Back",
            value: "__back",
            onSelect: refresh,
          },
        ]}
      />
    ));
  };

  const options: { title: string; value: string; onSelect?: () => void; description?: string }[] = [];

  // 1. Google accounts
  for (const a of googleAccounts) {
    options.push({
      title: `Google: ${a.alias ? `[${a.alias}] ` : ""}${a.label}${a.main ? " (main)" : ""}`,
      value: a.id,
      description: `Status: ${a.configured ? "ready" : "pending login"} | Click to manage alias or main`,
      onSelect: () => openAccountActions(a),
    });
  }
  options.push({
    title: "+ Login to Google account",
    value: "login-google",
    description: "Authenticate a new Google account via OAuth",
    onSelect: () => {
      dispatchNative(api, loginActionFor("antigravity")).then(res => {
        toastResult(api, res);
        refresh();
      });
    },
  });
  const currentGoogleRouting = getGoogleRoutingMode();
  options.push({
    title: `Google routing mode: ${currentGoogleRouting}`,
    value: "routing-google",
    description: "Click to select mode: Main first, Round robin, Fallback first, Balanced",
    onSelect: () => openRoutingSelector(api, "google", refresh),
  });

  // 2.5 General Model Manager routing
  const currentRouterRouting = cfg().router.routingMode ?? "main-first";
  options.push({
    title: `Model Manager routing mode: ${currentRouterRouting}`,
    value: "routing-manager",
    description: "Click to select mode: Main first, Round robin, Fallback first, Balanced",
    onSelect: () => openRoutingSelector(api, "manager", refresh),
  });

  // 2. OpenAI accounts
  for (const a of openaiAccounts) {
    options.push({
      title: `OpenAI: ${a.alias ? `[${a.alias}] ` : ""}${a.label}${a.main ? " (main)" : ""}`,
      value: a.id,
      description: `Status: ${a.configured ? "ready" : "pending login"} | Click to manage alias or main`,
      onSelect: () => openAccountActions(a),
    });
  }
  options.push({
    title: "+ Login to OpenAI account",
    value: "login-openai",
    description: "Authenticate a new OpenAI/ChatGPT account via OAuth",
    onSelect: () => {
      dispatchNative(api, loginActionFor("openai")).then(res => {
        toastResult(api, res);
        refresh();
      });
    },
  });
  const currentOpenAIRouting = getOpenAIRoutingMode();
  options.push({
    title: `OpenAI routing mode: ${currentOpenAIRouting}`,
    value: "routing-openai",
    description: "Click to select mode: Main first, Round robin, Fallback first, Balanced",
    onSelect: () => openRoutingSelector(api, "openai", refresh),
  });

  // 3. ChatGPT Web accounts
  for (const a of webAccounts) {
    options.push({
      title: `ChatGPT Web: ${a.alias ? `[${a.alias}] ` : ""}${a.label}`,
      value: a.id,
      description: "Local ChatGPT browser bridge session",
      onSelect: () => openAccountActions(a),
    });
  }
  options.push({
    title: webAccounts.length === 0 ? "+ Connect ChatGPT Web Chrome profile" : "Switch ChatGPT Web Chrome profile",
    value: "login-chatgpt-web",
    description: "Select which Google Chrome profile to link with ChatGPT Web",
    onSelect: () => {
      const chromeProfiles = listChromeProfiles();
      if (chromeProfiles.length > 0) {
        openDialog(api, () => (
          <api.ui.DialogSelect
            title="Select Chrome Profile for ChatGPT Web"
            placeholder="Choose profile"
            options={[
              ...chromeProfiles.map(p => ({
                title: `${p.name} (${p.email || p.folder})`,
                value: p.folder,
                description: p.hasSession ? "Active ChatGPT session found" : "No active session in this profile",
                onSelect: () => {
                  const res = importFromChromeProfile(p.folder);
                  if (res.ok) {
                    api.ui.toast({ variant: "success", title: "ChatGPT Web", message: `Connected to ${p.name} (${p.email || p.folder})` });
                  } else {
                    api.ui.toast({ variant: "error", title: "ChatGPT Web", message: res.error || "Import failed" });
                  }
                  refresh();
                },
              })),
              { title: "< Back", value: "__back", onSelect: () => refresh() },
            ]}
          />
        ));
      } else {
        dispatchNative(api, loginActionFor("chatgpt-web")).then(res => {
          toastResult(api, res);
          refresh();
        });
      }
    },
  });

  // 4. OpenCode Zen accounts
  const zenAccounts = accounts.filter(a => a.kind === "opencode");
  for (const a of zenAccounts) {
    options.push({
      title: `OpenCode Zen: ${a.alias ? `[${a.alias}] ` : ""}${a.label}`,
      value: a.id,
      description: `Status: ${a.configured ? "ready (big-pickle)" : "pending login"} | Click to manage alias`,
      onSelect: () => openAccountActions(a),
    });
  }
  options.push({
    title: `OpenCode Zen routing mode: ${currentRouterRouting}`,
    value: "routing-opencode",
    description: "Click to select mode: Main first, Round robin, Fallback first, Balanced",
    onSelect: () => openRoutingSelector(api, "opencode", refresh),
  });

  // 5. Shortcut to fallback chains
  options.push({
    title: "-> Configure Fallback Chains (/fallback-list)",
    value: "__to_fallbacks",
    description: "Open the router and fallback chain editor",
    onSelect: () => routerSettings(api),
  });

  options.push({
    title: "Close",
    value: "close",
    onSelect: () => api.ui.dialog.clear(),
  });

  openDialog(api, () => (
    <api.ui.DialogSelect
      title="Accounts & Routing Management"
      placeholder="Select an account or action"
      options={options}
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
  const providers = [...new Set(models.map(m => m.provider))];
  openDialog(api, () => (
    <api.ui.DialogSelect
      title={`${tier}: choose provider`}
      placeholder="Select provider"
      options={[
        ...providers.map(p => ({
          title: p,
          value: p,
          onSelect: () => {
            const of = models.filter(m => m.provider === p);
            openDialog(api, () => (
              <api.ui.DialogSelect
                title={`${tier}: choose model (${p})`}
                placeholder="Select model"
                options={[
                  ...of.map(m => ({
                    title: m.label,
                    value: m.id,
                    description: m.variant ? `variant: ${m.variant}` : undefined,
                    onSelect: () => { persistChain(api, tier, { model: m.id }); pickVariant(api, tier, m); },
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
      onConfirm={id => {
        const err = modelError(id);
        if (err) { errorToast(api, err); promptModelId(api, tier, provider); return; }
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
        ...variants.map(v => ({
          title: v.value ?? "Default (no variant)",
          value: v.value ?? "",
          onSelect: () => { persistChain(api, tier, { model: m.id, variant: v.value }); fallbackEditor(api, tier, m.id, v.value); },
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

function renderTargets(api: Api, tier: TierName): FallbackTarget[] {
  try { return chainTargets(cfg().router.tiers[tier]); } catch { return []; }
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
  fallbacks: Array<{ model: string; alias?: string; variant?: string } | string>
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

function fallbackOptions(api: Api, tier: TierName, model: string, variant: string | undefined, targets?: FallbackTarget[]) {
  const list = targets ?? renderTargets(api, tier);
  const commit = (next: FallbackTarget[]) => {
    persistChain(api, tier, { model, variant, targets: next });
    fallbackEditor(api, tier, model, variant);
  };
  const models = catalogModels(api);
  const aliases = [...new Set(cfg().accounts.map(a => a.alias).filter((x): x is string => !!x))];

  const addFallbackTarget = () => {
    openDialog(api, () => (
      <api.ui.DialogSelect
        title={`${tier.toUpperCase()}: choose fallback model`}
        placeholder="Select model from catalog"
        options={[
          ...models.map(m => ({
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
                      ...variants.map(v => ({
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
                  onConfirm={id => {
                    const err = modelError(id);
                    if (err) { errorToast(api, err); return; }
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
          ...aliases.map(a => ({
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
                  onConfirm={a => commit([...list, makeTarget(a.trim() || "main", modelId, modelVariant)])}
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
    { title: "+ Add fallback", value: "__add", description: "Choose a model to append to chain", onSelect: () => addFallbackTarget() },
    ...list.map((t, i) => ({
      title: `Fallback ${i + 1}: ${targetLabel(t)}`,
      value: t.model,
      description: "Select to reorder/remove/rename",
      onSelect: () => {
        const sub: { title: string; value: string; onSelect?: () => void }[] = [
          ...(i > 0 ? [{ title: "Move up", value: "up", onSelect: () => { const n = [...list]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; commit(n); } }] : []),
          ...(i < list.length - 1 ? [{ title: "Move down", value: "down", onSelect: () => { const n = [...list]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; commit(n); } }] : []),
          { title: "Rename alias", value: "rename", onSelect: () => {
            openDialog(api, () => (
              <api.ui.DialogPrompt title={`${tier.toUpperCase()}: rename alias for ${t.model}`} placeholder="alias" value={t.alias ?? ""} onCancel={() => fallbackEditor(api, tier, model, variant)} onConfirm={a => { const n = [...list]; n[i] = { ...n[i], alias: a.trim() || undefined }; commit(n); }} />
            ));
          } },
          { title: "Remove", value: "remove", onSelect: () => commit(list.filter((_, j) => j !== i)) },
          { title: "< Back", value: "__back", onSelect: () => fallbackEditor(api, tier, model, variant) },
        ];
        openDialog(api, () => (
          <api.ui.DialogSelect title={`${tier.toUpperCase()}: ${targetLabel(t)}`} placeholder="Select action" options={sub} />
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
        { title: `${tier.toUpperCase()} current: ${formatCleanModelName(chain.model) || "unset"}${chain.variant ? ` (${chain.variant})` : ""}`, value: "status" },
        { title: "Choose model", value: "model", onSelect: () => pickModel(api, tier) },
        ...(chain.model ? [{ title: "Edit variant", value: "variant", onSelect: () => pickVariant(api, tier, { provider: chain.model.split("/")[0], id: chain.model, label: formatCleanModelName(chain.model), variant: chain.variant }) }] : []),
        ...(chain.model ? [{ title: "Edit fallback order", value: "fb", onSelect: () => fallbackEditor(api, tier, chain.model, chain.variant) }] : []),
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
      title={`Set up ${tier} tier (${missing.includes(tier) ? "needs confirmation" : ">" + missing.length + " remaining"})`}
      placeholder="Select"
      options={[
        { title: `${tier} current: ${formatCleanModelName(chain.model) || "unset"}${chain.variant ? ` (${chain.variant})` : ""}`, value: "status", description: "Defaults are suggestions — confirm each tier to mark it done." },
        { title: "Choose model", value: "model", onSelect: () => pickModel(api, tier) },
        ...(chain.model ? [{ title: "Edit variant", value: "variant", onSelect: () => pickVariant(api, tier, { provider: chain.model.split("/")[0], id: chain.model, label: formatCleanModelName(chain.model), variant: chain.variant }) }] : []),
        ...(chain.model ? [{ title: "Edit fallback order", value: "fb", onSelect: () => fallbackEditor(api, tier, chain.model, chain.variant) }] : []),
        ...(chain.model ? [{ title: "Confirm this tier (accept current)", value: "confirm", onSelect: confirmTier }] : []),
        { title: "Skip to next tier", value: "skip", onSelect: () => { const rest = missing.slice(1); if (rest.length === 0) openWizardAfter(api, missingTiers(cfg()).length === 0 ? "router" : undefined); else showTier(api, rest[0]); } },
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
    if (err) { errorToast(api, err); return; }
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
          onSelect: () => openDialog(api, () => (
            <api.ui.DialogPrompt
              title="Router orchestrator"
              description={() => <text>Current: {formatCleanModelName(r.orchestrator)}</text>}
              placeholder="provider/model"
              value={r.orchestrator}
              onCancel={() => routerWizard(api)}
              onConfirm={orchestrator => saveOrchestrator(orchestrator, !r.enabled)}
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

  const saveOrch = (patch: { orchestrator?: string; orchestratorVariant?: string; orchestratorFallbacks?: string[] }) => {
    const nextOrch = patch.orchestrator ?? r.orchestrator;
    const nextVariant = patch.orchestratorVariant !== undefined ? patch.orchestratorVariant : r.orchestratorVariant;
    const nextFallbacks = patch.orchestratorFallbacks !== undefined ? patch.orchestratorFallbacks : r.orchestratorFallbacks;

    completeStep(
      "router",
      {
        orchestrator: nextOrch,
        enabled: r.enabled,
        orchestratorVariant: nextVariant || undefined,
        orchestratorFallbacks: nextFallbacks,
      },
      undefined,
      configDir()
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
          ? [{
              title: `Reasoning variant: ${currentVariant || "default"}`,
              value: "variant",
              description: "Select reasoning effort / variant",
              onSelect: () => pickOrchestratorVariant(api, r.orchestrator, currentVariant, (v) => {
                saveOrch({ orchestratorVariant: v });
                orchestratorMenu(api);
              }),
            }]
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
          description: currentFallbacks.map(f => formatCleanModelName(f)).join(", ") || "None configured",
          onSelect: () => orchestratorFallbacksEditor(api, currentFallbacks, (fbs) => {
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

function pickOrchestratorModel(api: Api, saveOrch: (p: { orchestrator?: string; orchestratorVariant?: string }) => void) {
  const models = catalogModels(api);

  openDialog(api, () => (
    <api.ui.DialogSelect
      title="Orchestrator: choose model"
      placeholder="Select model"
      options={[
        ...models.map(m => ({
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
                onConfirm={id => {
                  const err = modelError(id);
                  if (err) { errorToast(api, err); return; }
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
  onVariant: (variant: string | undefined) => void
) {
  const models = catalogModels(api);
  const variants = tierVariantOptions(modelId, catalogVariants(modelId, models), current);

  openDialog(api, () => (
    <api.ui.DialogSelect
      title={`Variant for ${formatCleanModelName(modelId)}`}
      placeholder="Select reasoning variant"
      options={[
        ...variants.map(v => ({
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
  const providerAccounts = allAccounts.filter(a => a.kind === provider || (provider === "google" && a.kind === "antigravity"));
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
        ...providerAccounts.map(a => ({
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
              dispatchNative(api, act).then(res => {
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

function orchestratorFallbacksEditor(
  api: Api,
  currentFallbacks: string[],
  onSave: (fallbacks: string[]) => void
) {
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
                  ...models.map(m => ({
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
                          onConfirm={id => {
                            const err = modelError(id);
                            if (err) { errorToast(api, err); return; }
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
                ? [{
                    title: "Move up",
                    value: "up",
                    onSelect: () => {
                      const n = [...list];
                      [n[i - 1], n[i]] = [n[i], n[i - 1]];
                      commit(n);
                    },
                  }]
                : []),
              ...(i < list.length - 1
                ? [{
                    title: "Move down",
                    value: "down",
                    onSelect: () => {
                      const n = [...list];
                      [n[i + 1], n[i]] = [n[i], n[i + 1]];
                      commit(n);
                    },
                  }]
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
        ...TIERS.map(t => {
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

export function showReset(api: Api) {
  openDialog(api, () => (
    <api.ui.DialogConfirm
      title="Reset manager config & wizard?"
      message={`This resets the manager config and wizard progress to defaults. Provider credentials are NOT touched. ${RESTART}`}
      onConfirm={() => {
        resetManager();
        openDialog(api, () => (
          <api.ui.DialogAlert title="Reset" message={`Manager config & wizard reset. Credentials untouched. ${RESTART}`} onConfirm={() => api.ui.dialog.clear()} />
        ));
      }}
      onCancel={() => api.ui.dialog.clear()}
    />
  ));
}
