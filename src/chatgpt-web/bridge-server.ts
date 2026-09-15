import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { CHATGPT_WEB_MODELS } from "./models.js";
import { ChatGptRunner } from "./chatgpt-runner.js";
import { SessionStore } from "./session-store.js";
import { usageTracker } from "./usage-tracker.js";
import { logger } from "../shared/logger.js";

export interface BridgeServerOptions {
  port?: number;
  host?: string;
  runner?: ChatGptRunner;
  sessionStore?: SessionStore;
}

function parseJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function extractPromptFromMessages(messages: Array<{ role?: string; content?: any }>): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  return messages
    .map(m => {
      const role = m.role || "user";
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");
}

function extractPromptFromResponsesInput(input: any): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input
      .map(item => {
        if (typeof item === "string") return item;
        if (item && item.content) {
          return typeof item.content === "string" ? item.content : JSON.stringify(item.content);
        }
        return JSON.stringify(item);
      })
      .join("\n\n");
  }
  return JSON.stringify(input || "");
}

export class BridgeServer {
  private server: Server | null = null;
  readonly host: string;
  readonly port: number;
  private readonly runner: ChatGptRunner;
  private readonly sessionStore: SessionStore;

  constructor(options: BridgeServerOptions = {}) {
    this.host = options.host || "127.0.0.1";
    this.port = options.port || 17842;
    this.sessionStore = options.sessionStore || new SessionStore();
    this.runner = options.runner || new ChatGptRunner(undefined as any);
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = createServer(async (req, res) => {
      // Security: verify request originates from loopback
      const remote = req.socket.remoteAddress;
      if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Forbidden: Bridge accepts local connections only");
        return;
      }

      const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
      const method = req.method?.toUpperCase() || "GET";

      try {
        if (method === "GET" && url.pathname === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              host: this.host,
              port: this.port,
              hasValidSession: this.sessionStore.hasValidSession(),
            })
          );
          return;
        }

        if (method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
          const modelsList = Object.values(CHATGPT_WEB_MODELS).map(m => ({
            id: m.id,
            object: "model",
            created: 1700000000,
            owned_by: "chatgpt-web",
          }));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: modelsList }));
          return;
        }

        if (method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
          const body = await parseJsonBody(req);
          const prompt = extractPromptFromMessages(body.messages);
          const stream = body.stream === true;
          const id = `chatcmpl-${randomUUID()}`;
          const created = Math.floor(Date.now() / 1000);
          const model = body.model || "chatgpt-web/auto";

          if (stream) {
            res.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });

            await this.runner.runPrompt(prompt, {
              modelId: model,
              onDelta: delta => {
                const chunk = {
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              },
            });

            const endChunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            };
            usageTracker.recordTurn();
            res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            const answer = await this.runner.runPrompt(prompt, { modelId: model });
            usageTracker.recordTurn();
            const responseData = {
              id,
              object: "chat.completion",
              created,
              model,
              choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
            };
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(responseData));
          }
          return;
        }

        if (method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
          const body = await parseJsonBody(req);
          const prompt = extractPromptFromResponsesInput(body.input);
          const stream = body.stream === true;
          const id = `resp_${randomUUID().replace(/-/g, "")}`;
          const model = body.model || "chatgpt-web/auto";

          if (stream) {
            res.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });

            res.write(
              `data: ${JSON.stringify({
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", id },
              })}\n\n`
            );

            await this.runner.runPrompt(prompt, {
              modelId: model,
              onDelta: delta => {
                const chunk = {
                  type: "response.output_text.delta",
                  item_id: id,
                  delta,
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              },
            });

            const doneChunk = {
              type: "response.completed",
              response: {
                id,
                status: "completed",
                model,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            };
            usageTracker.recordTurn();
            res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            const answer = await this.runner.runPrompt(prompt, { modelId: model });
            usageTracker.recordTurn();
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                id,
                object: "response",
                status: "completed",
                model,
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: answer }],
                  },
                ],
              })
            );
          }
          return;
        }

        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not Found");
      } catch (err: any) {
        logger.error("Bridge server error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: err?.message || "Internal Bridge Error" } }));
        }
      }
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, this.host, () => {
        logger.info(`Bridge server running on http://${this.host}:${this.port}`);
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve, reject) => {
      this.server!.close(err => {
        this.server = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
