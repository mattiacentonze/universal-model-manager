import { tool } from "@opencode-ai/plugin";
import type { PluginInput } from "@opencode-ai/plugin";
import type { RouterConfig, TierConfig } from "./router/config.js";
import { loadConfig } from "./router/config.js";
import { getActiveTiers } from "./router/protocol.js";
import { scrubText } from "./guard/scrub.js";
import { accept } from "./verify/gate.js";
import type { GateDeps } from "./verify/gate.js";
import { extractAssistantText } from "./verify/wiring.js";
import {
  DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS,
  DEFAULT_GATE_BUDGET_MS,
  RouterTimeoutError,
  timeoutMs,
  withTimeout,
} from "./verify/timeout.js";
import {
  buildDelegationDoD,
  tierModel,
  buildForcingNote,
  buildAcceptedSuffix,
  createChangedFileStore,
} from "./verify/dispatch.js";
import {
  newLadderState,
  recordAttempt,
  nextAction,
  advance,
  buildEscalatePolicy,
} from "./escalate/ladder.js";
import { createSessionStore } from "./router/sessions.js";
import { createGuardStore } from "./guard/store.js";
import { dumpDelegateScorecard } from "./telemetry/scorecard-dump.js";

export type ChangedFileStore = ReturnType<typeof createChangedFileStore>;
export type SessionStore = ReturnType<typeof createSessionStore>;
export type GuardStore = ReturnType<typeof createGuardStore>;

export interface SessionCreateResponse {
  data?: {
    id?: string;
  };
}

export interface SessionPromptResponse {
  parts?: Array<{ type?: string; text?: string }>;
  [key: string]: unknown;
}

export interface DelegateToolArgs {
  task: string;
  tier?: string;
  acceptance?: string;
  cwd?: string;
}

export interface DelegateToolContext {
  sessionID?: string;
}

export interface DelegateDeps {
  client: PluginInput["client"];
  getConfig: () => RouterConfig;
  sessionStore: SessionStore;
  guardStore: GuardStore;
  changedFileStore: ChangedFileStore;
  buildGateDeps: (parentSessionID?: string, inFlight?: Set<string>) => GateDeps;
  disposeChildSession: (sessionId: string) => Promise<void>;
  dumpScorecard?: typeof dumpDelegateScorecard;
}

/**
 * Executes a verified delegation attempt across the quality escalation ladder.
 */
export async function executeDelegate(
  args: DelegateToolArgs,
  toolCtx: DelegateToolContext | undefined,
  deps: DelegateDeps,
): Promise<string> {
  // Every ladder iteration creates its own producer session. Tracked out
  // here (not inside the try) so the finally below can dispose any that an
  // early return or a throw skipped — otherwise each retry leaks another.
  const producerSessions: string[] = [];
  try {
    let activeCfg = deps.getConfig();
    try {
      activeCfg = loadConfig();
    } catch {
      activeCfg = deps.getConfig();
    }
    const initialTier =
      typeof args.tier === "string" && args.tier.trim()
        ? args.tier.trim()
        : activeCfg.defaultTier || "medium";
    const dod = buildDelegationDoD({
      prompt: args.task,
      acceptance: args.acceptance,
    });

    const policy = buildEscalatePolicy(activeCfg);
    let state = newLadderState(initialTier, policy);
    const tiersForCost: Record<string, TierConfig> = getActiveTiers(activeCfg);

    // Independent safety net: even a policy bug cannot loop unbounded.
    const safetyMax =
      Math.max(
        policy.maxTotalAttempts,
        policy.ladder.length * (policy.maxAttemptsPerTier + 1),
      ) + 2;
    let safety = 0;

    let producerText = "";
    let forcing: string | null = null;

    /**
     * One turn of the escalation ladder: create a producer session, run
     * the task on it, put the result through the acceptance gate, then
     * tear the session down. Returns null when the backend refused to
     * create a session, the one failure the caller cannot retry.
     */
    const runProducerAttempt = async (
      tier: string,
      forcingNote: string | null,
    ): Promise<{
      sessionID: string;
      text: string;
      gateRes: Awaited<ReturnType<typeof accept>>;
    } | null> => {
      const taskText = forcingNote
        ? `${scrubText(forcingNote)}\n\n${args.task}`
        : args.task;

      const created = (await deps.client.session.create({
        body: {
          ...(toolCtx?.sessionID ? { parentID: toolCtx.sessionID } : {}),
        },
      })) as SessionCreateResponse | undefined;
      const producerSid: string | undefined = created?.data?.id;
      if (!producerSid) return null;
      producerSessions.push(producerSid);
      // Compose with Layer 1: guard the plugin-created producer session.
      try {
        deps.sessionStore.registerProducerSession(producerSid, tier, activeCfg);
      } catch {
        // non-fatal
      }

      const model = tierModel(activeCfg, tier) ?? undefined;
      let attemptProducerText = "";
      // Provider-failover vs quality-escalation precedence (Phase 3.3):
      // Provider-failover is advisory only — a text chain injected into the orchestrator
      // system prompt (buildFallbackInstructions). It is orthogonal to this runtime ladder.
      // A transport/API error here becomes an explicit failed attempt and is treated as
      // exactly ONE failed attempt by the quality-escalation ladder (no provider swap, no
      // double-counted attempt). API error => (advisory) provider failover; verification
      // FAIL => (runtime) quality escalation.
      let producerError: string | null = null;
      try {
        const res = (await withTimeout(
          deps.client.session.prompt({
            path: { id: producerSid },
            body: {
              ...(model ? { model } : {}),
              ...(tier ? { agent: tier } : {}),
              parts: [{ type: "text", text: taskText }],
            },
          }),
          timeoutMs(
            activeCfg.enforcement?.verify?.delegateTimeoutMs,
            DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS,
          ),
          "delegate producer prompt",
        )) as SessionPromptResponse | undefined;
        attemptProducerText = extractAssistantText(res);
      } catch (error) {
        producerError =
          error instanceof Error ? error.message : String(error);
        attemptProducerText = "";
      }

      const artefact = {
        changedFiles: deps.changedFileStore.get(producerSid),
        finalReturnText: attemptProducerText,
        declaredOutputs: dod.deliverable ? [dod.deliverable] : [],
        producerSessionID: producerSid,
        producerTier: tier,
      };

      const gateBudgetMs = timeoutMs(
        activeCfg.enforcement?.verify?.gateBudgetMs,
        DEFAULT_GATE_BUDGET_MS,
      );
      // Grader sessions opened by THIS accept() call, and only those.
      const gateGraderSessions = new Set<string>();
      let gateRes;
      try {
        gateRes = producerError
          ? {
              accepted: false,
              verdict: {
                pass: false,
                method: "none" as const,
                reasons: [`producer failed: ${producerError}`],
              },
              dodSource: dod.source,
            }
          : await withTimeout(
              accept(
                {
                  dod,
                  trivial: false,
                  mode: "modeA",
                  ...(args.cwd ? { cwd: args.cwd } : {}),
                },
                artefact,
                deps.buildGateDeps(toolCtx?.sessionID, gateGraderSessions),
              ),
              gateBudgetMs,
              "verification gate",
            );
      } catch (error) {
        // A gate that ran out of budget is UNMET, never accepted: the
        // one thing worse than a slow verifier is a fast fabricated
        // pass. Abort any grader still in flight so the ceiling is a
        // real cancellation and not just a stopped wait.
        if (error instanceof RouterTimeoutError) {
          for (const gsid of gateGraderSessions) {
            try {
              await deps.client.session.abort({ path: { id: gsid } });
            } catch {
              // best-effort: the gate result stands either way
            }
          }
        }
        gateRes = {
          accepted: false,
          verdict: {
            pass: false,
            method: "none" as const,
            reasons: [
              error instanceof RouterTimeoutError
                ? `verification gate timed out after ${gateBudgetMs}ms`
                : "verification failed (fail-closed)",
            ],
          },
          dodSource: dod.source,
        };
      }

      // Per-attempt cleanup (drop producer session tracking + state).
      deps.changedFileStore.clear(producerSid);
      try {
        deps.sessionStore.unregister(producerSid);
      } catch {
        // non-fatal
      }
      try {
        deps.guardStore.clear(producerSid);
      } catch {
        // non-fatal
      }
      // Dispose this attempt's backend session before the next iteration
      // so a long ladder never accumulates live sessions.
      await deps.disposeChildSession(producerSid);

      return { sessionID: producerSid, text: attemptProducerText, gateRes };
    };

    const dumpScorecardFn = deps.dumpScorecard ?? dumpDelegateScorecard;

    while (true) {
      if (safety++ > safetyMax) {
        return (
          `[router status: unmet] delegation stopped by the safety net after ` +
          `${state.totalAttempts} attempt(s).\n\n${scrubText(producerText)}`
        );
      }
      const tier = state.currentTier;
      const attempt = await runProducerAttempt(tier, forcing);
      if (!attempt) {
        return "[router] delegate failed: could not create a producer session.";
      }
      producerText = attempt.text;
      const producerSid = attempt.sessionID;
      const gateRes = attempt.gateRes;

      const costRatio =
        typeof tiersForCost?.[tier]?.costRatio === "number"
          ? tiersForCost[tier].costRatio
          : 1;
      state = recordAttempt(state, costRatio);

      const action = nextAction(
        state,
        { pass: gateRes.accepted, reasons: gateRes.verdict.reasons },
        policy,
      );

      if (action.action === "accept") {
        dumpScorecardFn(
          producerSid,
          state,
          true,
          gateRes.verdict.method,
        );
        return producerText + buildAcceptedSuffix(gateRes.verdict.method);
      }
      if (action.action === "give_up") {
        dumpScorecardFn(
          producerSid,
          state,
          false,
          gateRes.verdict.method,
        );
        const note = scrubText(buildForcingNote(gateRes.verdict.reasons));
        return (
          `[router status: unmet] The delegated result was not accepted after ` +
          `${state.totalAttempts} attempt(s) across ${state.escalations} escalation(s) ` +
          `(final tier ${state.currentTier}; ${action.reason ?? "verification failed"}).\n\n` +
          `${scrubText(producerText)}\n\n${note}`
        );
      }
      // retry or escalate
      forcing = action.forcingMessage ?? null;
      state = advance(state, action);
    }
  } catch {
    return "[router] delegate failed (fail-closed): the delegation or verification could not complete.";
  } finally {
    // Safety net for every exit path an end-of-iteration dispose cannot
    // reach: accept/give-up returns, the safety-net return, and throws.
    // disposeChildSession is fail-soft, so re-disposing an already
    // disposed session is harmless.
    for (const sid of producerSessions) {
      await deps.disposeChildSession(sid);
    }
  }
}

/**
 * Creates the delegate tool definition with the execution ladder wired to the provided dependencies.
 */
export function createDelegateTool(deps: DelegateDeps): ReturnType<typeof tool> {
  return tool({
    description:
      "Delegate a task to a tier subagent (fast | medium | heavy). The subagent's result is INDEPENDENTLY VERIFIED (deterministic checks, or an independent grader at >= the producer tier in a fresh session) before it is returned. Returns an accepted result on PASS, or an honest 'unmet' status on FAIL — never a self-reported completion. Optionally pass an [acceptance]...[/acceptance] block to define the Definition of Done.",
    args: {
      task: tool.schema
        .string()
        .describe("The task for the subagent to perform."),
      tier: tool.schema
        .string()
        .optional()
        .describe("fast | medium | heavy. Defaults to the router default tier."),
      acceptance: tool.schema
        .string()
        .optional()
        .describe(
          "Optional [acceptance]...[/acceptance] block defining the Definition of Done (check: / criteria: / deliverable: directives).",
        ),
      cwd: tool.schema
        .string()
        .optional()
        .describe(
          "Optional working directory used to VERIFY the result: relative check paths resolve against it and the grader session runs in it. It does NOT scope the producer subagent, so the task text must still tell the producer where to work.",
        ),
    },
    execute: (args, toolCtx) => executeDelegate(args, toolCtx, deps),
  });
}
