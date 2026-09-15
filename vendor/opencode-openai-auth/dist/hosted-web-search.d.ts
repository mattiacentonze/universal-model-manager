import { type ToolDefinition } from '@opencode-ai/plugin';
export declare const HostedWebSearchTool: ToolDefinition;
export declare function translateHostedWebSearchEvent(event: Record<string, unknown>): Record<string, unknown> | undefined;
export declare function translateHostedWebSearchResponse(response: Response): Response;
export declare function rewriteHostedWebSearchReplay(body: Record<string, unknown>): boolean;
