import type { ApplyRequest, ApplyResult, RpcNotification } from './protocol';
export interface RpcRequestOptions {
    timeoutMs?: number;
}
export interface RpcClient {
    apply(request: ApplyRequest, options?: RpcRequestOptions): Promise<ApplyResult>;
    pendingNotifications(lastReceivedId: number, sessionId?: string, options?: RpcRequestOptions): Promise<RpcNotification[]>;
}
export declare function createRpcClient(dir: string, expectedPid?: number): RpcClient;
//# sourceMappingURL=rpc-client.d.ts.map