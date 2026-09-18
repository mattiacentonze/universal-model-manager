import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

const mockDiscover = vi.fn();
const mockGetRpcDir = vi.fn();

vi.mock("../vendor/opencode-antigravity-auth/dist/src/rpc/rpc-dir.js", () => ({
  getRpcDir: (...args: any[]) => mockGetRpcDir("antigravity", ...args),
}));
vi.mock("../vendor/opencode-antigravity-auth/dist/src/rpc/port-file.js", () => ({
  discoverPortFile: (...args: any[]) => mockDiscover("antigravity", ...args),
}));
vi.mock("../vendor/opencode-openai-auth/dist/rpc/rpc-dir.js", () => ({
  getRpcDir: (...args: any[]) => mockGetRpcDir("openai", ...args),
}));
vi.mock("../vendor/opencode-openai-auth/dist/rpc/port-file.js", () => ({
  discoverPortFile: (...args: any[]) => mockDiscover("openai", ...args),
}));

import {
  resolveRpcDir,
  findPortFile,
  refreshProviderQuota,
  refreshAllQuotas,
  createQuotaPoller,
} from "../src/manager/quota-poller.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
  mockGetRpcDir.mockReset();
  mockDiscover.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("quota-poller", () => {
  it("resolves an RPC dir for each provider", () => {
    mockGetRpcDir.mockReturnValue("/rpc/antigravity");
    expect(resolveRpcDir("antigravity", "/proj")).toBe("/rpc/antigravity");
    expect(mockGetRpcDir).toHaveBeenCalledWith("antigravity", "/proj");
  });

  it("finds a live port file in an RPC dir", async () => {
    mockGetRpcDir.mockReturnValue("/rpc/antigravity");
    mockDiscover.mockResolvedValue({ port: 12345, token: "secret", pid: 1, startedAt: 1 });
    const entry = await findPortFile("antigravity", "/proj");
    expect(entry).toEqual({ port: 12345, token: "secret", pid: 1, startedAt: 1 });
    expect(mockGetRpcDir).toHaveBeenCalledWith("antigravity", "/proj");
    expect(mockDiscover).toHaveBeenCalledWith("antigravity", "/rpc/antigravity");
  });

  it("returns null when no port file exists", async () => {
    mockGetRpcDir.mockReturnValue("/rpc/openai");
    mockDiscover.mockResolvedValue(null);
    expect(await findPortFile("openai", "/proj")).toBeNull();
  });

  it("refreshes a provider quota via RPC apply", async () => {
    mockGetRpcDir.mockReturnValue("/rpc/antigravity");
    mockDiscover.mockResolvedValue({ port: 12345, token: "secret", pid: 1, startedAt: 1 });
    const fetchMock = vi.fn(async (_url: string, _init: any) => ({ ok: true }));
    globalThis.fetch = fetchMock as any;

    const ok = await refreshProviderQuota("antigravity", "/proj");
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe("http://127.0.0.1:12345/rpc/apply");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body).command).toBe("google-quota");
    expect(JSON.parse(init.body).arguments).toBe("refresh");
  });

  it("returns false when refresh fails", async () => {
    mockGetRpcDir.mockReturnValue("/rpc/openai");
    mockDiscover.mockResolvedValue({ port: 12345, token: "secret", pid: 1, startedAt: 1 });
    globalThis.fetch = (async () => ({ ok: false })) as any;
    expect(await refreshProviderQuota("openai", "/proj")).toBe(false);
  });

  it("returns false when no port file is present", async () => {
    mockGetRpcDir.mockReturnValue("/rpc/openai");
    mockDiscover.mockResolvedValue(null);
    expect(await refreshProviderQuota("openai", "/proj")).toBe(false);
  });

  it("debounces automatic refreshes unless forced", async () => {
    mockGetRpcDir.mockReturnValue("/rpc/x");
    mockDiscover.mockResolvedValue(null);
    const first = await refreshAllQuotas("/proj");
    expect(first).toEqual({ antigravity: false, openai: false });
    const second = await refreshAllQuotas("/proj");
    expect(second).toEqual({ antigravity: false, openai: false });
    const forced = await refreshAllQuotas("/proj", { force: true });
    expect(forced).toEqual({ antigravity: false, openai: false });
  });

  it("routes task start/complete events to a debounced refresh", async () => {
    const poller = createQuotaPoller();
    const refreshSpy = vi
      .spyOn(poller, "refreshAll")
      .mockResolvedValue({ antigravity: false, openai: false });

    await poller.eventHandler({ event: { type: "session.created" } });
    await poller.eventHandler({
      event: { type: "session.status", properties: { status: { type: "busy" } } },
    });
    await poller.eventHandler({ event: { type: "session.idle" } });
    await poller.eventHandler({
      event: { type: "session.status", properties: { status: { type: "idle" } } },
    });
    await poller.eventHandler({ event: { type: "unrelated" } });

    // The 2s initial refresh fires first; the debounced refresh has not yet.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    // The 4 matching events coalesce into a single debounced refresh.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refreshSpy).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it("dispose clears timers and stops further refreshes", async () => {
    const poller = createQuotaPoller();
    const refreshSpy = vi
      .spyOn(poller, "refreshAll")
      .mockResolvedValue({ antigravity: false, openai: false });
    poller.dispose();
    await poller.eventHandler({ event: { type: "session.created" } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
