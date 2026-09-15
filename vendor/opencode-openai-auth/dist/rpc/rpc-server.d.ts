import type { drainNotifications } from './notifications';
import type { ApplyRequest, ApplyResult } from './protocol';
export interface RpcServerHandle {
    port: number;
    token: string;
    stop: () => Promise<void>;
}
export interface RpcServerOptions {
    dir: string;
    secureDir?: boolean;
    sweepRoot?: string;
    drain: typeof drainNotifications;
    apply: (request: ApplyRequest) => Promise<ApplyResult>;
    timeoutMs?: number;
    receiptTimeoutMs?: number;
}
export declare function startRpcServer(options: RpcServerOptions): Promise<RpcServerHandle>;
