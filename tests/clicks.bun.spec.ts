import { describe, it, expect } from "bun:test";
import "./../node_modules/@opentui/solid/scripts/runtime-plugin-support.js";
import { testRender } from "@opentui/solid";

describe("Sidebar Button Clicking (MODEL MANAGER, OPENAI, GOOGLE)", () => {
  it("allows clicking MODEL MANAGER, OPENAI, and GOOGLE buttons and updates UI in real time", async () => {
    const { ModelManagerSidebar, managerCollapsed, openaiCollapsed, antigravityCollapsed } = await import(
      "../src/tui-compiled/sidebar-widget.tsx"
    );

    const api = { theme: { current: {} } };
    const setup = await testRender(() => ModelManagerSidebar({ api }));
    await setup.renderOnce();

    // 1. Initial State: Model manager expanded
    let frame = setup.captureCharFrame().split("\n");
    expect(frame[0]).toContain("MODEL MANAGER");

    // 2. Click MODEL MANAGER badge at (2, 0) to toggle collapsed
    const initManager = managerCollapsed();
    await setup.mockMouse.click(2, 0);
    await setup.renderOnce();

    expect(managerCollapsed()).toBe(!initManager);
    frame = setup.captureCharFrame().split("\n");
    if (managerCollapsed()) {
      expect(frame[0]).toContain("\u25b6 MODEL MANAGER");
    } else {
      expect(frame[0]).toContain("\u25bc MODEL MANAGER");
    }

    // Expand manager back if collapsed so we can test OPENAI & GOOGLE
    if (managerCollapsed()) {
      await setup.mockMouse.click(2, 0);
      await setup.renderOnce();
      expect(managerCollapsed()).toBe(false);
      frame = setup.captureCharFrame().split("\n");
    }

    // 3. Click OPENAI header to toggle collapsed
    const openaiLine = frame.findIndex(l => l.includes("OPENAI"));
    expect(openaiLine).toBeGreaterThanOrEqual(0);

    const initOpenai = openaiCollapsed();
    await setup.mockMouse.click(4, openaiLine);
    await setup.renderOnce();

    expect(openaiCollapsed()).toBe(!initOpenai);
    frame = setup.captureCharFrame().split("\n");
    if (openaiCollapsed()) {
      expect(frame[openaiLine]).toContain("\u25b6 OPENAI");
    } else {
      expect(frame[openaiLine]).toContain("\u25bc OPENAI");
    }

    // 4. Click GOOGLE header to toggle collapsed
    const googleLine = frame.findIndex(l => l.includes("GOOGLE"));
    expect(googleLine).toBeGreaterThanOrEqual(0);

    const initGoogle = antigravityCollapsed();
    await setup.mockMouse.click(4, googleLine);
    await setup.renderOnce();

    expect(antigravityCollapsed()).toBe(!initGoogle);
    frame = setup.captureCharFrame().split("\n");
    const newGoogleLine = frame.findIndex(l => l.includes("GOOGLE"));
    expect(newGoogleLine).toBeGreaterThanOrEqual(0);
    if (antigravityCollapsed()) {
      expect(frame[newGoogleLine]).toContain("\u25b6 GOOGLE");
    } else {
      expect(frame[newGoogleLine]).toContain("\u25bc GOOGLE");
    }
  });
});
