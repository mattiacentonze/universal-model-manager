export declare const GEMINI_DUMP_COMMAND_NAME = "gemini-dump";
export type GeminiDumpCommandAction = {
    type: 'status';
} | {
    type: 'enable';
} | {
    type: 'disable';
} | {
    type: 'usage';
};
export interface GeminiDumpContext {
    id: string;
    files: {
        request: string;
        response: string;
        metadata: string;
    };
    metadata: Record<string, unknown>;
}
export declare function isGeminiDumpEnabled(): boolean;
export declare function setGeminiDumpEnabled(enabled: boolean): void;
export declare function resetGeminiDumpState(): void;
export declare function getGeminiDumpDirectory(): string;
export declare function parseGeminiDumpCommandAction(argumentsText: string): GeminiDumpCommandAction;
export declare function buildGeminiDumpStatusSummary(input?: {
    enabled?: boolean;
}): string;
export declare function executeGeminiDumpCommand(input: {
    argumentsText: string;
    enabled?: boolean;
}): string;
export declare function dumpGeminiRequest(input: {
    originalUrl: string;
    resolvedUrl: string;
    method?: string;
    headers?: HeadersInit | Headers;
    body?: BodyInit | null;
    streaming: boolean;
    requestedModel?: string;
    effectiveModel?: string;
    sessionId?: string;
    projectId?: string;
}): GeminiDumpContext | null;
export declare function noteGeminiDumpResponse(context: GeminiDumpContext | null | undefined, response: Pick<Response, 'status' | 'statusText' | 'headers'>): void;
export declare function appendGeminiDumpResponseText(context: GeminiDumpContext | null | undefined, text: string): void;
export declare function createGeminiDumpResponseTransform(context: GeminiDumpContext | null | undefined): TransformStream<Uint8Array, Uint8Array> | null;
//# sourceMappingURL=gemini-dump.d.ts.map