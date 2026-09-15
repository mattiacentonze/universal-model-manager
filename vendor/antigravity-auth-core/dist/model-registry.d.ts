import type { ProviderModel } from './model-types.ts';
import type { ThinkingTier } from './transform/types.ts';
export type ModelThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export interface ModelThinkingConfig {
    thinkingBudget: number;
}
export interface ModelVariant {
    thinkingLevel?: ModelThinkingLevel;
    thinkingConfig?: ModelThinkingConfig;
    disabled?: boolean;
}
export interface ModelLimit {
    context: number;
    output: number;
}
export type ModelModality = 'text' | 'image' | 'pdf';
export type ModelQuotaGroup = 'gemini' | 'non-gemini';
export interface ModelModalities {
    input: ModelModality[];
    output: ModelModality[];
}
export interface OpencodeModelDefinition extends ProviderModel {
    id: string;
    name: string;
    release_date: string;
    attachment: boolean;
    reasoning: boolean;
    temperature: boolean;
    tool_call: boolean;
    limit: ModelLimit;
    modalities: ModelModalities;
    cost: {
        input: number;
        output: number;
    };
    options: Record<string, unknown>;
    variants?: Record<string, ModelVariant>;
}
export type OpencodeModelDefinitions = Record<string, OpencodeModelDefinition>;
export declare const OPENCODE_MODEL_DEFINITIONS: OpencodeModelDefinitions;
export declare function getPublicModelDefinitions(): OpencodeModelDefinitions;
export declare function getAntigravityOpencodeModelIds(): string[];
export declare function getResolverAliasMap(): Record<string, string>;
export declare function getGemini35FlashAntigravityModel(tier?: ThinkingTier): string;
export declare function getGemini35FlashGeminiCliFallbackModel(): string;
export declare function getGemini36FlashAntigravityModel(tier?: ThinkingTier): string;
export declare function getGemini37FlashAntigravityModel(tier?: ThinkingTier): string;
export declare function getGemini38FlashAntigravityModel(tier?: ThinkingTier): string;
export declare function getQuotaGroupForModel(modelId: string): ModelQuotaGroup | undefined;
//# sourceMappingURL=model-registry.d.ts.map