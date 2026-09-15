import type { AccountManager } from './accounts';
import type { GetAuth } from './auth';
import type { AntigravityConfig } from './config';
import type { AgyTransport, FetchImpl } from './dependencies';
import type { OperatorSettingsController } from './operator-settings';
import type { QuotaManager } from './quota';
import { type AgySessionRegistry } from './session-context';
import type { PluginClient } from './types';
/**
 * Inputs the fetch interceptor needs from the plugin bootstrap. Everything
 * the original closure captured from `plugin.ts` now flows through this
 * record so a fresh interceptor can be built per plugin instance without
 * sharing state with siblings.
 */
export interface FetchInterceptorContext {
    readonly client: PluginClient;
    readonly directory: string;
    readonly providerId: string;
    readonly config: AntigravityConfig;
    readonly accountManager: AccountManager;
    readonly quotaManager: QuotaManager;
    readonly getAuth: GetAuth;
    readonly agySessionRegistry: AgySessionRegistry;
    /**
     * Live operator settings controller. Optional for backward
     * compatibility — when present, the interceptor reads routing
     * overrides and killswitch thresholds per request.
     */
    readonly operatorSettings?: OperatorSettingsController;
    /**
     * Transport adapter used for Antigravity HTTPS requests. Defaults to
     * the production `fetchWithAgyCliTransport` when omitted; tests inject
     * a deterministic stub so the e2e workspace can route calls at a mock
     * server bound to 127.0.0.1.
     */
    readonly agyTransport?: AgyTransport;
    /**
     * HTTP primitive used for non-Antigravity URLs. Defaults to
     * `globalThis.fetch`; tests inject a guarded stub that refuses any
     * non-loopback target so a regression cannot silently leak a real
     * network call.
     */
    readonly fetchImpl?: FetchImpl;
}
/**
 * Public surface exposed to the auth-loader plumbing. `fetch` mirrors the
 * host signature so it can be slotted into `LoaderResult` unchanged.
 */
export interface FetchInterceptor {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    dispose(): void;
}
/**
 * Wraps the upstream fetch with the full account-rotation, rate-limit, and
 * quota-fallback pipeline. Each interceptor owns its retry/warmup bookkeeping
 * so disposing the plugin releases every counter.
 */
export declare function createFetchInterceptor(context: FetchInterceptorContext): FetchInterceptor;
//# sourceMappingURL=fetch-interceptor.d.ts.map