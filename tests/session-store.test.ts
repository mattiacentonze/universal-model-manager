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
});
