/**
 * Browser bootstrap for the Vinted connector.
 *
 * Two concerns live here:
 *  1. Finding a Chromium binary to drive. Locally, Playwright's bundled Chromium
 *     (installed via `bunx playwright install chromium`) just works. In some
 *     managed/CI environments the browser lives under PLAYWRIGHT_BROWSERS_PATH
 *     with a build number that doesn't match the npm package, so we resolve it
 *     ourselves. You can always override with VINTED_CHROMIUM_PATH.
 *  2. A *persistent* browser profile, so your Vinted login (and the DataDome
 *     anti-bot cookies) survive between runs. Without this you'd re-login every
 *     time and trip bot detection far more often.
 */

import { chromium, type BrowserContext } from "playwright";
import { existsSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/** Where the logged-in Vinted session is kept. Override with VINTED_PROFILE_DIR. */
export function profileDir(): string {
  const dir =
    process.env.VINTED_PROFILE_DIR ||
    join(homedir(), ".gobot", "vinted-profile");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Best-effort resolution of a Chromium executable.
 * Returns undefined to let Playwright use its own bundled browser (the normal
 * local case), or an explicit path when we find one under PLAYWRIGHT_BROWSERS_PATH.
 */
export function resolveChromium(): string | undefined {
  if (process.env.VINTED_CHROMIUM_PATH) return process.env.VINTED_CHROMIUM_PATH;

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    // Prefer a full chromium build (chromium-<rev>) over the headless shell,
    // since the listing flow benefits from running headful during login.
    const candidates = readdirSync(root)
      .filter((d) => d.startsWith("chromium-"))
      .sort();
    for (const dir of candidates) {
      for (const rel of [
        join("chrome-linux", "chrome"),
        join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        join("chrome-win", "chrome.exe"),
      ]) {
        const p = join(root, dir, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined; // fall back to Playwright's bundled resolution
}

export interface LaunchOptions {
  /** Headful (visible window) — required for manual login and captcha solving. */
  headed?: boolean;
  /** Locale/timezone defaults to the UK so the right Vinted domain/currency loads. */
  locale?: string;
  timezone?: string;
}

/**
 * Launch (or re-attach to) the persistent Vinted browser context.
 * Caller is responsible for `await context.close()`.
 */
export async function launchContext(
  opts: LaunchOptions = {}
): Promise<BrowserContext> {
  const executablePath = resolveChromium();
  const headless = !opts.headed;

  const context = await chromium.launchPersistentContext(profileDir(), {
    headless,
    executablePath,
    locale: opts.locale || "en-GB",
    timezoneId: opts.timezone || "Europe/London",
    viewport: { width: 1280, height: 900 },
    // A real, current UA reduces (does not eliminate) anti-bot friction.
    userAgent:
      process.env.VINTED_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    args: ["--disable-blink-features=AutomationControlled"],
  });

  context.setDefaultTimeout(45_000);
  return context;
}

export const VINTED_BASE = process.env.VINTED_BASE_URL || "https://www.vinted.co.uk";
