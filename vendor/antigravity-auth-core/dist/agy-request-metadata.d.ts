export interface AgyRequestSessionContext {
    conversationId: string;
    trajectoryId: string;
    numericSessionId: string;
    usedClaude?: boolean;
    usedNonGeminiModel?: boolean;
    lastExecutionId?: string;
}
export interface AgyRequestSessionStoreOptions {
    ttlMs?: number;
    maxEntries?: number;
    now?: () => number;
}
export interface AgyRequestScope {
    session: AgyRequestSessionContext;
    timestamp: number;
}
export interface AgyRequestLabels {
    last_execution_id?: string;
    last_step_index: string;
    model_enum?: string;
    trajectory_id: string;
    used_claude: 'true' | 'false';
    used_claude_conservative: 'true' | 'false';
    used_non_gemini_model: 'true' | 'false';
}
export interface AgyAgentRequestMetadata {
    requestId: string;
    sessionId: string;
    labels: AgyRequestLabels;
    lastStepIndex: number;
}
export interface AgyAgentRequestMetadataOptions {
    stepCountMode?: 'parts' | 'contents' | 'cli';
}
export declare function fnv1a64Signed(input: string): string;
export declare function createAgyRequestSessionContext(workspaceUri: string, ids?: {
    conversationId?: string;
    trajectoryId?: string;
}): AgyRequestSessionContext;
export declare class AgyRequestSessionStore {
    private readonly entries;
    private readonly workspaceUri;
    private readonly ttlMs;
    private readonly maxEntries;
    private readonly now;
    constructor(workspaceUri: string, options?: AgyRequestSessionStoreOptions);
    getOrCreate(key: string): AgyRequestSessionContext;
    beginRequest(key: string): AgyRequestScope;
    completeExecution(key: string): void;
    has(key: string): boolean;
    delete(key: string): void;
    clear(): void;
    get size(): number;
    private prune;
}
export declare function getAgyModelEnum(model: string): string | undefined;
export declare function orderAgyRequestPayloadInPlace(payload: Record<string, unknown>): void;
export declare function countAgyRequestSteps(payload: Record<string, unknown>, mode?: 'parts' | 'contents' | 'cli'): number;
export declare function buildAgyAgentRequestMetadata(session: AgyRequestSessionContext, payload: Record<string, unknown>, model: string, timestamp?: number, options?: AgyAgentRequestMetadataOptions): AgyAgentRequestMetadata;
//# sourceMappingURL=agy-request-metadata.d.ts.map