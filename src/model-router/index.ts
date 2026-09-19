import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { dispatchRouterCommand } from "./commands/dispatch.js";
import { createDelegateTool } from "./delegate.js";
import { guardAfterCall, guardBeforeCall } from "./guard/enforce.js";
import { detectNarration } from "./guard/narration.js";
import { scrubText } from "./guard/scrub.js";
import { createGuardStore } from "./guard/store.js";
import { buildAgentOptions, warnAgentOptionsEffortOnce } from "./router/agent-options.js";
import type { Catalog } from "./router/catalog.js";
import { findOrphanedStrongPatterns, validateModels } from "./router/catalog.js";
import { fetchLiveCatalog } from "./router/catalog-client.js";
// Imports for internal use within this module
import { loadConfig } from "./router/config.js";
import { resolveEnforcementMode } from "./router/enforcement.js";
import { createIdleTtlSweeper } from "./router/idle-sweep.js";
import { createPluginLogger } from "./router/logger.js";
import { selectTierPrompt } from "./router/prompts.js";
import {
  assembleSystemPrompt,
  CLAUDE_ANTI_NARRATION,
  CLAUDE_TIER_PREFIX,
  getActiveTiers,
  isClaudeModel,
} from "./router/protocol.js";
import type { Cap, SubagentState } from "./router/sessions.js";
import { createSessionStore, READ_ONLY_TOOLS } from "./router/sessions.js";
import { mergeSubagentOverride, resolveSubagentOverrides } from "./router/subagents.js";
import { dumpSessionScorecards } from "./telemetry/scorecard-dump.js";
import { createTrajectoryStore } from "./telemetry/trajectory.js";
import {
  buildDelegationDoD,
  buildForcingNote,
  createChangedFileStore,
  parseTaskResult,
  shouldVerifyTask,
} from "./verify/dispatch.js";
import { accept } from "./verify/gate.js";
import { createVerificationWiring } from "./verify/wiring.js";

// ---------------------------------------------------------------------------
// Re-exports — type-only re-exports for IDE/test consumers.
// NOTE: value re-exports are intentionally absent. opencode's plugin loader
// calls every function export as a factory (Ck iterates Object.values(mod));
// adding named function exports would cause spurious factory calls.
// Tests import from their specific source files instead of this entry point.
// ---------------------------------------------------------------------------

export type { GuardCall, GuardDecision, GuardPolicy, GuardState } from "./guard/guards.js";
export type {
  EnforcementConfig,
  FallbackConfig,
  ModeConfig,
  Preset,
  RouterConfig,
  TierConfig,
} from "./router/config.js";
export type { EnforcementMode } from "./router/enforcement.js";
export type { TrajectoryState, TrajectoryToolEvent } from "./telemetry/trajectory.js";
export type { Cap, SubagentState };

const ModelRouterPlugin: Plugin = async (ctx: PluginInput) => {
  let cfg = loadConfig();
  const activeTiers = getActiveTiers(cfg);

  // Per-plugin-instance session store: owns subagentSessionIDs and subagentCapState.
  const sessionStore = createSessionStore();

  // Per-plugin-instance trajectory store (Phase 0.3 scaffolding — RECORD-ONLY).
  // Observes subagent tool activity to build a per-session scorecard. It emits
  // NOTHING into any model-visible output; the only externally observable effect
  // is an opt-in debug dump gated behind MODEL_ROUTER_TRAJECTORY_DEBUG=1.
  const trajectoryStore = createTrajectoryStore();

  // Per-plugin-instance guard state (Layer 1 hard-block). Only engaged for
  // subagent sessions when enforcement mode is advisory/enforced; in "off"
  // mode no guard state is ever created, so behaviour stays byte-identical.
  const guardStore = createGuardStore();

  const changedFileStore = createChangedFileStore();

  // Idle-TTL maintenance for the four per-instance stores. No timer is
  // scheduled: the sweeper is invoked opportunistically from chat.message and
  // self-throttles, so a long-lived plugin instance cannot accumulate state for
  // sessions that went away without a teardown hook.
  const sweepIdleStores = createIdleTtlSweeper([
    () => sessionStore.sweep(),
    () => guardStore.sweep(),
    () => trajectoryStore.sweep(),
    () => changedFileStore.sweep(),
  ]);

  // Layer-2's impure corner: exec, fs, and the opencode client, built once and
  // read back through getConfig so a reloaded cfg (from /preset, /budget or
  // /router enforce) applies to graded work too.
  const { graderSessions, buildGateDeps, disposeChildSession } = createVerificationWiring({
    client: ctx.client,
    directory: ctx.directory,
    getConfig: () => cfg,
  });

  // Bypass mode: when true, the router skips all system prompt injection,
  // subagent tracking, cap enforcement, and narration detection for the
  // current plugin lifetime (i.e., until OpenCode is restarted).
  let bypassed = false;

  // Passive warnings go to opencode's log rather than stderr: console output
  // from a plugin paints over the TUI. Falls back to console when the server
  // has no /log endpoint. See src/router/logger.ts.
  const logger = createPluginLogger(ctx.client);

  // Fetch and normalize opencode's live provider/model catalog. Best-effort:
  // returns null when the client call fails, e.g. the server is not ready yet.
  const fetchCatalog = (): Promise<Catalog | null> => fetchLiveCatalog(ctx.client);

  // Deferred passive catalog check. The first orchestrator turn only STARTS the
  // fetch (fire-and-forget, never awaited on the chat.message hot path) and
  // parks the result in a local; the warning is emitted on the first LATER turn
  // that finds the promise already settled — normally turn 2. Deliberate
  // tradeoff: a report-only diagnostic showing up one turn late costs nothing,
  // while awaiting a network round-trip in front of every session's first
  // message costs every user every session. No timers (banned in src/), and the
  // continuation writes to a local variable only — it never touches an
  // output.parts of a message the hook has already returned.
  //
  // Command handlers deliberately keep their own fresh fetchCatalog() call, so a
  // turn-1 failure (server not ready yet) is never cached into `/router models`.
  let catalogFetchStarted = false;
  /** undefined = not started or still in flight; null = the fetch failed. */
  let deferredCatalog: Catalog | null | undefined;
  // One-shot guard so the passive warnings run at most once per plugin
  // lifetime; re-validate on demand with /router.
  let catalogWarned = false;

  const startCatalogFetch = (): void => {
    if (catalogFetchStarted) return;
    catalogFetchStarted = true;
    // fetchCatalog already swallows its own errors; the .catch is belt-and-
    // braces so this fire-and-forget promise can never reject unhandled.
    void fetchCatalog()
      .then((c) => {
        deferredCatalog = c;
      })
      .catch(() => {
        deferredCatalog = null;
      });
  };

  const enableDelegateTool =
    cfg.experimental?.verifiedDelegateTool === true || process.env.MODEL_ROUTER_VERIFIED_DELEGATE === "1";

  return {
    // Warnings post to /log fire-and-forget, which loses the message when the
    // process is about to exit — `opencode run` and `opencode debug` are short
    // enough for that to be the normal case. Verified against opencode 1.18.16
    // that dispose is both called and awaited, so flushing here is enough.
    dispose: async () => {
      await logger.flush();
    },
    tool: {
      ...(enableDelegateTool
        ? {
            delegate: createDelegateTool({
              client: ctx.client,
              getConfig: () => cfg,
              sessionStore,
              guardStore,
              changedFileStore,
              buildGateDeps,
              disposeChildSession,
            }),
          }
        : {}),
    },

    // -----------------------------------------------------------------------
    // Detect subagent calls via chat.message. When the agent name matches a
    // registered tier, record the sessionID so system.transform can skip
    // delegation-protocol injection.
    //
    // Note: The hook signature `: any` parameters below are dictated by the
    // untyped hook signatures in @opencode-ai/plugin's Plugin interface.
    // -----------------------------------------------------------------------
    "chat.params": async (input: any, output: any) => {
      try {
        if (input?.sessionID && graderSessions.has(input.sessionID)) {
          const graderTemperature = cfg.enforcement?.verify?.graderTemperature;
          if (graderTemperature !== undefined) {
            output.temperature = graderTemperature;
          }
        }
      } catch {
        // best-effort: never crash a real session
      }
    },

    "chat.message": async (input: any, output: any) => {
      if (bypassed) return;
      // Re-read cfg so /preset switches take effect without restart
      try {
        cfg = loadConfig();
      } catch {}
      try {
        sweepIdleStores();
      } catch {
        // best-effort maintenance: never break a real turn
      }
      const tierNames = Object.keys(getActiveTiers(cfg));
      const sid = input?.sessionID;
      try {
        const registration = sessionStore.registerFromChatMessage(input, output, cfg, tierNames);
        // A same-session same-tier re-registration is a resumed dispatch
        // (how an opencode task_id resume reaches this hook): start a new
        // per-dispatch guard round and count it in telemetry.
        if (registration.resumed === true && typeof sid === "string") {
          guardStore.beginDispatch(sid);
          trajectoryStore.recordResume(sid, input?.agent ?? null);
        }
        // KNOWN RESIDUAL: a fresh registration over an EXISTING session (same
        // sessionID, different tier) resets session cap state but leaves guard
        // state alone, so the guard keeps counting from the old dispatch. The
        // desync can only make the guard stricter, never laxer, and opencode
        // assigns one agent per subagent session — so this is documented in
        // docs/CONFIG_REFERENCE.md rather than fixed by clearing guard state,
        // which would also drop deliverable and fingerprint history.
      } catch {
        // best-effort: never crash a real session during registration
      }

      // Record-only: initialise a trajectory scorecard for tracked subagents.
      if (sid && sessionStore.isSubagent(sid)) {
        trajectoryStore.ensure(sid, input?.agent ?? null);
      }

      // Once per lifetime, warn in the plugin log when the active preset points
      // at models opencode's catalog says are missing or deprecated, or when a
      // strong-model pattern matches nothing the configured providers serve.
      if (sid && !sessionStore.isSubagent(sid)) {
        try {
          if (!catalogFetchStarted) {
            // Turn 1: kick the fetch off and move on. NO await here.
            startCatalogFetch();
          } else if (!catalogWarned && deferredCatalog !== undefined) {
            // A later turn found the turn-1 fetch already settled: report now.
            catalogWarned = true;
            const catalog = deferredCatalog;
            if (catalog) {
              for (const p of findOrphanedStrongPatterns(cfg, catalog)) {
                logger.warn(
                  `strong-model pattern '${p}' from your modelGenerations.strong matches no model your providers serve, so it decides nothing — separator style is already ignored when matching`,
                  { pattern: p },
                );
              }
              for (const it of validateModels(cfg, catalog)) {
                const hint = it.suggestions.length > 0 ? ` — try ${it.suggestions.join(", ")}` : "";
                const where = it.scope === "fallback" ? `${it.tier}[${it.providerId}]` : `@${it.tier}`;
                logger.warn(`${where} ${it.ref}: ${it.kind}${hint}`, {
                  tier: it.tier,
                  ref: it.ref,
                  kind: it.kind,
                  suggestions: it.suggestions,
                });
              }
            }
          }
        } catch {
          // best-effort: never disrupt a real session
        }
      }
    },

    // -----------------------------------------------------------------------
    // Hard-block enforcement (Layer 1). Fires before tool execution; only
    // engaged for subagent sessions when enforcement mode is advisory/enforced.
    // -----------------------------------------------------------------------
    "tool.execute.before": async (input: any, output: any) => {
      if (bypassed) return;
      const sid = input?.sessionID;
      if (!sid || !sessionStore.isSubagent(sid) || typeof input?.tool !== "string") {
        return;
      }
      sessionStore.touchIfTracked(sid);
      let res: ReturnType<typeof guardBeforeCall>;
      try {
        res = guardBeforeCall({
          cfg,
          tier: sessionStore.getTier(sid),
          trivial: sessionStore.isTrivial(sid),
          sessionID: sid,
          tool: input.tool,
          toolArgs: output?.args,
          store: guardStore,
          env: process.env,
        });
      } catch {
        return; // never break a real session on a guard-internal error
      }
      if (res.block) {
        trajectoryStore.recordToolEvent(sid, {
          tool: input.tool,
          readOnly: READ_ONLY_TOOLS.has(input.tool),
          blocked: true,
          selfScript: res.guard === "anti_self_script",
        });
        throw new Error(res.message);
      }
    },

    // -----------------------------------------------------------------------
    // Runtime cap + redundancy enforcement (subagents only).
    // Appends banners to every read-only tool result the subagent sees.
    // -----------------------------------------------------------------------
    "tool.execute.after": async (input: any, output: any) => {
      if (bypassed) return;
      sessionStore.recordToolCall(input, output);

      const sid = input?.sessionID;

      // Attribute changed files to whichever session made the edit (any session).
      if (sid && typeof input?.tool === "string") {
        changedFileStore.record(sid, input.tool, input?.args);
      }

      if (sid && sessionStore.isSubagent(sid) && typeof input?.tool === "string") {
        trajectoryStore.recordToolEvent(sid, {
          tool: input.tool,
          readOnly: READ_ONLY_TOOLS.has(input.tool),
        });
        try {
          guardAfterCall({
            cfg,
            tier: sessionStore.getTier(sid),
            sessionID: sid,
            tool: input.tool,
            toolArgs: input?.args,
            output,
            store: guardStore,
          });
        } catch {
          // best-effort: enforcement must never crash a real session
        }
      }

      // Verify-dispatch around the built-in `task` tool
      if (typeof input?.tool === "string") {
        let mode = "off";
        try {
          mode = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
        } catch {
          // fall through with mode "off"
        }
        const requireMode = cfg.enforcement?.verify?.require;
        if (shouldVerifyTask(input.tool, mode, requireMode)) {
          try {
            const { finalReturnText, childSessionID } = parseTaskResult(output);
            const producerTier = typeof input?.args?.subagent_type === "string" ? input.args.subagent_type : "";
            const dod = buildDelegationDoD({
              prompt: input?.args?.prompt,
              description: input?.args?.description,
            });
            const artefact = {
              changedFiles: childSessionID ? changedFileStore.get(childSessionID) : [],
              finalReturnText,
              declaredOutputs: dod.deliverable ? [dod.deliverable] : [],
              producerSessionID: childSessionID ?? "",
              producerTier,
            };
            const trivial = childSessionID ? sessionStore.isTrivial(childSessionID) : false;

            if (dod.source === "inferred" && dod.kind === "checker" && artefact.changedFiles.length === 0) {
              if (childSessionID) changedFileStore.clear(childSessionID);
              return;
            }

            const res = await accept(
              {
                dod,
                trivial,
                mode: "modeA",
                ...(typeof input?.args?.cwd === "string" && input.args.cwd ? { cwd: input.args.cwd } : {}),
              },
              artefact,
              buildGateDeps(),
            );
            if (!res.accepted && !res.verdict.skipped) {
              const ladder = cfg.enforcement?.escalate?.ladder ?? ["fast", "medium", "heavy"];
              const li = ladder.indexOf(producerTier);
              const nextTier = li >= 0 && li < ladder.length - 1 ? ladder[li + 1] : null;
              const note = scrubText(buildForcingNote(res.verdict.reasons, { producerTier, nextTier }));
              output.output = typeof output.output === "string" ? `${output.output}\n\n${note}` : note;
            }
            if (childSessionID) changedFileStore.clear(childSessionID);
          } catch {
            // fail-closed: a verification error must NEVER throw out of the after-hook
          }
        }
      }
    },

    // -----------------------------------------------------------------------
    // Narration detector — flags progress-commentary-without-production.
    // -----------------------------------------------------------------------
    "experimental.text.complete": async (_input: any, output: any) => {
      if (bypassed || !cfg.antiNarration) return;
      const text = output?.text;
      if (typeof text !== "string" || text.length < 20) return;

      const found = detectNarration(text);
      if (found.length === 0) return;

      const quoted = found.map((m) => `"${m.slice(0, 60)}${m.length > 60 ? "…" : ""}"`).join(", ");
      output.text = `${text}\n\n[⚠ narration detected: ${quoted}]`;
    },

    // -----------------------------------------------------------------------
    // Gated trajectory debug dump (Phase 0.3, T0.3.3) — RECORD-ONLY, OPT-IN.
    // -----------------------------------------------------------------------
    event: async ({ event }: any) => {
      if (event?.type !== "session.idle") return;
      const sid = event?.properties?.sessionID;
      if (typeof sid !== "string") return;

      dumpSessionScorecards(sid, guardStore, sessionStore, trajectoryStore);
    },

    // -----------------------------------------------------------------------
    // Register tier agents + commands at load time
    // -----------------------------------------------------------------------
    config: async (opencodeConfig: any) => {
      opencodeConfig.agent ??= {};

      for (const [name, tier] of Object.entries(activeTiers)) {
        const resolvedPrompt = tier.prompt ?? selectTierPrompt(name, tier, cfg);

        const claudePrefix = isClaudeModel(tier.model)
          ? cfg.antiNarration
            ? `${CLAUDE_TIER_PREFIX[name]}\n\n${CLAUDE_ANTI_NARRATION}`
            : CLAUDE_TIER_PREFIX[name]
          : undefined;
        const finalPrompt =
          claudePrefix && resolvedPrompt ? `${claudePrefix}\n\n---\n\n${resolvedPrompt}` : resolvedPrompt;

        const agentDef: Record<string, unknown> = {
          model: tier.model,
          mode: "subagent",
          description: tier.description ?? `@${name} tier (${tier.model})`,
          maxSteps: tier.steps,
          prompt: finalPrompt,
          color: tier.color,
        };

        if (tier.variant) {
          agentDef.variant = tier.variant;
        }

        const opts = buildAgentOptions(tier, name, logger);
        if (Object.keys(opts).length > 0) {
          agentDef.options = opts;
        }
        if (typeof opts.effort === "string") {
          warnAgentOptionsEffortOnce(
            "anthropic-effort-dependency",
            "effort on Anthropic models requires the opencode-anthropic-fix plugin (commit 307aea9+ for fable/mythos); non-adaptive Claude models (e.g. haiku) silently strip effort at the API layer, and without the plugin a top-level effort can break Claude-Code billing fingerprinting",
            logger,
          );
        }

        opencodeConfig.agent[name] = agentDef;
      }

      const subagentOverrides = resolveSubagentOverrides({
        subagentTiers: cfg.subagentTiers,
        tiers: activeTiers,
        existingAgents: opencodeConfig.agent,
      });
      for (const [agentName, override] of Object.entries(subagentOverrides)) {
        opencodeConfig.agent[agentName] = mergeSubagentOverride(opencodeConfig.agent[agentName], override);
      }

      opencodeConfig.command ??= {};
      opencodeConfig.command.tiers = {
        template: "",
        description: "Show model delegation tiers and rules",
      };
      opencodeConfig.command.preset = {
        template: "$ARGUMENTS",
        description: "Show or switch model presets (e.g., /preset openai)",
      };
      opencodeConfig.command.budget = {
        template: "$ARGUMENTS",
        description: "Show or switch routing mode (e.g., /budget, /budget budget, /budget quality)",
      };
      opencodeConfig.command.bypass = {
        template: "$ARGUMENTS",
        description: "Toggle model-router bypass (disables delegation protocol for this session)",
      };
      opencodeConfig.command["annotate-plan"] = {
        template: [
          "Annotate the plan with tier directives for model delegation.",
          "",
          'Plan file: "$ARGUMENTS"',
          "If no file was specified, search for the active plan: PLAN.md, plan.md, or the most recent .md with 'plan' in the name in the current directory or project root.",
          "",
          "## Available tiers",
          "- `[tier:fast]` — Fast/cheap model: exploration, search, file reads, grep, listing, research. Agent does NOT edit code.",
          "- `[tier:medium]` — Balanced model: implementation, refactoring, tests, code review, bug fixes, standard coding tasks.",
          "- `[tier:heavy]` — Most capable model: architecture, complex debugging (after failures), security, performance, multi-system tradeoffs.",
          "",
          "## Annotation rules",
          "1. Place `[tier:X]` at the START of each step, before the description",
          "2. Research/exploration -> `[tier:fast]` (preferred)",
          "3. Implementation/code -> `[tier:medium]` (preferred)",
          "4. Architecture/security/hard debugging -> `[tier:heavy]`",
          "5. If a step mixes exploration AND implementation, prefer splitting it into two steps when it improves delegation clarity",
          "6. Verification (run tests, build) -> `[tier:medium]`",
          "7. Trivial (single grep or file read) -> `[tier:fast]`",
          "8. Final review of the complete plan -> `[tier:heavy]`",
          "",
          "## Output",
          "Rewrite the entire plan in the file with the tags. Do not change the substance — only add tags, and split mixed steps when useful for clearer delegation.",
          "",
          "## Acceptance blocks (for enforcement)",
          "For each NON-TRIVIAL task, append an acceptance block immediately after the step so the router can verify the work:",
          "[acceptance]",
          'check: <testsPass | buildPasses | lintClean | fileExists path=... | run command="..." expect=...>',
          "criteria: <plain-language success condition, when no deterministic check applies>",
          "deliverable: <path or short description>",
          "[/acceptance]",
          "Prefer deterministic checks (testsPass/buildPasses/fileExists). Use a criteria line for design/explanatory tasks. Trivial read-only steps need no acceptance block.",
        ].join("\n"),
        description: "Annotate a plan with [tier:fast/medium/heavy] delegation tags",
      };
      opencodeConfig.command.router = {
        template: "$ARGUMENTS",
        description:
          "Model-router controls (e.g., /router enforce off|advisory|enforced, /router overrides, /router models)",
      };
    },

    // -----------------------------------------------------------------------
    // Inject delegation protocol — uses cached config (invalidated on /preset or /budget)
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (_input: any, output: any) => {
      if (bypassed) return;
      try {
        cfg = loadConfig();
      } catch {}

      const sessionID = _input?.sessionID;
      if (sessionID && sessionStore.isSubagent(sessionID)) return;

      const providerID = _input?.model?.providerID ?? "";
      const modelID = _input?.model?.modelID ?? "";
      const orchestratorModel = providerID && modelID ? `${providerID}/${modelID}` : modelID;

      let enfOn = false;
      try {
        enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off";
      } catch {}
      output.system.push(assembleSystemPrompt(cfg, orchestratorModel, enfOn));
    },

    // -----------------------------------------------------------------------
    // Handle /tiers, /preset, /bypass, /budget, and /router commands
    // -----------------------------------------------------------------------
    "command.execute.before": async (input: any, output: any) => {
      const result = await dispatchRouterCommand(input?.command, input?.arguments ?? "", {
        getConfig: () => {
          try {
            cfg = loadConfig();
          } catch {}
          return cfg;
        },
        getBypassed: () => bypassed,
        setBypassed: (val) => {
          bypassed = val;
        },
        fetchCatalog,
      });

      if (result !== null) {
        output.parts.push({
          type: "text" as const,
          text: result,
        });
      }
    },
  };
};

export default ModelRouterPlugin;
