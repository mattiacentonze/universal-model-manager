/**
 * Constants used for Antigravity OAuth flows and Cloud Code Assist API integration.
 */
export declare const ANTIGRAVITY_CLIENT_ID: string;
/**
 * Client secret issued for the Antigravity OAuth application.
 */
export declare const ANTIGRAVITY_CLIENT_SECRET: string;
/**
 * Scopes required for Antigravity integrations.
 */
export declare const ANTIGRAVITY_SCOPES: readonly string[];
/**
 * OAuth redirect URI used by the local CLI callback server.
 */
export declare const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
/**
 * Root endpoints for the Antigravity API (in fallback order).
 * Live agy CLI 1.1.24 traffic uses daily-cloudcode-pa.googleapis.com.
 */
export declare const ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.googleapis.com";
export declare const ANTIGRAVITY_ENDPOINT_AUTOPUSH = "https://autopush-cloudcode-pa.sandbox.googleapis.com";
export declare const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
/**
 * Endpoint fallback order (daily → prod).
 * Autopush removed to reduce unnecessary fallback API calls — it rarely works when daily fails.
 * Shared across request handling and project discovery to mirror CLIProxy behavior.
 */
export declare const ANTIGRAVITY_ENDPOINT_FALLBACKS: readonly ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"];
/**
 * Preferred endpoint order for project discovery.
 * agy CLI probes daily-cloudcode-pa.googleapis.com first.
 */
export declare const ANTIGRAVITY_LOAD_ENDPOINTS: readonly ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"];
/**
 * Primary endpoint to use (captured agy CLI daily endpoint).
 */
export declare const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
/**
 * Gemini CLI endpoint (production).
 * Used for models without :antigravity suffix.
 * Same as opencode-gemini-auth's GEMINI_CODE_ASSIST_ENDPOINT.
 */
export declare const GEMINI_CLI_ENDPOINT = "https://cloudcode-pa.googleapis.com";
/**
 * Hardcoded project id used when Antigravity does not return one (e.g., business/workspace accounts).
 */
export declare const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";
export declare const ANTIGRAVITY_VERSION_FALLBACK = "1.18.3";
export declare function getAntigravityVersion(): string;
/**
 * Set the runtime Antigravity version. Can only be called once (at startup).
 * Subsequent calls are silently ignored to prevent accidental mutation.
 */
export declare function setAntigravityVersion(version: string): void;
/**
 * Test-only: reset the version lock so `setAntigravityVersion` can run again.
 * Bun has no Vitest-style module reset hook, and module state lives in this
 * singleton — tests that exercise the lock need a way to start clean per
 * scenario.
 */
export declare function __resetAntigravityVersionForTesting(): void;
/** @deprecated Use getAntigravityVersion() for runtime access. */
export declare const ANTIGRAVITY_VERSION = "1.18.3";
export declare function getAntigravityHeaders(): HeaderSet & {
    'Client-Metadata': string;
};
/** @deprecated Use getAntigravityHeaders() for runtime access. */
export declare const ANTIGRAVITY_HEADERS: {
    readonly 'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.18.3 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36";
    readonly 'X-Goog-Api-Client': "google-cloud-sdk vscode_cloudshelleditor/0.1";
    readonly 'Client-Metadata': "{\"ideType\":\"ANTIGRAVITY\",\"platform\":\"WINDOWS\",\"pluginType\":\"GEMINI\"}" | "{\"ideType\":\"ANTIGRAVITY\",\"platform\":\"MACOS\",\"pluginType\":\"GEMINI\"}";
};
export declare const GEMINI_CLI_VERSION = "1.0.0";
/**
 * Default model used in Gemini CLI User-Agent when no model is specified.
 */
export declare const GEMINI_CLI_DEFAULT_MODEL = "gemini-2.5-pro";
/**
 * Build Gemini CLI User-Agent string matching the official google-gemini/gemini-cli format.
 * Format: `GeminiCLI/{version}/{model} ({platform}; {arch})`
 *
 * @see https://github.com/google-gemini/gemini-cli
 */
export declare function buildGeminiCliUserAgent(model?: string): string;
/** @deprecated Use buildGeminiCliUserAgent() for runtime access. */
export declare const GEMINI_CLI_HEADERS: {
    readonly 'User-Agent': "google-api-nodejs-client/9.15.1";
    readonly 'X-Goog-Api-Client': "gl-node/22.17.0";
    readonly 'Client-Metadata': "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI";
};
export type HeaderSet = {
    'User-Agent': string;
    'X-Goog-Api-Client'?: string;
    'Client-Metadata'?: string;
};
export declare function getRandomizedHeaders(style: HeaderStyle, model?: string): HeaderSet;
export type HeaderStyle = 'antigravity' | 'gemini-cli';
/**
 * Provider identifier shared between the plugin loader and credential store.
 */
export declare const ANTIGRAVITY_PROVIDER_ID = "google";
/**
 * System instruction for Claude tool usage hardening.
 * Prevents hallucinated parameters by explicitly stating the rules.
 *
 * This is injected when tools are present to reduce cases where Claude
 * uses parameter names from its training data instead of the actual schema.
 */
export declare const CLAUDE_TOOL_SYSTEM_INSTRUCTION = "CRITICAL TOOL USAGE INSTRUCTIONS:\nYou are operating in a custom environment where tool definitions differ from your training data.\nYou MUST follow these rules strictly:\n\n1. DO NOT use your internal training data to guess tool parameters\n2. ONLY use the exact parameter structure defined in the tool schema\n3. Parameter names in schemas are EXACT - do not substitute with similar names from your training\n4. Array parameters have specific item types - check the schema's 'items' field for the exact structure\n5. When you see \"STRICT PARAMETERS\" in a tool description, those type definitions override any assumptions\n6. Tool use in agentic workflows is REQUIRED - you must call tools with the exact parameters specified\n\nIf you are unsure about a tool's parameters, YOU MUST read the schema definition carefully.";
/**
 * Template for parameter signature injection into tool descriptions.
 * {params} will be replaced with the actual parameter list.
 */
export declare const CLAUDE_DESCRIPTION_PROMPT = "\n\n\u26A0\uFE0F STRICT PARAMETERS: {params}.";
export declare const EMPTY_SCHEMA_PLACEHOLDER_NAME = "_placeholder";
export declare const EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION = "Placeholder. Always pass true.";
/**
 * Sentinel value to bypass thought signature validation.
 *
 * When a thinking block has an invalid or missing signature (e.g., cache miss,
 * session mismatch, plugin restart), this sentinel can be injected to skip
 * validation instead of failing with "Invalid signature in thinking block".
 *
 * This is an officially supported Google API feature, used by:
 * - gemini-cli: https://github.com/google-gemini/gemini-cli
 * - Google .NET SDK: PredictionServiceChatClient.cs
 *
 * @see https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export declare const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
/**
 * Model used for Google Search grounding requests.
 * Uses gemini-2.5-flash for fast, cost-effective search operations. (3-flash is always at capacity and doesn't support souce citation).
 */
export declare const SEARCH_MODEL = "gemini-2.5-flash";
/**
 * Thinking budget for deep search (more thorough analysis).
 */
export declare const SEARCH_THINKING_BUDGET_DEEP = 16384;
/**
 * Thinking budget for fast search (quick results).
 */
export declare const SEARCH_THINKING_BUDGET_FAST = 4096;
/**
 * Timeout for search requests in milliseconds (60 seconds).
 */
export declare const SEARCH_TIMEOUT_MS = 60000;
/**
 * System instruction for the Google Search tool.
 */
export declare const SEARCH_SYSTEM_INSTRUCTION = "You are an expert web search assistant with access to Google Search and URL analysis tools.\n\nYour capabilities:\n- Use google_search to find real-time information from the web\n- Use url_context to fetch and analyze content from specific URLs when provided\n\nGuidelines:\n- Always provide accurate, well-sourced information\n- Cite your sources when presenting facts\n- If analyzing URLs, extract the most relevant information\n- Be concise but comprehensive in your responses\n- If information is uncertain or conflicting, acknowledge it\n- Focus on answering the user's question directly";
//# sourceMappingURL=constants.d.ts.map