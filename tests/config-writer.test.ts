import { describe, expect, it } from "vitest";
import { applyUniversalConfigUpdates } from "../src/shared/config-writer.js";
import { parse } from "jsonc-parser";

describe("applyUniversalConfigUpdates", () => {
  it("adds chatgpt-web provider and plugin to clean config", () => {
    const original = `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`;
    const updated = applyUniversalConfigUpdates(original, { bridgePort: 17845 });
    const parsed = parse(updated);

    expect(parsed.provider["chatgpt-web"]).toBeDefined();
    expect(parsed.provider["chatgpt-web"].options.baseURL).toBe("http://127.0.0.1:17845/v1");
    expect(parsed.provider["chatgpt-web"].models["chatgpt-web/auto"]).toBeDefined();
    expect(parsed.plugin).toContain("opencode-universal-auth");
  });

  it("preserves existing comments and other providers in JSONC", () => {
    const original = `{
  // Existing iit provider
  "provider": {
    "iit": {
      "name": "IIT"
    }
  },
  "plugin": ["@cortexkit/opencode-openai-auth"]
}`;
    const updated = applyUniversalConfigUpdates(original);
    expect(updated).toContain("// Existing iit provider");

    const parsed = parse(updated);
    expect(parsed.provider.iit.name).toBe("IIT");
    expect(parsed.provider["chatgpt-web"]).toBeDefined();
    expect(parsed.plugin).toContain("@cortexkit/opencode-openai-auth");
    expect(parsed.plugin).toContain("opencode-universal-auth");
  });

  it("is strictly idempotent", () => {
    const original = `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`;
    const first = applyUniversalConfigUpdates(original);
    const second = applyUniversalConfigUpdates(first);
    expect(second).toBe(first);
  });
});
