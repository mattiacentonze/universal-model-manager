import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatLadderScorecard } from "../escalate/ladder.js";
import { formatScorecard } from "../guard/enforce.js";
import type { createGuardStore } from "../guard/store.js";
import type { createSessionStore } from "../router/sessions.js";
import type { createTrajectoryStore } from "./trajectory.js";

export type GuardStore = ReturnType<typeof createGuardStore>;
export type SessionStore = ReturnType<typeof createSessionStore>;
export type TrajectoryStore = ReturnType<typeof createTrajectoryStore>;

const TRAJECTORY_DIR = join(tmpdir(), "opencode-model-router-trajectory");

function sanitizeSessionId(sid: string): string {
  return sid.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function dumpDelegateScorecard(
  sid: string,
  st: Parameters<typeof formatLadderScorecard>[0],
  accepted: boolean,
  method: string,
): void {
  try {
    const line = formatLadderScorecard(st, accepted, method);
    const safeSid = sanitizeSessionId(sid);
    mkdirSync(TRAJECTORY_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(TRAJECTORY_DIR, `${safeSid}.delegate.log`), `${line}\n`, { flag: "a", mode: 0o600 });
  } catch {
    // best-effort only
  }
}

export function dumpSessionScorecards(
  sid: string,
  guardStore: GuardStore,
  sessionStore: SessionStore,
  trajectoryStore: TrajectoryStore,
  env: NodeJS.ProcessEnv = process.env,
): void {
  // Per-delegation scorecard: only when enforcement was active (guard state exists).
  try {
    const gstate = guardStore.get(sid);
    if (gstate) {
      const line = formatScorecard(gstate, sessionStore.getTier(sid));
      const safeSid = sanitizeSessionId(sid);
      mkdirSync(TRAJECTORY_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(join(TRAJECTORY_DIR, `${safeSid}.scorecard.log`), `${line}\n`, { flag: "a", mode: 0o600 });
    }
  } catch {
    // best-effort: a scorecard must never crash a real session
  }

  // Opt-in full trajectory dump (unchanged gating).
  if (env.MODEL_ROUTER_TRAJECTORY_DEBUG !== "1") return;
  const dump = trajectoryStore.dump(sid);
  if (!dump) return;
  try {
    const safeSid = sanitizeSessionId(sid);
    mkdirSync(TRAJECTORY_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(TRAJECTORY_DIR, `${safeSid}.log`), `${dump}\n`, { flag: "a", mode: 0o600 });
  } catch {
    // best-effort
  }
}
