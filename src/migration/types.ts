export interface DiscoveredLegacyItem {
  id: "cortexkit-openai" | "cortexkit-antigravity" | "runtime-fallback" | "codex-chatgpt-web";
  name: string;
  description: string;
  foundInConfig: boolean;
  foundFiles: string[];
  secretsDetected: string[];
  details: Record<string, unknown>;
}

export interface DiscoveryReport {
  timestamp: string;
  items: DiscoveredLegacyItem[];
  hasConflictsWithUniversalManager: boolean;
  conflictSummary: string[];
}

export interface MigrationPlan {
  importOpenAi: boolean;
  importAntigravity: boolean;
  importFallback: boolean;
  importChatGptWeb: boolean;
  replaceInOpenCodeConfig: boolean;
  replaceInTuiConfig: boolean;
  uninstallLegacyNpmPackages: boolean;
}

export interface MigrationResult {
  success: boolean;
  importedItems: string[];
  configModified: boolean;
  tuiModified: boolean;
  uninstalledPackages: string[];
  errors: string[];
}
