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
import { launchContext, resolveChromium, profileDir, VINTED_BASE } from "./browser.js";
import { URLS, LOGGED_IN_SIGNALS, FORM, CATEGORY, PICKERS, PACKAGE, ACTIONS } from "./selectors.js";
import type { Listing, DraftResult, FieldResult } from "./types.js";

const DEBUG = process.env.VINTED_DEBUG === "1";

function shotDir(): string {
  const dir = process.env.VINTED_SHOT_DIR || join(process.cwd(), ".vinted-shots");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Size-label variants to try in the size grid. The grid shows bare sizes like
 * "9", while a listing may say "UK 9" — so we also try the value with a common
 * region prefix stripped, and the final token. e.g. "UK 9" → ["UK 9", "9"].
 */
function sizeVariants(value: string): string[] {
  const out = [value];
  const stripped = value.replace(/^\s*(uk|eu|us|eur|eu\/uk)\s*/i, "").trim();
  if (stripped && !out.includes(stripped)) out.push(stripped);
  const lastTok = value.split(/\s+/).pop() || "";
  if (lastTok && !out.includes(lastTok)) out.push(lastTok);
  return out;
}

/** Pull a human-readable message out of a Vinted API error body (best effort). */
function extractApiError(body: string): string {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    if (typeof j.message === "string" && j.message) return j.message;
    if (typeof j.error === "string" && j.error) return j.error;
    const errs = j.errors;
    if (Array.isArray(errs) && errs.length)
      return errs
        .map((e) => (e && typeof e === "object" ? (e as any).value || (e as any).message || (e as any).field : String(e)))
        .filter(Boolean)
        .join("; ");
  } catch {
    /* body wasn't JSON */
  }
  return body.replace(/\s+/g, " ").slice(0, 140);
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
  // Match the access/refresh token cookie (unanchored, in case Vinted prefixes the
  // name). NOT session cookies like _vinted_fr_session — those exist when logged out
  // too, so they'd give a false "logged in".
  private static AUTH_COOKIE_RE = /(access|refresh)_token/i;

  /**
   * All Vinted cookies in the context, regardless of exact domain
   * (vinted.co.uk vs www.vinted.co.uk). We read the whole jar and filter by the
   * "vinted" domain ourselves — a URL filter would miss apex-domain host-only
   * cookies and silently fail to detect the session.
   */
  private async vintedCookies(): Promise<{ name: string; value: string; domain: string }[]> {
    if (!this.ctx) return [];
    const all = await this.ctx.cookies().catch(() => []);
    return all.filter((c) => /vinted/i.test(c.domain));
  }

  private async hasAuthCookie(): Promise<boolean> {
    const cookies = await this.vintedCookies();
    return cookies.some((c) => VintedClient.AUTH_COOKIE_RE.test(c.name) && !!c.value);
  }

  /** Just the Vinted cookie names currently in the context (for diagnostics). */
  private async cookieNames(): Promise<string[]> {
    return (await this.vintedCookies()).map((c) => c.name);
  }

  /** Diagnostic: list Vinted cookie names in the saved profile and flag the auth one(s). */
  async dumpCookies(): Promise<{ name: string; auth: boolean }[]> {
    await this.page(); // load the persistent context (and its saved cookies)
    const cookies = await this.vintedCookies();
    return cookies
      .map((c) => ({ name: c.name, auth: VintedClient.AUTH_COOKIE_RE.test(c.name) && !!c.value }))
      .sort((a, b) => Number(b.auth) - Number(a.auth) || a.name.localeCompare(b.name));
  }

  /**
   * Print a clean, self-contained diagnosis (headless, no noisy window):
   * which browser is used, whether navigation reaches Vinted, and what cookies
   * (if any) the saved profile holds. This is what to run when login misbehaves.
   */
  async diagnose(): Promise<void> {
    console.log("── Vinted connector doctor ─────────────────────────────");
    console.log(`Chromium binary : ${resolveChromium() ?? "(Playwright bundled default)"}`);
    console.log(`Profile dir     : ${profileDir()}`);
    console.log(`Target site     : ${VINTED_BASE}`);
    console.log("Launching headless browser and loading Vinted…");
    const page = await this.page();
    await this.navigate(page, URLS.home);
    console.log(`Reached URL     : ${page.url()}`);
    console.log(`Page title      : ${await page.title().catch(() => "(none)")}`);
    const names = await this.cookieNames();
    console.log(`Vinted cookies  : ${names.length ? names.sort().join(", ") : "(none)"}`);
    console.log(`Auth cookie     : ${(await this.hasAuthCookie()) ? "✅ present — logged in" : "❌ not found — not logged in"}`);
    const reached = /vinted/i.test(page.url());
    console.log("────────────────────────────────────────────────────────");
    if (!reached) {
      console.log("⚠️  The headless browser couldn't reach vinted.co.uk — this points to a");
      console.log("    network/VPN/firewall block rather than the connector. Try opening");
      console.log("    vinted.co.uk in a normal browser on this laptop to confirm access.");
    } else if (!names.length) {
      console.log("ℹ️  Reached Vinted but no session cookies yet — run `vinted:list login`");
      console.log("    and complete login INSIDE the 'Chrome for Testing' window it opens.");
    }
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
    let lastNames = "";
    let ticks = 0;
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
      // Surface the cookie names we can see, so a name mismatch is visible live.
      // Print whenever the set changes, and at least every ~15s.
      const names = (await this.cookieNames()).sort();
      const joined = names.join(", ");
      if (names.length && (joined !== lastNames || ticks % 6 === 0)) {
        console.error(`[vinted] cookies so far: ${joined || "(none)"}`);
        lastNames = joined;
      }
      ticks++;
      await new Promise((r) => setTimeout(r, 2500));
    }
    console.error("[vinted] ⌛ Timed out — no logged-in session detected.");
    console.error(`[vinted] Final cookies seen: ${lastNames || "(none)"}`);
    return false;
  }

  // ── drafting ─────────────────────────────────────────────────────────────

  async createDraft(listing: Listing): Promise<DraftResult> {
    const fields: FieldResult[] = [];
    const page = await this.page();

    await this.navigate(page, URLS.newItem);
    await this.dismissCookieBanner(page);

    // The sell form is a heavy SPA that starts as a spinner. Wait for it to
    // actually render before touching fields — checking too early is what used
    // to give a false "not logged in".
    const ready = await this.waitForForm(page);
    if (!ready) {
      const loggedIn = await this.firstVisible(page, LOGGED_IN_SIGNALS);
      const shot = await this.snap(page, loggedIn ? "form-not-ready" : "not-logged-in");
      return {
        saved: false,
        screenshotPath: shot,
        fields,
        summary: loggedIn
          ? "Reached Vinted logged in, but the 'Sell an item' form didn't finish loading in time. Try again (run headed to watch)."
          : "Not logged in (or hit an anti-bot wall). Run the `vinted_login` tool / `vinted:list login` first.",
      };
    }

    // 1) Photos first — Vinted gates the rest of the form until ≥1 photo.
    fields.push(await this.uploadPhotos(page, listing.photos));
    await page.waitForTimeout(1500);

    // 2) Free-text fields.
    fields.push(await this.fillText(page, "title", FORM.title.css, FORM.title.byLabel, listing.title));
    fields.push(
      await this.fillText(page, "description", FORM.description.css, FORM.description.byLabel, listing.description)
    );

    // 3) Category — selecting it reveals the attribute fields (brand/size/…).
    fields.push(await this.selectCategory(page, listing.category));
    await page.waitForTimeout(1200);

    // 4) Attribute pickers (only present once a category is chosen). Fill them in
    //    the form's visual top-to-bottom order (brand, size, condition, colour,
    //    material) so each is reached fresh — jumping around the form could scroll
    //    a trigger under the sticky header and swallow its click.
    if (listing.brand) fields.push(await this.pickOptions(page, "brand", FORM.brandTrigger, PICKERS.brand, [listing.brand]));
    if (listing.size) fields.push(await this.pickOptions(page, "size", FORM.sizeTrigger, PICKERS.size, [listing.size], true));
    fields.push(await this.pickOptions(page, "condition", FORM.conditionTrigger, PICKERS.condition, [listing.condition]));
    if (listing.colors?.length)
      fields.push(await this.pickOptions(page, "colour", FORM.colorTrigger, PICKERS.color, listing.colors));
    if (listing.material)
      fields.push(await this.pickOptions(page, "material", FORM.materialTrigger, PICKERS.material, [listing.material]));
    fields.push(await this.selectPackageSize(page, listing.parcelSize));

    // 5) Price (text input, GBP).
    fields.push(
      await this.fillText(page, "price", FORM.price.css, FORM.price.byLabel, String(listing.price))
    );

    // 6) Save as a DRAFT (never publish here). A button click "working" does NOT
    //    mean the draft saved — Vinted validates server-side and can reject it
    //    (e.g. HTTP 400 "Title contains too many symbol characters"). So we watch
    //    the real POST /api/v2/item_upload/drafts response and report its outcome
    //    instead of assuming success.
    const saveBtn = await this.firstVisible(page, ACTIONS.saveDraft);
    let saved = false;
    let draftUrl: string | undefined;
    if (!saveBtn) {
      fields.push({
        field: "saveDraft",
        status: "skipped",
        detail: "No 'Save as draft' button found — left form filled but unsaved for manual review.",
      });
    } else {
      const respPromise = page
        .waitForResponse(
          (r) => /\/api\/v2\/item_upload\/drafts/.test(r.url()) && r.request().method() === "POST",
          { timeout: 20000 }
        )
        .catch(() => null);
      try {
        await saveBtn.click();
      } catch (e) {
        fields.push({ field: "saveDraft", status: "failed", detail: `Save button click failed: ${String(e).slice(0, 150)}` });
      }
      const resp = await respPromise;
      if (!resp) {
        fields.push({ field: "saveDraft", status: "failed", detail: "No draft-save response from Vinted — the draft was NOT saved." });
      } else if (resp.status() >= 200 && resp.status() < 300) {
        saved = true;
        const id = await resp.json().then((j: any) => j?.item?.id ?? j?.draft?.id ?? j?.id).catch(() => undefined);
        // A successful save redirects to the member profile; let it settle.
        await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
        draftUrl = id ? `${VINTED_BASE}/items/${id}` : page.url();
        fields.push({ field: "saveDraft", status: "ok", detail: `draft saved (HTTP ${resp.status()})` });
      } else {
        const msg = await resp.text().then((t) => extractApiError(t)).catch(() => "");
        fields.push({
          field: "saveDraft",
          status: "failed",
          detail: `Vinted rejected the draft (HTTP ${resp.status()})${msg ? `: ${msg}` : ""}`,
        });
      }
    }

    const screenshotPath = await this.snap(page, saved ? "draft-saved" : "draft-review");
    const ok = fields.filter((f) => f.status === "ok").length;
    const failed = fields.filter((f) => f.status === "failed");

    return {
      saved,
      draftUrl,
      screenshotPath,
      fields,
      summary:
        `${ok} field(s) set${failed.length ? `, ${failed.length} need attention: ${failed
          .map((f) => f.field)
          .join(", ")}` : ""}. ` +
        (saved
          ? "Saved as draft — review the screenshot, then publish with `vinted_publish`."
          : "NOT saved — see the 'saveDraft' detail (often a field Vinted rejected, e.g. a symbol-heavy title); fix and retry."),
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

  /**
   * Wait for the SPA "Sell an item" form to mount (it starts as a spinner). The
   * hidden photo input appears in the DOM once the form is ready — checking
   * fields before this is what used to give a false "not logged in".
   */
  private async waitForForm(page: Page): Promise<boolean> {
    for (const sel of FORM.formReady) {
      const ok = await page
        .waitForSelector(sel, { state: "attached", timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        await page.waitForTimeout(1200); // let the rest of the form settle
        return true;
      }
    }
    return false;
  }

  /** Click a picker trigger to open its dropdown/list/grid; returns the trigger. */
  private async openTrigger(page: Page, trigger: string[]): Promise<Locator | null> {
    const trig = await this.firstVisible(page, trigger);
    if (!trig) return null;
    // Playwright's click auto-scrolls and waits for actionability. If a click is
    // intercepted (e.g. by the sticky header) it throws — log that rather than
    // swallow it, since a silently-missed click looks like an empty dropdown.
    try {
      await trig.click({ timeout: 8000 });
    } catch (e) {
      // A blocked click (e.g. a prior dropdown's overlay still covering the form)
      // throws here — fail fast and log rather than hang for the full timeout.
      if (DEBUG) console.error(`[vinted] openTrigger click failed: ${String(e).split("\n")[0]}`);
    }
    await page.waitForTimeout(800);
    return trig;
  }

  /**
   * Category picker: type the leaf into the dropdown's search box, then click the
   * result row whose path matches. Result rows read "<Leaf><Parents>", e.g.
   * "TrainersMen > Shoes", so we match leaf + the parent chain (this disambiguates
   * e.g. Men vs Women Trainers, which a naive substring match would not).
   */
  private async selectCategory(page: Page, path: string[]): Promise<FieldResult> {
    const field = "category";
    try {
      if (!(await this.openTrigger(page, FORM.categoryTrigger)))
        return { field, status: "failed", detail: "category trigger not found" };
      const leaf = path[path.length - 1];
      const search = await this.firstVisible(page, CATEGORY.searchInput);
      if (!search) return { field, status: "failed", detail: "category search box not found" };
      await search.fill(leaf);
      await page.waitForTimeout(1200);

      const matched = await page.evaluate(
        ({ rowCss, fullPath }) => {
          const norm = (s: string | null) => (s || "").trim().replace(/\s+/g, " ").toLowerCase();
          const vis = (el: Element) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
          };
          const rows = [...document.querySelectorAll(rowCss)].filter(vis);
          const leafLabel = fullPath[fullPath.length - 1];
          const parents = fullPath.slice(0, -1).join(" > ");
          const want = norm(leafLabel + parents);
          let m =
            rows.find((e) => norm(e.textContent) === want) ||
            (parents
              ? rows.find((e) => {
                  const t = norm(e.textContent);
                  return t.startsWith(norm(leafLabel)) && t.slice(norm(leafLabel).length).trim().startsWith(norm(fullPath[0]));
                })
              : undefined) ||
            rows.find((e) => norm(e.textContent).includes(norm(leafLabel)));
          if (m) {
            (m as HTMLElement).click();
            return (m.textContent || "").trim().slice(0, 60);
          }
          return null;
        },
        { rowCss: CATEGORY.resultRow, fullPath: path }
      );
      await page.waitForTimeout(1500);
      if (!matched) return { field, status: "failed", detail: `no result matched ${path.join(" › ")}` };
      return { field, status: "ok", detail: `matched "${matched}"` };
    } catch (e) {
      return { field, status: "failed", detail: String(e).slice(0, 200) };
    }
  }

  /**
   * In the currently-open picker, click the first visible option matching a
   * candidate — exact text first, then startsWith (so "Good" never grabs "Very
   * good"). Returns the clicked option's text, or null if nothing matched.
   */
  private async clickOption(page: Page, optionCss: string, candidates: string[]): Promise<string | null> {
    return await page
      .evaluate(
        ({ css, cands }) => {
          const norm = (s: string | null) => (s || "").trim().replace(/\s+/g, " ").toLowerCase();
          const vis = (el: Element) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
          };
          const els = [...document.querySelectorAll(css)].filter(vis);
          for (const c of cands) {
            const m = els.find((e) => norm(e.textContent) === norm(c));
            if (m) { (m as HTMLElement).click(); return (m.textContent || "").trim().slice(0, 40); }
          }
          for (const c of cands) {
            const m = els.find((e) => norm(e.textContent).startsWith(norm(c)));
            if (m) { (m as HTMLElement).click(); return (m.textContent || "").trim().slice(0, 40); }
          }
          return null;
        },
        { css: optionCss, cands: candidates }
      )
      .catch(() => null);
  }

  /**
   * Generic option picker for condition/brand/size/colour/material. Opens the
   * trigger, optionally types into an in-dropdown search box, then clicks the
   * option whose visible text matches — exact first, then startsWith, so "Good"
   * does not grab "Very good". `sizeNormalize` also tries the size without a
   * "UK "/"EU "/"US " prefix (the grid shows "9", not "UK 9").
   */
  private async pickOptions(
    page: Page,
    field: string,
    trigger: string[],
    picker: { optionCss: string; search: string[]; multi: boolean },
    values: string[],
    sizeNormalize = false
  ): Promise<FieldResult> {
    try {
      const trig = await this.openTrigger(page, trigger);
      if (!trig) return { field, status: "failed", detail: "trigger not found" };
      // Wait for the picker's options to actually render before matching.
      await page.waitForSelector(picker.optionCss, { state: "visible", timeout: 4000 }).catch(() => {});

      const picked: string[] = [];
      for (const value of values) {
        const candidates = sizeNormalize ? sizeVariants(value) : [value];
        // 1) Match from the options already shown. The popular-brands list (and
        //    the full lists for size/colour/material) usually already contains the
        //    target, so we avoid typing — which on a remote-backed search (brand)
        //    clears the list into an empty gap before results load.
        let clicked = await this.clickOption(page, picker.optionCss, candidates);
        // 2) Not shown? If the picker has a search box, type to filter, wait for
        //    fresh results to render, then retry. (Never type into the trigger —
        //    it's read-only and .fill() would hang for the full timeout.)
        if (!clicked && picker.search.length) {
          const search = await this.firstVisible(page, picker.search);
          if (search) {
            await search.fill(value).catch(() => {});
            await page.waitForTimeout(900);
            await page.waitForSelector(picker.optionCss, { state: "visible", timeout: 6000 }).catch(() => {});
            await page.waitForTimeout(300);
            clicked = await this.clickOption(page, picker.optionCss, candidates);
          }
        }
        if (clicked) {
          picked.push(value);
          await page.waitForTimeout(500);
        }
      }

      // On failure, snapshot the picker's options BEFORE closing it — this is the
      // quickest way to see what to fix in selectors.ts when Vinted changes a
      // field. (DEBUG only; run with VINTED_DEBUG=1.)
      if (!picked.length && DEBUG) {
        const diag = await page
          .evaluate((css) => {
            const vis = (el: Element) => {
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
            };
            const all = [...document.querySelectorAll(css)];
            const v = all.filter(vis);
            return { total: all.length, visible: v.length, samples: v.slice(0, 8).map((e) => (e.textContent || "").trim().slice(0, 25)) };
          }, picker.optionCss)
          .catch(() => null);
        const shot = await this.snap(page, `pick-fail-${field}`);
        console.error(`[vinted] ${field}: no match for [${values.join(", ")}] — options ${JSON.stringify(diag)} shot=${shot}`);
      }

      // Always dismiss the dropdown before the next field — an open overlay can
      // swallow the next trigger's click and cascade failures down the form. The
      // brand search dropdown ignores Escape, so also click in the page margin
      // (a click-outside) to force it closed.
      await page.keyboard.press("Escape").catch(() => {});
      await page.mouse.click(8, 400).catch(() => {});
      await page.waitForTimeout(400);

      if (!picked.length) return { field, status: "failed", detail: `none of [${values.join(", ")}] matched` };
      return {
        field,
        status: picked.length === values.length ? "ok" : "failed",
        detail: `selected: ${picked.join(", ")}`,
      };
    } catch (e) {
      return { field, status: "failed", detail: String(e).slice(0, 200) };
    }
  }

  /** Parcel size is three cells (Small / Medium / Large); click the matching one. */
  private async selectPackageSize(page: Page, size: string): Promise<FieldResult> {
    const field = "parcelSize";
    try {
      const word = PACKAGE.word[size] || PACKAGE.word.small;
      const clicked = await page.evaluate(
        ({ cellCss, sizeWord }) => {
          const vis = (el: Element) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
          };
          const cells = [...document.querySelectorAll(cellCss)].filter(vis);
          const m = cells.find((e) => (e.textContent || "").toLowerCase().includes(sizeWord.toLowerCase()));
          if (m) { (m as HTMLElement).click(); return true; }
          return false;
        },
        { cellCss: PACKAGE.cell, sizeWord: word }
      );
      if (!clicked) return { field, status: "skipped", detail: `no '${word}' package cell found` };
      await page.waitForTimeout(400);
      return { field, status: "ok", detail: `selected ${word}` };
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

  /**
   * Return links to current drafts. Drafts live on the signed-in member's
   * profile under the "Drafts" filter, as item cards linking to /items/<id>/edit.
   */
  async listDrafts(): Promise<{ url: string; title: string }[]> {
    const page = await this.page();
    const profileHref = await this.memberProfileHref(page);
    if (DEBUG) console.error(`[vinted] listDrafts: profile href = ${profileHref}`);
    if (!profileHref) return [];
    await this.navigate(page, profileHref);
    await this.dismissCookieBanner(page);
    await page.waitForTimeout(2500); // let the wardrobe items render
    // Switch the wardrobe to the Drafts filter.
    const draftsTab = await this.firstVisible(page, [
      '[data-testid="closet-seller-filters-draft"]',
      'button:has-text("Drafts")',
      'a:has-text("Drafts")',
    ]);
    if (draftsTab) {
      await draftsTab.click().catch(() => {});
      await page.waitForTimeout(2500);
    }
    return await page.evaluate(() => {
      const vis = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      const seen = new Set<string>();
      const out: { url: string; title: string }[] = [];
      for (const a of [...document.querySelectorAll('a[href*="/items/"][href*="/edit"]')].filter(vis)) {
        const href = a.getAttribute("href") || "";
        const id = href.match(/\/items\/(\d+)/)?.[1];
        const title = (a.getAttribute("title") || a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
        if (!id || seen.has(id) || /^(finish editing|sell now)$/i.test(title)) continue;
        seen.add(id);
        out.push({ url: location.origin + href, title: title || "(untitled draft)" });
      }
      return out;
    });
  }

  /**
   * The signed-in member's profile path (/member/<id>). The id is in the session
   * cookie `v_uid` — far more robust than scraping the header menu, whose dropdown
   * loads lazily and often isn't open when we look. (`last_user_id` is just a
   * counter, e.g. "1", so we guard on a realistic id length.)
   */
  private async memberProfileHref(page: Page): Promise<string | null> {
    const cookies = await this.vintedCookies();
    const idCookie =
      cookies.find((c) => /^v_uid$/i.test(c.name) && /^\d{5,}$/.test(c.value)) ||
      cookies.find((c) => /^last_user_id$/i.test(c.name) && /^\d{5,}$/.test(c.value));
    if (idCookie) return `/member/${idCookie.value}`;
    // Fallback: scrape the user menu on the home page.
    await this.navigate(page, URLS.home);
    await this.dismissCookieBanner(page);
    const menu = page.locator('[data-testid="user-menu-button"]').first();
    await menu.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    await menu.click().catch(() => {});
    await page.waitForTimeout(1200);
    const href = await page.evaluate(() => {
      const a = [...document.querySelectorAll("a[href]")].find((el) => /^\/member\/\d+(\?|$)/.test(el.getAttribute("href") || ""));
      return a ? a.getAttribute("href") : null;
    });
    return href ? href.replace(/\?.*$/, "") : null;
  }
}
