import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { SessionStore } from "../src/chatgpt-web/session-store.js";

describe("SessionStore", () => {
  it("detects valid chatgpt session cookies", () => {
    const testFile = join(tmpdir(), `test-session-${Date.now()}.json`);
    const store = new SessionStore(testFile);

    expect(store.hasValidSession()).toBe(false);

    store.save({
      cookies: [
        {
          name: "__Secure-next-auth.session-token",
          value: "test-token-value",
          domain: "chatgpt.com",
          path: "/",
          expires: Math.floor(Date.now() / 1000) + 3600,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [],
    });

    expect(store.hasValidSession()).toBe(true);

    const loaded = store.load();
    expect(loaded?.cookies[0]?.name).toBe("__Secure-next-auth.session-token");

    rmSync(testFile, { force: true });
  });

  it("rejects device-only cookies as not logged in", () => {
    const testFile = join(tmpdir(), `test-session-${Date.now()}.json`);
    const store = new SessionStore(testFile);

    store.save({
      cookies: [
        { name: "oai-did", value: "x", domain: ".chatgpt.com", path: "/", expires: 9999999999, httpOnly: false, secure: true, sameSite: "Lax" },
        { name: "__cf_bm", value: "x", domain: ".chatgpt.com", path: "/", expires: 9999999999, httpOnly: true, secure: true, sameSite: "None" },
        { name: "_cfuvid", value: "x", domain: ".chatgpt.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "None" },
        { name: "oai-mweb-route-desktop", value: "1", domain: ".chatgpt.com", path: "/", expires: 9999999999, httpOnly: true, secure: true, sameSite: "Lax" },
        { name: "oai-mweb-origin", value: "1", domain: ".chatgpt.com", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" },
      ],
      origins: [],
    });

    expect(store.hasValidSession()).toBe(false);

    rmSync(testFile, { force: true });
  });

  it("detects modern oai-sc session cookie or user localStorage", () => {
    const testFile = join(tmpdir(), `test-session-${Date.now()}.json`);
    const store = new SessionStore(testFile);

    // Test with oai-sc cookie
    store.save({
      cookies: [
        { name: "oai-sc", value: "session-token", domain: ".chatgpt.com", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: false, secure: true, sameSite: "None" },
      ],
      origins: [],
    });
    expect(store.hasValidSession()).toBe(true);

    // Test with user-storage
    store.save({
      cookies: [],
      origins: [
        {
          origin: "https://chatgpt.com",
          localStorage: [{ name: "cache/user-12345/models", value: "{}" }],
        },
      ],
    });
    expect(store.hasValidSession()).toBe(true);

    rmSync(testFile, { force: true });
  });
});
