import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { getChatGptProfileDir } from "../shared/paths.js";
import { SessionStore } from "./session-store.js";
import { logger } from "../shared/logger.js";
import { CHATGPT_BASE_URL, SELECTORS } from "./selectors.js";

const DEFAULT_CHROME_PATHS = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean) as string[];

export function findExecutablePath(): string {
  for (const path of DEFAULT_CHROME_PATHS) {
    if (existsSync(path)) return path;
  }
  throw new Error(
    "Could not locate Google Chrome or Chromium executable. Set CHROME_PATH environment variable."
  );
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly sessionStore: SessionStore;

  constructor(sessionStore = new SessionStore()) {
    this.sessionStore = sessionStore;
  }

  async launchInteractiveLogin(): Promise<boolean> {
    const executablePath = findExecutablePath();
    logger.info(`Launching interactive login browser with ${executablePath}...`);

    // In interactive mode we open a headed browser with a dedicated user data dir
    const context = await chromium.launchPersistentContext(getChatGptProfileDir(), {
      executablePath,
      headless: false,
      viewport: { width: 1280, height: 900 },
      args: ["--disable-blink-features=AutomationControlled"],
    });

    try {
      const page = context.pages()[0] || (await context.newPage());
      await page.goto(CHATGPT_BASE_URL, { waitUntil: "domcontentloaded" });

      logger.info("Please log in to ChatGPT in the opened browser window. Waiting for session...");

      // Wait up to 5 minutes for the user to complete login
      await page.waitForSelector(SELECTORS.composer, { timeout: 300_000 });

      const state = await context.storageState();
      this.sessionStore.save(state as any);
      logger.info("Login successful! Session credentials captured.");
      return true;
    } catch (err) {
      logger.error(`Login wait failed or timed out: ${err}`);
      return false;
    } finally {
      await context.close().catch(() => {});
    }
  }

  async getTurnContext(): Promise<BrowserContext> {
    if (this.context) return this.context;

    const executablePath = findExecutablePath();
    const storageState = this.sessionStore.load();
    const isHeadless = process.env.CHATGPT_WEB_HEADED !== "1";

    this.browser = await chromium.launch({
      executablePath,
      headless: isHeadless,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    this.context = await this.browser.newContext({
      storageState: storageState as any,
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    });

    return this.context;
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
