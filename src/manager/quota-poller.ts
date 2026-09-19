// Vendored cortexkit auth bundles expose their RPC dir + port-file helpers.
import { discoverPortFile as antigravityDiscoverPortFile } from "../../vendor/opencode-antigravity-auth/dist/src/rpc/port-file.js";
import { getRpcDir as antigravityGetRpcDir } from "../../vendor/opencode-antigravity-auth/dist/src/rpc/rpc-dir.js";
import { discoverPortFile as openaiDiscoverPortFile } from "../../vendor/opencode-openai-auth/dist/rpc/port-file.js";
import { getRpcDir as openaiGetRpcDir } from "../../vendor/opencode-openai-auth/dist/rpc/rpc-dir.js";

export type QuotaProvider = "antigravity" | "openai";

export interface PortFileEntry {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
}

export interface QuotaRefreshResult {
  antigravity: boolean;
  openai: boolean;
}

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_REFRESH_DELAY_MS = 2 * 1000;
const MIN_AUTO_REFRESH_GAP_MS = 10 * 1000;

const PROVIDER_COMMANDS: Record<QuotaProvider, string> = {
  antigravity: "google-quota",
  openai: "openai-quota",
};

const PROVIDER_RPC_DIR: Record<QuotaProvider, (projectDir: string) => string> = {
  antigravity: antigravityGetRpcDir,
  openai: openaiGetRpcDir,
};

const PROVIDER_DISCOVER: Record<QuotaProvider, (dir: string) => Promise<PortFileEntry | null>> = {
  antigravity: antigravityDiscoverPortFile,
  openai: openaiDiscoverPortFile,
};

/** Resolve the RPC directory for a provider, optionally scoped to a project. */
export function resolveRpcDir(provider: QuotaProvider, projectDir?: string): string {
  const dir = projectDir ?? process.cwd();
  return PROVIDER_RPC_DIR[provider](dir);
}

/** Locate a live RPC port file for a provider, optionally scoped to a project. */
export async function findPortFile(provider: QuotaProvider, projectDir?: string): Promise<PortFileEntry | null> {
  const rpcDir = resolveRpcDir(provider, projectDir);
  try {
    return await PROVIDER_DISCOVER[provider](rpcDir);
  } catch {
    return null;
  }
}

/** Send an RPC `apply` refresh request to a provider's running server. */
export async function refreshProviderQuota(provider: QuotaProvider, projectDir?: string): Promise<boolean> {
  const entry = await findPortFile(provider, projectDir);
  if (!entry) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${entry.port}/rpc/apply`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${entry.token}`,
      },
      body: JSON.stringify({
        command: PROVIDER_COMMANDS[provider],
        arguments: "refresh",
      }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refresh both providers' quotas. Guarded against re-entrancy and debounced so
 * automatic refreshes happen at most once per MIN_AUTO_REFRESH_GAP_MS unless
 * `force` is set.
 */
export async function refreshAllQuotas(
  projectDir?: string,
  options?: { force?: boolean },
): Promise<QuotaRefreshResult> {
  const force = options?.force ?? false;
  const now = Date.now();
  if (!force && now - lastAutoRefreshAt < MIN_AUTO_REFRESH_GAP_MS) {
    return { antigravity: false, openai: false };
  }
  if (isRefreshing) return { antigravity: false, openai: false };

  isRefreshing = true;
  try {
    const [antigravity, openai] = await Promise.all([
      refreshProviderQuota("antigravity", projectDir),
      refreshProviderQuota("openai", projectDir),
    ]);
    lastAutoRefreshAt = now;
    return { antigravity, openai };
  } finally {
    isRefreshing = false;
  }
}

let isRefreshing = false;
let lastAutoRefreshAt = 0;

export interface QuotaPoller {
  refreshAll: () => Promise<QuotaRefreshResult>;
  onTaskStart: () => void;
  onTaskComplete: () => void;
  dispose: () => Promise<void>;
  eventHandler: (input: { event: any }) => Promise<void>;
}

/**
 * Create a quota poller that periodically refreshes provider quotas and reacts
 * to session task start/complete events with a debounced refresh.
 */
export function createQuotaPoller(projectDir?: string): QuotaPoller {
  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const api: QuotaPoller = {
    refreshAll: () => refreshAllQuotas(projectDir),
    onTaskStart: () => {},
    onTaskComplete: () => {},
    dispose: async () => {},
    eventHandler: async () => {},
  };

  const scheduleDebouncedRefresh = () => {
    if (disposed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void api.refreshAll();
    }, MIN_AUTO_REFRESH_GAP_MS);
  };

  api.onTaskStart = scheduleDebouncedRefresh;
  api.onTaskComplete = scheduleDebouncedRefresh;

  const interval = setInterval(() => {
    void api.refreshAll();
  }, REFRESH_INTERVAL_MS);
  interval.unref();

  const initialTimer = setTimeout(() => {
    void api.refreshAll();
  }, INITIAL_REFRESH_DELAY_MS);
  initialTimer.unref();

  api.dispose = async () => {
    disposed = true;
    clearInterval(interval);
    clearTimeout(initialTimer);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  api.eventHandler = async (input: { event: any }) => {
    const type = input?.event?.type;
    const statusType = input?.event?.properties?.status?.type;
    const isStart = type === "session.created" || (type === "session.status" && statusType === "busy");
    const isComplete = type === "session.idle" || (type === "session.status" && statusType === "idle");
    if (isStart) api.onTaskStart();
    else if (isComplete) api.onTaskComplete();
  };

  return api;
}
