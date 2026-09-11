import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import {
  TIERS,
  type TierName,
  type CatalogModel,
  catalogModels,
  catalogVariants,
  chainTargets,
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
import { completeStep, loadConfig, resetManager } from "../manager/index.js";
import { getOpenCodeConfigDir } from "../shared/paths.js";
import { dispatchNative } from "./native.js";

type Api = TuiPluginApi;
const configDir = () => getOpenCodeConfigDir();
const cfg = () => loadConfig(undefined, configDir());

const RESTART = "A restart may be required for config changes to take effect.";

/** Friendly toast on native dispatch result. */
function toastResult(api: Api, res: { ok: boolean; text: string }) {
  api.ui.toast({ variant: res.ok ? "success" : "error", title: res.ok ? "Dispatched" : "Not dispatched", message: res.text });
}

function errorToast(api: Api, text: string) {
  api.ui.toast({ variant: "error", title: "Invalid", message: text });
}

/** OpenAI routing preference via the native /openai-routing command. */
const openaiRouting = (): NativeAction => ({ ...routingModeAction("main-first"), command: "/openai-routing" });

/** Validate a model id and return a friendly error string, or null when valid. */
function modelError(id: string): string | null {
  if (!id.trim()) return "A model id is required.";
  if (!/^[^/]+\/[^/]+$/.test(id.trim())) return "Model id must be provider/model (e.g. openai/gpt-4o).";
  return null;
}

function openWizardAfter(api: Api, step?: string) {
  const p = step ?? nextMissingStep(cfg(), configDir());
  if (p === null) {
    api.ui.dialog.replace(() => (
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
  api.ui.dialog.replace(() => (
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
export function accountsSettings(api: Api) {
  const accounts = getAccounts(configDir());
  const refresh = () => accountsSettings(api);
  const select: { title: string; value: string; onSelect?: () => void; description?: string }[] = [];

  for (const a of accounts) {
    const tag = `${a.provider === "openai" ? "OpenAI" : "Antigravity"}${a.main ? " (main)" : ""}${!a.configured ? " — pending" : ""}`;
    select.push({ title: a.label, value: a.id, description: `${tag}: ${a.configured ? "real credentials present" : "no credentials yet — login first"}` });
    if (a.main) {
      select.push({ title: "Already main (native routing)", value: `main-${a.id}`, onSelect: () => { if (a.provider === "openai") dispatchNative(api, openaiRouting()).then(res => toastResult(api, res)); refresh(); }, description: `Open the native main preference for ${a.provider}.` });
    } else if (a.provider === "openai") {
      select.push({
        title: "Set routing preference (/openai-routing)",
        value: `main-${a.id}`,
        description: "Opens the native routing dialog. The primary is managed by the host, so we set a routing preference, not a primary switch.",
        onSelect: () => { dispatchNative(api, openaiRouting()).then(res => toastResult(api, res)); },
      });
    } else {
      select.push({
        title: `Set as current (${a.label})`,
        value: `main-${a.id}`,
        description: "Writes the real Antigravity store, then syncs the runtime current account via native command.",
        onSelect: async () => {
          const res = await setMainByManagerId(configDir(), a.id);
          if (res.kind === "invalid") { toastResult(api, { ok: false, text: res.text }); refresh(); return; }
          if (res.kind === "applied") {
            const idx = getAntigravityAccounts(configDir()).findIndex(x => x.id === a.id);
            const action: NativeAction = {
              provider: "antigravity", kind: "set-main", command: "/antigravity-account",
              arguments: idx >= 0 ? `current ${idx}` : "list", cli: { command: "", args: [] },
              text: "Open native Antigravity accounts dialog.",
            };
            await dispatchNative(api, action);
            toastResult(api, { ok: true, text: `${res.text} Runtime current synced.` });
          } else if (res.kind === "delegate") {
            const action = res.action as NativeAction;
            await dispatchNative(api, action);
            toastResult(api, { ok: true, text: `${res.text} Native action dispatched.` });
          }
          refresh();
        },
      });
    }
  }

  const native = (label: string, action: NativeAction) => ({
    title: label,
    value: `native-${label}`,
    onSelect: () => { dispatchNative(api, action).then(res => toastResult(api, res)); },
  });

  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Manage accounts (real provider stores)"
      placeholder="Select"
      options={[
        ...select,
        ...(accounts.some(a => a.provider === "openai")
          ? [native("Open OpenAI routing (/openai-routing)", openaiRouting()), native("Open OpenAI native account dialog (/openai-account)", { ...loginActionFor("openai"), kind: "login", arguments: "list" })]
          : []),
        ...(accounts.some(a => a.provider === "antigravity")
          ? [native("Open Antigravity native account dialog (/antigravity-account)", { ...loginActionFor("antigravity"), kind: "login", arguments: "list" }), native("Open Antigravity routing (/antigravity-routing)", { ...loginActionFor("antigravity"), kind: "set-routing", command: "/antigravity-routing", arguments: "", cli: { command: "", args: [] } })]
          : []),
        { title: "Login OpenAI / ChatGPT (native)", value: "login-openai", onSelect: () => { dispatchNative(api, loginActionFor("openai")).then(res => toastResult(api, res)); } },
        { title: "Login Antigravity (native)", value: "login-antigravity", onSelect: () => { dispatchNative(api, loginActionFor("antigravity")).then(res => toastResult(api, res)); } },
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
  const providers = [...new Set(models.map(m => m.provider))];
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title={`${tier}: choose provider`}
      placeholder="Select provider"
      options={[
        ...providers.map(p => ({
          title: p,
          value: p,
          onSelect: () => {
            const of = models.filter(m => m.provider === p);
            api.ui.dialog.replace(() => (
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
  api.ui.dialog.replace(() => (
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
  api.ui.dialog.replace(() => (
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
  api.ui.dialog.replace(() => fallbackOptions(api, tier, model, variant));
}

function renderTargets(api: Api, tier: TierName): { model: string; variant?: string }[] {
  try { return chainTargets(cfg().router.tiers[tier]); } catch { return []; }
}

function fallbackOptions(api: Api, tier: TierName, model: string, variant: string | undefined, targets?: { model: string; variant?: string }[]) {
  const list = targets ?? renderTargets(api, tier);
  const commit = (next: { model: string; variant?: string }[]) => {
    persistChain(api, tier, { model, variant, targets: next });
    fallbackEditor(api, tier, model, variant);
  };
  const models = catalogModels(api);
  const opts: { title: string; value: string; onSelect?: () => void; description?: string }[] = [
    {
      title: "Add fallback model",
      value: "__add",
      onSelect: () => {
        api.ui.dialog.replace(() => (
          <api.ui.DialogSelect
            title={`${tier}: pick a fallback`}
            placeholder="Select fallback"
            options={[
              ...models.map(m => ({
                title: m.label,
                value: m.id,
                description: m.variant ? `variant: ${m.variant}` : undefined,
                onSelect: () => commit([...list, { model: m.id, variant: m.variant }]),
              })),
              { title: "Custom fallback (manual)", value: "__custom", onSelect: () => {
                api.ui.dialog.replace(() => (
                  <api.ui.DialogPrompt title={`${tier}: custom fallback model`} placeholder="provider/model" onCancel={() => fallbackOptions(api, tier, model, variant, list)} onConfirm={id => {
                    if (modelError(id)) { errorToast(api, modelError(id)!); return; }
                    commit([...list, { model: id.includes("/") ? id.trim() : id.trim() }]);
                  }} />
                ));
              } },
              { title: "Back", value: "__back", onSelect: () => fallbackOptions(api, tier, model, variant, list) },
            ]}
          />
        ));
      },
    },
    ...list.map((t, i) => ({
      title: `Fallback ${i + 1}: ${t.model}${t.variant ? ` (${t.variant})` : ""}`,
      value: t.model,
      description: "Select to reorder/remove",
      onSelect: () => {
        const sub: { title: string; value: string; onSelect?: () => void }[] = [
          ...(i > 0 ? [{ title: "Move up", value: "up", onSelect: () => { const n = [...list]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; commit(n); } }] : []),
          ...(i < list.length - 1 ? [{ title: "Move down", value: "down", onSelect: () => { const n = [...list]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; commit(n); } }] : []),
          { title: "Remove", value: "remove", onSelect: () => commit(list.filter((_, j) => j !== i)) },
          { title: "Back", value: "__back", onSelect: () => fallbackOptions(api, tier, model, variant, list) },
        ];
        api.ui.dialog.replace(() => (
          <api.ui.DialogSelect title={`${tier}: ${t.model}`} placeholder="Select" options={sub} />
        ));
      },
    })),
    {
      title: "Done",
      value: "__done",
      onSelect: () => openWizardAfter(api, "tiers"),
    },
  ];
  return (
    <api.ui.DialogSelect
      title={`${tier} chain: ${model}${variant ? ` (${variant})` : ""}${list.length ? ` -> ${list.map(t => t.model).join(", ")}` : ""}`}
      placeholder="Select"
      options={opts}
    />
  );
}

/** Tier menu: model / variant / fallback edits plus resume navigation. */
function showTier(api: Api, tier: TierName) {
  const chain = cfg().router.tiers[tier];
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title={`Set up ${tier} tier`}
      placeholder="Select"
      options={[
        { title: `${tier} current: ${chain.model || "unset"}${chain.variant ? ` (${chain.variant})` : ""}`, value: "status" },
        { title: "Choose model", value: "model", onSelect: () => pickModel(api, tier) },
        ...(chain.model ? [{ title: "Edit variant", value: "variant", onSelect: () => pickVariant(api, tier, { provider: chain.model.split("/")[0], id: chain.model, label: chain.model, variant: chain.variant }) }] : []),
        ...(chain.model ? [{ title: "Edit fallback order", value: "fb", onSelect: () => fallbackEditor(api, tier, chain.model, chain.variant) }] : []),
        { title: "Back / resume", value: "back", onSelect: () => tiersWizard(api) },
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
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title={`Set up ${tier} tier (${missing.includes(tier) ? "needs confirmation" : ">" + missing.length + " remaining"})`}
      placeholder="Select"
      options={[
        { title: `${tier} current: ${chain.model || "unset"}${chain.variant ? ` (${chain.variant})` : ""}`, value: "status", description: "Defaults are suggestions — confirm each tier to mark it done." },
        { title: "Choose model", value: "model", onSelect: () => pickModel(api, tier) },
        ...(chain.model ? [{ title: "Edit variant", value: "variant", onSelect: () => pickVariant(api, tier, { provider: chain.model.split("/")[0], id: chain.model, label: chain.model, variant: chain.variant }) }] : []),
        ...(chain.model ? [{ title: "Edit fallback order", value: "fb", onSelect: () => fallbackEditor(api, tier, chain.model, chain.variant) }] : []),
        { title: "Skip to next tier", value: "skip", onSelect: () => { const rest = missing.slice(1); if (rest.length === 0) openWizardAfter(api, missingTiers(cfg()).length === 0 ? "router" : undefined); else showTier(api, rest[0]); } },
        { title: "Cancel", value: "close", onSelect: () => api.ui.dialog.clear() },
      ]}
    />
  ));
}

/* -------------------------------- Router -------------------------------- */

function routerWizard(api: Api) {
  const r = cfg().router;
  const saveOrchestrator = (orchestrator: string, enabled: boolean) => {
    const err = modelError(orchestrator);
    if (err) { errorToast(api, err); return; }
    completeStep("router", { orchestrator, enabled }, undefined, configDir());
    api.ui.toast({ variant: "success", title: "Router saved", message: RESTART });
    openWizardAfter(api);
  };
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Router + orchestrator"
      placeholder="Select"
      options={[
        { title: `Router: ${r.enabled ? "enabled" : "disabled"}`, value: "status" },
        {
          title: r.enabled ? "Disable router" : "Enable router",
          value: "toggle",
          onSelect: () => api.ui.dialog.replace(() => (
            <api.ui.DialogPrompt
              title="Router orchestrator"
              description={() => <text>Current: {r.orchestrator}</text>}
              placeholder="provider/model"
              value={r.orchestrator}
              onCancel={() => routerWizard(api)}
              onConfirm={orchestrator => saveOrchestrator(orchestrator, !r.enabled)}
            />
          )),
        },
        { title: "Close", value: "close", onSelect: () => api.ui.dialog.clear() },
      ]}
    />
  ));
}

/** Settings: router toggle, orchestrator, per-tier full chain editor. */
export function routerSettings(api: Api) {
  const r = cfg().router;
  const refresh = () => routerSettings(api);
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Router settings"
      placeholder="Select"
      options={[
        { title: `Router: ${r.enabled ? "enabled" : "disabled"} (toggle)`, value: "toggle", onSelect: () => { completeStep("router", { orchestrator: r.orchestrator, enabled: !r.enabled }, undefined, configDir()); api.ui.toast({ variant: "success", title: "Router toggled", message: RESTART }); refresh(); } },
        { title: `Orchestrator: ${r.orchestrator}`, value: "orch", onSelect: () => api.ui.dialog.replace(() => (
          <api.ui.DialogPrompt title="Router orchestrator" value={r.orchestrator} onCancel={refresh} onConfirm={v => { const err = modelError(v); if (err) { errorToast(api, err); return; } completeStep("router", { orchestrator: v, enabled: r.enabled }, undefined, configDir()); api.ui.toast({ variant: "success", title: "Orchestrator saved", message: RESTART }); refresh(); }} />
        )) },
        ...TIERS.map(t => ({
          title: `${t}: ${r.tiers[t].model}${r.tiers[t].variant ? ` (${r.tiers[t].variant})` : ""}${renderTargets(api, t).length ? ` -> ${renderTargets(api, t).map(x => x.model).join(", ")}` : ""}`,
          value: t,
          onSelect: () => fallbackEditor(api, t, r.tiers[t].model, r.tiers[t].variant),
        })),
        { title: "Close", value: "close", onSelect: () => api.ui.dialog.clear() },
      ]}
    />
  ));
}

export function openWizard(api: Api) {
  openWizardAfter(api);
}

export function showReset(api: Api) {
  api.ui.dialog.replace(() => (
    <api.ui.DialogConfirm
      title="Reset manager config & wizard?"
      message={`This resets the manager config and wizard progress to defaults. Provider credentials are NOT touched. ${RESTART}`}
      onConfirm={() => {
        resetManager();
        api.ui.dialog.replace(() => (
          <api.ui.DialogAlert title="Reset" message={`Manager config & wizard reset. Credentials untouched. ${RESTART}`} onConfirm={() => api.ui.dialog.clear()} />
        ));
      }}
      onCancel={() => api.ui.dialog.clear()}
    />
  ));
}
