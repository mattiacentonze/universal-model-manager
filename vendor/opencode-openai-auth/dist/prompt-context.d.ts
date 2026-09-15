/**
 * Resolve prompt context for synthetic OpenCode user messages.
 *
 * OpenCode records even ignored/noReply prompt messages as user messages. If a
 * plugin sends one (e.g. a hidden /openai-* command reply) without the previous
 * model/variant, OpenCode's next real prompt can inherit the synthetic message's
 * default model/variant and silently change the model, usage, or cache
 * attribution. Resolve the most recent assistant context and pass it through on
 * hidden command replies so the user's selected model and reasoning variant are kept.
 */
export interface ResolvedPromptContext {
    agent?: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    variant?: string;
}
export declare function resolvePromptContext(client: unknown, sessionId: string): Promise<ResolvedPromptContext | null>;
