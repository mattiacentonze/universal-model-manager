import type { Page } from "playwright-core";
import { BrowserManager } from "./browser-manager.js";
import { CHATGPT_TEMPORARY_CHAT_URL, SELECTORS } from "./selectors.js";
import { resolveEffortIndex } from "./models.js";
import { logger } from "../shared/logger.js";

export interface RunOptions {
  modelId?: string;
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function applyEffortLevel(page: Page, modelId: string | undefined): Promise<void> {
  if (!modelId) return;
  const targetIndex = resolveEffortIndex(modelId);
  if (targetIndex === undefined) return;

  try {
    const effortBtn = page.locator(SELECTORS.effortButton).first();
    if (!await effortBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      return; // Account does not have effort dropdown (e.g. Free/Luna)
    }

    await effortBtn.click({ timeout: 2000 }).catch(() => {});
    const slider = page.locator(SELECTORS.effortSlider).first();
    if (await slider.isVisible({ timeout: 3000 }).catch(() => false)) {
      const min = Number(await slider.getAttribute("aria-valuemin")) || 0;
      const max = Number(await slider.getAttribute("aria-valuemax")) || 4;
      let current = Number(await slider.getAttribute("aria-valuenow")) || 0;
      const clampedTarget = Math.min(Math.max(targetIndex, min), max);

      let attempts = 0;
      while (current !== clampedTarget && attempts < 10) {
        attempts++;
        const key = clampedTarget > current ? "ArrowRight" : "ArrowLeft";
        await slider.press(key);
        await page.waitForTimeout(80);
        const updated = Number(await slider.getAttribute("aria-valuenow"));
        if (updated === current) break;
        current = updated;
      }
      logger.debug(`Reasoning effort set to index ${current} (target was ${targetIndex})`);
    }
    await page.keyboard.press("Escape").catch(() => {});
  } catch (err) {
    logger.warn(`Could not set reasoning effort slider: ${err}`);
  }
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

      // 2. Select reasoning effort if available on Plus/Pro
      await applyEffortLevel(page, options.modelId);

      // 3. Insert prompt into composer
      await composer.fill(prompt);
      await page.waitForTimeout(200);

      // 4. Send prompt
      const sendButton = page.locator(SELECTORS.sendButton).first();
      if (await sendButton.isVisible().catch(() => false)) {
        await sendButton.click();
      } else {
        await composer.press("Enter");
      }

      logger.debug(`Prompt submitted for model ${options.modelId || "auto"}. Waiting for assistant generation...`);

      // 5. Wait for generation to start
      await page.waitForTimeout(1000);
      await page.locator(SELECTORS.stopButton).first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});

      let fullText = "";
      let lastReportedLen = 0;
      const startTime = Date.now();

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
        const mdEl = assistantTurn.locator(".markdown").last();
        const hasMarkdown = (await mdEl.count().catch(() => 0)) > 0;
        const currentContent = hasMarkdown
          ? (await mdEl.innerText().catch(() => "")) || ""
          : (await assistantTurn.innerText().catch(() => "")) || "";

        if (hasMarkdown && currentContent.length > lastReportedLen) {
          const delta = currentContent.slice(lastReportedLen);
          lastReportedLen = currentContent.length;
          fullText = currentContent;
          if (options.onDelta) {
            options.onDelta(delta);
          }
        }

        // Check if generation completed: stop button is gone and markdown answer is present
        const isGenerating = await page.locator(SELECTORS.stopButton).first().isVisible().catch(() => false);

        if (!isGenerating && hasMarkdown && currentContent.trim().length > 0) {
          await page.waitForTimeout(400);
          const finalContent = (await mdEl.innerText().catch(() => "")) || currentContent;
          if (finalContent.length > lastReportedLen) {
            const finalDelta = finalContent.slice(lastReportedLen);
            if (options.onDelta) options.onDelta(finalDelta);
            fullText = finalContent;
          }
          logger.debug(`Generation completed successfully (${fullText.length} chars)`);
          return fullText.trim();
        }

        await page.waitForTimeout(150);
      }

      return fullText;
    } finally {
      await page.close().catch(() => {});
    }
  }
}
