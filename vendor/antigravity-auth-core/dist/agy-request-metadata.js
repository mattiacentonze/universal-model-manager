import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
const FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV1A_64_PRIME = 0x100000001b3n;
const DEFAULT_SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSION_STATES = 256;
const AGY_REQUEST_FIELD_ORDER = [
    'contents',
    'systemInstruction',
    'tools',
    'toolConfig',
    'labels',
    'generationConfig',
    'sessionId',
];
const AGY_MODEL_ENUM_BY_WIRE_MODEL = {
    'gemini-3.5-flash-extra-low': 'MODEL_PLACEHOLDER_M187',
    'gemini-3.5-flash-low': 'MODEL_PLACEHOLDER_M20',
    'gemini-3-flash-agent': 'MODEL_PLACEHOLDER_M84',
    'gemini-3.6-flash-low': 'MODEL_PLACEHOLDER_M73',
    'gemini-3.6-flash-medium': 'MODEL_PLACEHOLDER_M72',
    'gemini-3.6-flash-high': 'MODEL_PLACEHOLDER_M71',
    'gemini-3.7-flash-low': 'MODEL_PLACEHOLDER_M300',
    'gemini-3.7-flash-medium': 'MODEL_PLACEHOLDER_M299',
    'gemini-3.7-flash-high': 'MODEL_PLACEHOLDER_M298',
    'gemini-3.8-flash-low': 'MODEL_PLACEHOLDER_M320',
    'gemini-3.8-flash-medium': 'MODEL_PLACEHOLDER_M319',
    'gemini-3.8-flash-high': 'MODEL_PLACEHOLDER_M318',
    'gemini-3.1-pro-low': 'MODEL_PLACEHOLDER_M36',
    'gemini-pro-agent': 'MODEL_PLACEHOLDER_M16',
    'claude-sonnet-4-6': 'MODEL_PLACEHOLDER_M35',
    'claude-opus-4-6-thinking': 'MODEL_PLACEHOLDER_M26',
    'gemini-3.1-flash-image': 'MODEL_PLACEHOLDER_M21',
    'gpt-oss-120b-medium': 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
};
export function fnv1a64Signed(input) {
    let hash = FNV1A_64_OFFSET_BASIS;
    for (const byte of Buffer.from(input, 'utf8')) {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * FNV1A_64_PRIME);
    }
    return BigInt.asIntN(64, hash).toString();
}
export function createAgyRequestSessionContext(workspaceUri, ids = {}) {
    return {
        conversationId: ids.conversationId ?? randomUUID(),
        trajectoryId: ids.trajectoryId ?? randomUUID(),
        numericSessionId: fnv1a64Signed(workspaceUri),
    };
}
export class AgyRequestSessionStore {
    entries = new Map();
    workspaceUri;
    ttlMs;
    maxEntries;
    now;
    constructor(workspaceUri, options = {}) {
        this.workspaceUri = workspaceUri;
        this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_STATE_TTL_MS;
        this.maxEntries = options.maxEntries ?? DEFAULT_MAX_SESSION_STATES;
        this.now = options.now ?? Date.now;
    }
    getOrCreate(key) {
        const timestamp = this.now();
        this.prune(timestamp, key);
        const existing = this.entries.get(key);
        if (existing) {
            existing.lastAccessedAt = timestamp;
            return existing.context;
        }
        const context = createAgyRequestSessionContext(this.workspaceUri);
        this.entries.set(key, {
            context,
            lastAccessedAt: timestamp,
            lastRequestTimestamp: 0,
        });
        return context;
    }
    beginRequest(key) {
        const session = this.getOrCreate(key);
        const stored = this.entries.get(key);
        const timestamp = Math.max(stored.lastAccessedAt, stored.lastRequestTimestamp + 1);
        stored.lastRequestTimestamp = timestamp;
        return { session, timestamp };
    }
    completeExecution(key) {
        const stored = this.entries.get(key);
        if (stored) {
            stored.context.lastExecutionId = randomUUID();
        }
    }
    has(key) {
        return this.entries.has(key);
    }
    delete(key) {
        this.entries.delete(key);
    }
    clear() {
        this.entries.clear();
    }
    get size() {
        return this.entries.size;
    }
    prune(timestamp, preservedKey) {
        const expiry = timestamp - this.ttlMs;
        for (const [key, value] of this.entries) {
            if (key !== preservedKey && value.lastAccessedAt < expiry) {
                this.entries.delete(key);
            }
        }
        while (this.entries.size >= this.maxEntries &&
            !this.entries.has(preservedKey)) {
            let oldestKey = null;
            let oldestAccess = Number.POSITIVE_INFINITY;
            for (const [key, value] of this.entries) {
                if (key !== preservedKey && value.lastAccessedAt < oldestAccess) {
                    oldestKey = key;
                    oldestAccess = value.lastAccessedAt;
                }
            }
            if (!oldestKey) {
                break;
            }
            this.entries.delete(oldestKey);
        }
    }
}
export function getAgyModelEnum(model) {
    return AGY_MODEL_ENUM_BY_WIRE_MODEL[model.toLowerCase()];
}
export function orderAgyRequestPayloadInPlace(payload) {
    const ordered = {};
    const remaining = new Set(Object.keys(payload));
    for (const key of AGY_REQUEST_FIELD_ORDER) {
        if (key in payload) {
            ordered[key] = payload[key];
            remaining.delete(key);
        }
    }
    for (const key of remaining) {
        ordered[key] = payload[key];
    }
    for (const key of Object.keys(payload)) {
        delete payload[key];
    }
    Object.assign(payload, ordered);
}
export function countAgyRequestSteps(payload, mode = 'parts') {
    const contents = payload.contents;
    if (!Array.isArray(contents))
        return 1;
    if (mode === 'contents')
        return Math.max(1, contents.length);
    let partCount = 0;
    let functionResponseCount = 0;
    for (const content of contents) {
        if (!content || typeof content !== 'object' || Array.isArray(content))
            continue;
        const parts = content.parts;
        if (!Array.isArray(parts))
            continue;
        partCount += parts.length;
        if (mode === 'cli') {
            functionResponseCount += parts.filter((part) => {
                if (!part || typeof part !== 'object' || Array.isArray(part))
                    return false;
                return 'functionResponse' in part;
            }).length;
        }
    }
    if (mode === 'cli') {
        return Math.max(1, contents.length + functionResponseCount);
    }
    return Math.max(1, partCount);
}
export function buildAgyAgentRequestMetadata(session, payload, model, timestamp = Date.now(), options = {}) {
    const lastStepIndex = countAgyRequestSteps(payload, options.stepCountMode) +
        (session.lastExecutionId ? 1 : 0);
    const isClaude = model.toLowerCase().startsWith('claude-');
    const isNonGemini = isClaude || model.toLowerCase().startsWith('gpt-');
    session.usedClaude = session.usedClaude === true || isClaude;
    session.usedNonGeminiModel =
        session.usedNonGeminiModel === true || isNonGemini;
    const modelEnum = getAgyModelEnum(model);
    const labels = {
        ...(session.lastExecutionId
            ? { last_execution_id: session.lastExecutionId }
            : {}),
        last_step_index: String(lastStepIndex),
        ...(modelEnum ? { model_enum: modelEnum } : {}),
        trajectory_id: session.trajectoryId,
        used_claude: session.usedClaude ? 'true' : 'false',
        used_claude_conservative: session.usedClaude ? 'true' : 'false',
        used_non_gemini_model: session.usedNonGeminiModel ? 'true' : 'false',
    };
    return {
        requestId: `agent/${session.conversationId}/${timestamp}/${session.trajectoryId}/${lastStepIndex + 1}`,
        sessionId: session.numericSessionId,
        labels,
        lastStepIndex,
    };
}
//# sourceMappingURL=agy-request-metadata.js.map