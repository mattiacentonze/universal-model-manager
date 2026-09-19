import type { PluginInput } from "@opencode-ai/plugin";
import type { Catalog } from "./catalog.js";
import { normalizeCatalog } from "./catalog.js";

export interface ProvidersConfigResponse {
  data?: unknown;
}

/**
 * Fetch and normalize opencode's live provider/model catalog.
 * Best-effort: returns null when the client call fails (e.g. the server is not ready yet).
 */
export async function fetchLiveCatalog(client: PluginInput["client"]): Promise<Catalog | null> {
  try {
    const res = (await client.config.providers()) as ProvidersConfigResponse | undefined;
    return normalizeCatalog(res?.data);
  } catch {
    return null;
  }
}
