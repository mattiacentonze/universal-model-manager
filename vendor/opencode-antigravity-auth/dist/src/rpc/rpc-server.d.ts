import type { ApplyRequest, ApplyResult, RpcNotification } from './protocol';
export interface StartRpcServerOptions {
    dir: string;
    apply(request: ApplyRequest): Promise<ApplyResult> | ApplyResult;
    drain(lastReceivedId: number, sessionId?: string): Promise<RpcNotification[]> | RpcNotification[];
}
export interface RpcServerHandle {
    port: number;
    token: string;
    stop(): Promise<void>;
}
export declare function startRpcServer(options: StartRpcServerOptions): Promise<RpcServerHandle>;
//# sourceMappingURL=rpc-server.d.ts.map