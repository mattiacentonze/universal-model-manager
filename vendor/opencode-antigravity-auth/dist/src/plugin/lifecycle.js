const NOOP_DRAIN = async () => { };
export function createPluginLifecycle(options) {
    let accountManager = null;
    let refreshQueue = null;
    let disposal = null;
    const producers = [];
    const consumers = [];
    const drainSidebarWrites = options.drainSidebarWrites ?? NOOP_DRAIN;
    const disposeAccountRuntime = async () => {
        const oldQueue = refreshQueue;
        const oldManager = accountManager;
        refreshQueue = null;
        accountManager = null;
        await oldQueue?.dispose();
        await oldManager?.dispose();
    };
    const register = (disposable, phase = 'consumer') => {
        if (disposal) {
            void disposable.dispose();
            return;
        }
        if (phase === 'producer') {
            producers.push(disposable);
        }
        else {
            consumers.push(disposable);
        }
    };
    return {
        getAccountManager: () => accountManager,
        async replaceAccountRuntime(manager, queue) {
            await disposeAccountRuntime();
            if (disposal) {
                await queue?.dispose();
                await manager.dispose();
                return;
            }
            accountManager = manager;
            refreshQueue = queue;
        },
        register,
        dispose() {
            if (!disposal) {
                disposal = (async () => {
                    await disposeAccountRuntime();
                    await options.shutdownDiskSignatureCache();
                    options.sessionRegistry.clear();
                    options.clearFetchState();
                    // 1. Stop and await all producers (e.g. fetch interceptor).
                    //    This prevents NEW sidebar writes from being enqueued
                    //    while the drain is in flight.
                    for (const disposable of producers) {
                        await disposable.dispose();
                    }
                    producers.length = 0;
                    // 2. Drain sidebar writes. Every write enqueued by a now-stopped
                    //    producer lands here before the consumers (RPC server, file
                    //    logger) are torn down.
                    await drainSidebarWrites();
                    // 3. Stop consumers. The TUI's last frame can still observe a
                    //    fully landed snapshot because the file logger is still alive
                    //    during the drain.
                    for (const disposable of consumers) {
                        await disposable.dispose();
                    }
                    consumers.length = 0;
                })();
            }
            return disposal;
        },
    };
}
//# sourceMappingURL=lifecycle.js.map