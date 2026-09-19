import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeServer } from "../src/chatgpt-web/bridge-server.js";
import type { ChatGptRunner } from "../src/chatgpt-web/chatgpt-runner.js";

class MockRunner implements Partial<ChatGptRunner> {
  async runPrompt(_prompt: string, options: any = {}): Promise<string> {
    if (options.onDelta) {
      options.onDelta("Hello ");
      options.onDelta("from ");
      options.onDelta("ChatGPT Web!");
    }
    return "Hello from ChatGPT Web!";
  }
}

describe("BridgeServer", () => {
  const port = 18991;
  let server: BridgeServer;

  beforeAll(async () => {
    server = new BridgeServer({
      port,
      runner: new MockRunner() as any,
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("responds to /health check", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.port).toBe(port);
  });

  it("serves OpenAI /v1/models list", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    const modelIds = body.data.map((m: any) => m.id);
    expect(modelIds).toContain("chatgpt-web/auto");
    expect(modelIds).toContain("chatgpt-web/pro");
  });

  it("handles non-streaming /v1/chat/completions", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/auto",
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("Hello from ChatGPT Web!");
  });

  it("handles streaming /v1/chat/completions SSE", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/auto",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("data: ");
    expect(text).toContain("ChatGPT Web!");
    expect(text).toContain("data: [DONE]");
  });

  it("handles non-streaming /v1/responses", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/auto",
        input: "Tell me a joke",
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(body.output[0].content[0].text).toBe("Hello from ChatGPT Web!");
  });

  it("handles streaming /v1/responses SSE", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/auto",
        input: "Tell me a joke",
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("response.completed");
    expect(text).toContain("data: [DONE]");
  });
});
