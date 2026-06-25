/**
 * VintedClient — Playwright automation for vinted.co.uk.
 *
 * Design principles:
 *  - It NEVER publishes from createDraft(). It saves a draft and hands back a
 *    screenshot + a per-field report so a human approves before going live.
 *  - Every field fill is isolated: one flaky field reports `failed` and the rest
 *    still go in. You get a draft you can finish by hand rather than an all-or-
 *    nothing crash.
 *  - Selectors live in selectors.ts. This file contains the *flow*, not the CSS.
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { BrowserContext, Page, Locator } from "playwright";
import { launchContext, VINTED_BASE } from "./browser.js";
import { URLS, LOGGED_IN_SIGNALS, FORM, PICKER, ACTIONS } from "./selectors.js";
import type { Listing, DraftResult, FieldResult } from "./types.js";

const DEBUG = process.env.VINTED_DEBUG === "1";

function shotDir(): string {
  const dir = process.env.VINTED_SHOT_DIR || join(process.cwd(), ".vinted-shots");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export class VintedClient {
  private ctx?: BrowserContext;
  private headed: boolean;

  constructor(opts: { headed?: boolean } = {}) {
    this.headed = opts.headed ?? false;
  }

  private async page(): Promise<Page> {
    if (!this.ctx) this.ctx = await launchContext({ headed: this.headed });
    // Reuse the window Chromium already opened (persistent context starts with
    // one tab); only create a new page if somehow none exists. Driving the
    // existing tab avoids leaving a stray about:blank window in front.
    const existing = this.ctx.pages()[0];
    const page = existing ?? (await this.ctx.newPage());
    await page.bringToFront().catch(() => {});
    return page;
  }

  /**
   * Robust navigation. `domcontentloaded`/`load` can stall on Vinted (heavy SPA +
   * anti-bot), leaving the tab on about:blank. We wait for `commit` instead — the
   * URL changes as soon as the server responds — then let content settle. Logs the
   * resulting URL so a stuck navigation is visible rather than silent.
   */
  private async navigate(page: Page, pathOrUrl: string): Promise<void> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : VINTED_BASE + pathOrUrl;
    try {
      await page.goto(url, { waitUntil: "commit", timeout: 60_000 });
    } catch (e) {
      console.error(`[vinted] navigation to ${url} stalled (${String(e).split("\n")[0]}) — retrying…`);
      await page.goto(url, { waitUntil: "load", timeout: 60_000 }).catch((e2) =>
        console.error(`[vinted] retry also failed: ${String(e2).split("\n")[0]}`)
      );
    }
    // Best-effort settle; don't hang if a late subresource never finishes.
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
    if (page.url().startsWith("about:")) {
      // Navigation didn't take — one more attempt.
      await page.goto(url, { waitUntil: "commit", timeout: 60_000 }).catch(() => {});
    }
  }

  async close(): Promise<void> {
    await this.ctx?.close();
    this.ctx = undefined;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** First locator from a candidate list that is actually visible, else null. */
  private async firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      try {
        if (await loc.isVisible({ timeout: 1500 })) return loc;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  private async snap(page: Page, name: string): Promise<string | undefined> {
    try {
      const path = join(shotDir(), `${name}-${Date.now()}.png`);
      await page.screenshot({ path, fullPage: true });
      if (DEBUG) console.error(`[vinted] screenshot → ${path}`);
      return path;
    } catch {
      return undefined;
    }
  }

  // ── session ──────────────────────────────────────────────────────────────

  /**
   * Authenticated when Vinted has set an access/refresh token cookie in the saved
   * profile. This is the reliable signal — it doesn't depend on guessing which
   * page elements appear when logged in, and it sees cookies set in any tab.
   */
  private async hasAuthCookie(): Promise<boolean> {
    if (!this.ctx) return false;
    const cookies = await this.ctx.cookies(VINTED_BASE).catch(() => []);
    return cookies.some((c) => /^(access|refresh)_token/i.test(c.name) && !!c.value);
  }

  /** Diagnostic: list Vinted cookie names in the saved profile and flag the auth one(s). */
  async dumpCookies(): Promise<{ name: string; auth: boolean }[]> {
    await this.page(); // load the persistent context (and its saved cookies)
    const cookies = await this.ctx!.cookies(VINTED_BASE).catch(() => []);
    return cookies
      .map((c) => ({ name: c.name, auth: /^(access|refresh)_token/i.test(c.name) && !!c.value }))
      .sort((a, b) => Number(b.auth) - Number(a.auth) || a.name.localeCompare(b.name));
  }

  async isLoggedIn(): Promise<boolean> {
    await this.page(); // ensure the context (and its saved cookies) is loaded
    // Cookies persist in the profile, so we can often answer without navigating.
    if (await this.hasAuthCookie()) return true;
    // Fallback: load the site, accept cookies, re-check, then look for logged-in UI.
    const page = await this.page();
    await this.navigate(page, URLS.home);
    await this.dismissCookieBanner(page);
    if (await this.hasAuthCookie()) return true;
    return (await this.firstVisible(page, LOGGED_IN_SIGNALS)) !== null;
  }

  private async dismissCookieBanner(page: Page): Promise<void> {
    for (const sel of [
      '#onetrust-accept-btn-handler',
      'button:has-text("Accept all")',
      'button:has-text("Accept")',
    ]) {
      const btn = page.locator(sel).first();
      try {
        if (await btn.isVisible({ timeout: 1200 })) {
          await btn.click();
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Interactive login: opens a visible browser, lets you log in by hand, and
   * waits until it detects a logged-in session (or times out). The session is
   * saved to the persistent profile, so subsequent headless runs are authed.
   * Must run on a machine with a display (i.e. locally, not headless VPS).
   */
  async login(timeoutMs = 300_000): Promise<boolean> {
    // Force headed for login regardless of constructor setting.
    if (this.ctx) await this.close();
    this.ctx = await launchContext({ headed: true });
    const page = await this.page();

    console.error(`[vinted] Opening ${VINTED_BASE} …`);
    await this.navigate(page, URLS.home);
    console.error(`[vinted] Page is now at: ${page.url()}`);
    const blank = page.url().startsWith("about:");
    await this.dismissCookieBanner(page).catch(() => {});
    console.error(
      "[vinted] 👉 Log in to Vinted in the open browser window" +
        (blank ? " (type vinted.co.uk into the address bar first — it didn't load on its own)" : "") +
        ", solving any captcha. I'll detect it automatically — keep this terminal running. " +
        `Waiting up to ${Math.round(timeoutMs / 1000)}s …`
    );

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Primary signal: the auth cookie (works whatever tab/page you used).
      if (await this.hasAuthCookie()) {
        console.error("[vinted] ✅ Login detected — session saved.");
        return true;
      }
      // Secondary: a logged-in element on the current front page.
      const front = this.ctx?.pages()[0] ?? page;
      if (await this.firstVisible(front, LOGGED_IN_SIGNALS).catch(() => null)) {
        console.error("[vinted] ✅ Login detected — session saved.");
        return true;
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    console.error("[vinted] ⌛ Timed out — no logged-in session detected.");
    return false;
  }

  // ── drafting ─────────────────────────────────────────────────────────────

  async createDraft(listing: Listing): Promise<DraftResult> {
    const fields: FieldResult[] = [];
    const page = await this.page();

    await this.navigate(page, URLS.newItem);
    await this.dismissCookieBanner(page);

    // Bail early with a clear message if Vinted bounced us to a login wall.
    if (!(await this.firstVisible(page, LOGGED_IN_SIGNALS))) {
      const onForm = await this.firstVisible(page, FORM.photoInput);
      if (!onForm) {
        const shot = await this.snap(page, "not-logged-in");
        return {
          saved: false,
          screenshotPath: shot,
          fields,
          summary:
            "Not logged in (or hit an anti-bot wall). Run the `vinted_login` tool / `vinted-list login` first.",
        };
      }
    }

    // 1) Photos — do these first; Vinted often gates other fields until ≥1 photo.
    fields.push(await this.uploadPhotos(page, listing.photos));

    // 2) Free-text fields.
    fields.push(await this.fillText(page, "title", FORM.title.css, FORM.title.byLabel, listing.title));
    fields.push(
      await this.fillText(page, "description", FORM.description.css, FORM.description.byLabel, listing.description)
    );

    // 3) Pickers.
    fields.push(await this.pickPath(page, "category", FORM.categoryTrigger, listing.category));
    fields.push(await this.pickValue(page, "condition", FORM.conditionTrigger, [listing.condition]));
    if (listing.brand) fields.push(await this.pickValue(page, "brand", FORM.brandTrigger, [listing.brand]));
    if (listing.size) fields.push(await this.pickValue(page, "size", FORM.sizeTrigger, [listing.size]));
    if (listing.colors?.length)
      fields.push(await this.pickValue(page, "colour", FORM.colorTrigger, listing.colors));
    if (listing.material)
      fields.push(await this.pickValue(page, "material", FORM.materialTrigger, [listing.material]));
    fields.push(await this.pickValue(page, "parcelSize", FORM.parcelTrigger, [listing.parcelSize], true));

    // 4) Price (text input, GBP).
    fields.push(
      await this.fillText(page, "price", FORM.price.css, FORM.price.byLabel, String(listing.price))
    );

    // 5) Save as a DRAFT (never publish here).
    const saveBtn = await this.firstVisible(page, ACTIONS.saveDraft);
    let saved = false;
    if (saveBtn) {
      try {
        await saveBtn.click();
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        saved = true;
      } catch (e) {
        fields.push({ field: "saveDraft", status: "failed", detail: String(e).slice(0, 200) });
      }
    } else {
      fields.push({
        field: "saveDraft",
        status: "skipped",
        detail: "No 'Save as draft' button found — left form filled but unsaved for manual review.",
      });
    }

    const screenshotPath = await this.snap(page, saved ? "draft-saved" : "draft-review");
    const ok = fields.filter((f) => f.status === "ok").length;
    const failed = fields.filter((f) => f.status === "failed");

    return {
      saved,
      draftUrl: saved ? page.url() : undefined,
      screenshotPath,
      fields,
      summary:
        `${ok} field(s) set${failed.length ? `, ${failed.length} need attention: ${failed
          .map((f) => f.field)
          .join(", ")}` : ""}. ` +
        (saved
          ? "Saved as draft — review the screenshot, then publish with `vinted_publish`."
          : "NOT saved — open Vinted and finish/save manually, then review."),
    };
  }

  private async uploadPhotos(page: Page, photos: string[]): Promise<FieldResult> {
    const missing = photos.filter((p) => !existsSync(p));
    if (missing.length)
      return { field: "photos", status: "failed", detail: `Missing files: ${missing.join(", ")}` };
    try {
      // setInputFiles works on hidden inputs; no need to click the drop-zone.
      const input = page.locator(FORM.photoInput.join(", ")).first();
      await input.setInputFiles(photos, { timeout: 20000 });
      // Wait for thumbnails to register.
      await page.waitForTimeout(2500);
      return { field: "photos", status: "ok", detail: `${photos.length} uploaded` };
    } catch (e) {
      return { field: "photos", status: "failed", detail: String(e).slice(0, 200) };
    }
  }

  private async fillText(
    page: Page,
    field: string,
    css: string[],
    labels: string[],
    value: string
  ): Promise<FieldResult> {
    try {
      let loc = await this.firstVisible(page, css);
      if (!loc) {
        for (const label of labels) {
          const byLabel = page.getByLabel(label, { exact: false }).first();
          if (await byLabel.isVisible({ timeout: 1200 }).catch(() => false)) {
            loc = byLabel;
            break;
          }
        }
      }
      if (!loc) return { field, status: "failed", detail: "input not found" };
      await loc.fill(value);
      return { field, status: "ok" };
    } catch (e) {
      return { field, status: "failed", detail: String(e).slice(0, 200) };
    }
  }

  /** Open a picker and select one or more values by visible text. */
  private async pickValue(
    page: Page,
    field: string,
    trigger: string[],
    values: string[],
    optional = false
  ): Promise<FieldResult> {
    try {
      const trig = await this.firstVisible(page, trigger);
      if (!trig)
        return { field, status: optional ? "skipped" : "failed", detail: "trigger not found" };
      await trig.click();
      await page.waitForTimeout(600);

      const picked: string[] = [];
      for (const value of values) {
        // Type into the picker's search box if present (helps long lists).
        const search = await this.firstVisible(page, PICKER.searchInput);
        if (search) {
          await search.fill(value);
          await page.waitForTimeout(500);
        }
        const option = await this.firstVisible(page, PICKER.option(value));
        if (option) {
          await option.click();
          picked.push(value);
          await page.waitForTimeout(400);
        }
      }

      // Confirm multi-select drawers if a confirm button exists.
      const confirm = await this.firstVisible(page, PICKER.confirm);
      if (confirm) await confirm.click().catch(() => {});

      if (!picked.length)
        return { field, status: "failed", detail: `none of [${values.join(", ")}] matched` };
      return {
        field,
        status: picked.length === values.length ? "ok" : "failed",
        detail: `selected: ${picked.join(", ")}`,
      };
    } catch (e) {
      return { field, status: "failed", detail: String(e).slice(0, 200) };
    }
  }

  /** Walk a hierarchical picker (category) level by level. */
  private async pickPath(
    page: Page,
    field: string,
    trigger: string[],
    path: string[]
  ): Promise<FieldResult> {
    try {
      const trig = await this.firstVisible(page, trigger);
      if (!trig) return { field, status: "failed", detail: "trigger not found" };
      await trig.click();
      await page.waitForTimeout(600);

      const walked: string[] = [];
      for (const level of path) {
        const search = await this.firstVisible(page, PICKER.searchInput);
        if (search) {
          await search.fill(level);
          await page.waitForTimeout(500);
        }
        const option = await this.firstVisible(page, PICKER.option(level));
        if (!option) break;
        await option.click();
        walked.push(level);
        await page.waitForTimeout(500);
      }

      const confirm = await this.firstVisible(page, PICKER.confirm);
      if (confirm) await confirm.click().catch(() => {});

      return {
        field,
        status: walked.length === path.length ? "ok" : "failed",
        detail: `walked: ${walked.join(" › ") || "(none)"}`,
      };
    } catch (e) {
      return { field, status: "failed", detail: String(e).slice(0, 200) };
    }
  }

  // ── publish / list ───────────────────────────────────────────────────────

  /** Publish a saved draft. Pass the draft URL (from createDraft). */
  async publishDraft(draftUrl: string): Promise<{ published: boolean; url?: string; detail?: string }> {
    const page = await this.page();
    await this.navigate(page, draftUrl);
    await this.dismissCookieBanner(page);
    const btn = await this.firstVisible(page, ACTIONS.publish);
    if (!btn) return { published: false, detail: "Publish/Upload button not found on draft page." };
    await btn.click();
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    return { published: true, url: page.url() };
  }

  /** Return links to current drafts for review. */
  async listDrafts(): Promise<{ url: string; title: string }[]> {
    const page = await this.page();
    await this.navigate(page, URLS.draftsHint);
    await this.dismissCookieBanner(page);
    const items = page.locator('a[href*="/items/"]');
    const out: { url: string; title: string }[] = [];
    const n = Math.min(await items.count(), 50);
    for (let i = 0; i < n; i++) {
      const a = items.nth(i);
      const href = await a.getAttribute("href");
      const title = (await a.getAttribute("title")) || (await a.innerText().catch(() => "")) || "(untitled)";
      if (href) out.push({ url: href.startsWith("http") ? href : VINTED_BASE + href, title: title.trim() });
    }
    return out;
  }
}
