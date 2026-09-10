import type { Page } from "playwright-core";
import { BrowserManager } from "./browser-manager.js";
import { CHATGPT_TEMPORARY_CHAT_URL, SELECTORS } from "./selectors.js";
import { logger } from "../shared/logger.js";

export interface RunOptions {
  modelId?: string;
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class ChatGptRunner {
  constructor(private readonly browserManager: BrowserManager) {}

  async runPrompt(prompt: string, options: RunOptions = {}): Promise<string> {
    const context = await this.browserManager.getTurnContext();
    const page = await context.newPage();
    const timeout = options.timeoutMs ?? 180_000;

    try {
      logger.debug(`Navigating to Temporary Chat...`);
      await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });

      // 1. Wait for the composer
      const composer = page.locator(SELECTORS.composer).first();
      await composer.waitFor({ state: "visible", timeout: 30_000 });

      // 2. Insert prompt into composer
      await composer.fill(prompt);
      await page.waitForTimeout(200);

      // 3. Send prompt
      const sendButton = page.locator(SELECTORS.sendButton).first();
      if (await sendButton.isVisible().catch(() => false)) {
        await sendButton.click();
      } else {
        await composer.press("Enter");
      }

      logger.debug(`Prompt submitted. Waiting for assistant generation...`);

      // 4. Stream response
      let fullText = "";
      let lastReportedLen = 0;
      const startTime = Date.now();

      // Wait until stop button appears or assistant turn element is rendered
      await page.waitForSelector(SELECTORS.assistantTurn, { timeout: 45_000 });

      while (Date.now() - startTime < timeout) {
        if (options.signal?.aborted) {
          logger.info("Aborting turn requested by caller");
          const stopBtn = page.locator(SELECTORS.stopButton).first();
          if (await stopBtn.isVisible().catch(() => false)) {
            await stopBtn.click().catch(() => {});
          }
          break;
        }

        const assistantTurn = page.locator(SELECTORS.assistantTurn).last();
        const currentContent = (await assistantTurn.innerText().catch(() => "")) || "";

        if (currentContent.length > lastReportedLen) {
          const delta = currentContent.slice(lastReportedLen);
          lastReportedLen = currentContent.length;
          fullText = currentContent;
          if (options.onDelta) {
            options.onDelta(delta);
          }
        }

        // Check if generation completed
        const isGenerating = await page.locator(SELECTORS.stopButton).first().isVisible().catch(() => false);
        const hasCopyAction = await page.locator(SELECTORS.copyButton).last().isVisible().catch(() => false);

        if (!isGenerating && hasCopyAction && currentContent.length > 0) {
          // Extra short wait to catch any final DOM flush
          await page.waitForTimeout(300);
          const finalContent = (await assistantTurn.innerText().catch(() => "")) || currentContent;
          if (finalContent.length > lastReportedLen) {
            const finalDelta = finalContent.slice(lastReportedLen);
            if (options.onDelta) options.onDelta(finalDelta);
            fullText = finalContent;
          }
          logger.debug(`Generation completed successfully (${fullText.length} chars)`);
          return fullText;
        }

        await page.waitForTimeout(100);
      }

      return fullText;
    } finally {
      await page.close().catch(() => {});
    }
  }
}
