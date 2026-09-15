import type { AccountManager } from './accounts';
import type { ProactiveRefreshQueue } from './refresh-queue';
export interface Disposable {
    dispose(): Promise<void> | void;
}
/**
 * Lifecycle phase for a registered disposable.
 *
 * - `producer`: runs on the same side of the sidebar drain as the
 *   fetch interceptor — the lifecycle disposes producers BEFORE the
 *   sidebar drain so a producer racing with shutdown cannot enqueue
 *   a write that lands after the drain asserts the queue is empty.
 * - `consumer`: runs AFTER the sidebar drain. These are the sinks
 *   (RPC server, file logger) that the TUI / host talk to and that
 *   must stay alive until every queued write has landed.
 */
export type LifecyclePhase = 'producer' | 'consumer';
export interface PluginLifecycleOptions {
    sessionRegistry: {
        clear(): void;
    };
    shutdownDiskSignatureCache: () => Promise<void>;
    clearFetchState: () => void;
    /**
     * Optional drain hook for in-flight sidebar-state writes. Lifecycle
     * awaits this AFTER producers are disposed but BEFORE consumers are
     * disposed, so:
     *   1. producers have stopped (no new writes can land)
     *   2. every queued write has flushed
     *   3. the file logger + RPC server are still alive
     */
    drainSidebarWrites?: () => Promise<void>;
}
export interface PluginLifecycle extends Disposable {
    getAccountManager(): AccountManager | null;
    replaceAccountRuntime(manager: AccountManager, refreshQueue: ProactiveRefreshQueue | null): Promise<void>;
    register(disposable: Disposable, phase?: LifecyclePhase): void;
}
export declare function createPluginLifecycle(options: PluginLifecycleOptions): PluginLifecycle;
//# sourceMappingURL=lifecycle.d.ts.map