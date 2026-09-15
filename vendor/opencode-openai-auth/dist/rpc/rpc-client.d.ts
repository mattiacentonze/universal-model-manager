import { type PortFileEntry } from './port-file';
import type { ApplyRequest, ApplyResult, RpcNotification } from './protocol';
export interface RpcClient {
    pending: (lastReceivedId: number, sessionId?: string) => Promise<RpcNotification[]>;
    apply: (request: ApplyRequest, timeoutMs?: number) => Promise<ApplyResult>;
}
export declare const DEFAULT_RPC_TIMEOUT_MS = 2000;
export declare function createRpcClient(dir: string, expectedPid?: number, onSelected?: (entry: PortFileEntry | null) => void): RpcClient;
