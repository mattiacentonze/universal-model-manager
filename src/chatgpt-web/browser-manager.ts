import { existsSync } from "node:fs";
import { type Browser, type BrowserContext, chromium } from "playwright-core";
import { logger } from "../shared/logger.js";
import { getChatGptProfileDir } from "../shared/paths.js";
import { SELECTORS } from "./selectors.js";
import { SessionStore } from "./session-store.js";

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
  throw new Error("Could not locate Google Chrome or Chromium executable. Set CHROME_PATH environment variable.");
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

    const profileDir = getChatGptProfileDir();
    let context: BrowserContext | null = null;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        executablePath,
        headless: false,
        viewport: { width: 1280, height: 900 },
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--no-default-browser-check",
          "--log-level=3",
          "--silent",
          "--disable-logging",
        ],
      });

      const page = context.pages()[0] || (await context.newPage());
      // Navigate directly to ChatGPT login portal so user sees login buttons
      await page.goto("https://chatgpt.com/auth/login", { waitUntil: "domcontentloaded", timeout: 60_000 });

      logger.info("Chrome opened on ChatGPT login page. Please complete login. Waiting for authenticated session...");

      const timeoutMs = 300_000; // 5 minutes
      const startTime = Date.now();
      let loggedIn = false;

      while (Date.now() - startTime < timeoutMs) {
        if (page.isClosed()) {
          logger.warn("Interactive login window was closed by user.");
          break;
        }

        // 1. Check profile button / user menu (only visible when truly logged in)
        const profileBtn = page.locator(SELECTORS.profileButton).first();
        const hasProfileBtn = await profileBtn.isVisible().catch(() => false);

        // 2. Check localStorage for user key
        const userKey = await page
          .evaluate(() => {
            try {
              return Object.keys(localStorage).find((k) => k.startsWith("cache/user-") || k.includes("user-")) || null;
            } catch {
              return null;
            }
          })
          .catch(() => null);

        // 3. The guest "Log in" button must be absent from header/sidebar
        const hasLoginBtn = await page
          .locator('button:has-text("Log in"), a:has-text("Log in")')
          .first()
          .isVisible()
          .catch(() => false);

        // 4. Composer must be visible
        const hasComposer = await page
          .locator(SELECTORS.composer)
          .first()
          .isVisible()
          .catch(() => false);

        // Truly authenticated: user profile or user key, composer visible, and NOT showing login buttons
        if ((hasProfileBtn || Boolean(userKey)) && hasComposer && !hasLoginBtn) {
          loggedIn = true;
          let accountName = (await profileBtn.innerText().catch(() => "")) || "";
          accountName = accountName.trim().split("\n")[0] || "";

          logger.info(`Login detected for ${accountName || "user"}! Capturing session credentials...`);
          await page.waitForTimeout(2000);
          const state = await context.storageState();
          this.sessionStore.save(state as any);
          if (accountName) {
            this.sessionStore.saveAccountInfo({ name: accountName, updatedAt: new Date().toISOString() });
          }
          logger.info("Session credentials captured and saved successfully.");
          break;
        }

        await new Promise((r) => setTimeout(r, 1000));
      }

      return loggedIn;
    } catch (err) {
      logger.error(`Login wait failed or timed out: ${err}`);
      return false;
    } finally {
      await context?.close().catch(() => {});
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
