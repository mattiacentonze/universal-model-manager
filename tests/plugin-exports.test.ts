import { describe, expect, it } from "vitest";
import rootPlugin, {
  openaiServerPlugin,
  antigravityServerPlugin,
  chatgptWebServerPlugin,
  fallbackPlugin,
} from "../src/index.js";
import openaiModule from "../src/openai/index.js";
import antigravityModule from "../src/antigravity/index.js";
import fallbackModule from "../src/fallback/index.js";
import chatgptWebModule from "../src/chatgpt-web/index.js";

describe("Plugin Module Exports", () => {
  it("exports valid root plugin definition", () => {
    expect(rootPlugin.id).toBe("opencode-universal-auth");
    expect(typeof rootPlugin.server).toBe("function");
    expect(typeof openaiServerPlugin).toBe("function");
    expect(typeof antigravityServerPlugin).toBe("function");
    expect(typeof chatgptWebServerPlugin).toBe("function");
    expect(typeof fallbackPlugin).toBe("function");
  });

  it("exports valid openai submodule", () => {
    expect(openaiModule.id).toBe("universal-openai-auth");
    expect(typeof openaiModule.server).toBe("function");
  });

  it("exports valid antigravity submodule", () => {
    expect(antigravityModule.id).toBe("universal-antigravity-auth");
    expect(typeof antigravityModule.server).toBe("function");
  });

  it("exports valid fallback submodule", () => {
    expect(fallbackModule.id).toBe("universal-runtime-fallback");
    expect(typeof fallbackModule.server).toBe("function");
  });

  it("exports valid chatgpt-web submodule", () => {
    expect(chatgptWebModule.id).toBe("universal-chatgpt-web");
    expect(typeof chatgptWebModule.server).toBe("function");
  });
});
