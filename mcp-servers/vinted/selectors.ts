/**
 * Centralised Vinted UK selectors.
 *
 * ⚠️  Vinted ships UI changes without notice and does not publish a stable API.
 * Each field lists *several* candidate selectors and the client tries them in
 * order, preferring stable `data-testid`s over CSS classes. When the site
 * changes, this is the ONE file you edit — run the connector with VINTED_DEBUG=1
 * to capture screenshots that show what broke.
 *
 * Verified against the live vinted.co.uk "Sell an item" form (see docs/vinted.md
 * §6). The form is a single page; attribute fields (brand/size/condition/colour/
 * material/parcel) only render *after* a category is chosen — they are
 * category-dependent.
 */

export const URLS = {
  home: "/",
  newItem: "/items/new",
  // Drafts live on the member profile under the "Drafts" filter — listDrafts
  // resolves that path at runtime from the user menu (the old /member/items
  // ?status=drafts URL now 404s).
};

/** Signals that we're logged in (any one present ⇒ authenticated). */
export const LOGGED_IN_SIGNALS = [
  '[data-testid="user-menu-button"]',
  'a[href*="/member/general"]',
  'button:has-text("Sell now")',
  'a:has-text("Sell now")',
];

/** Signals that we're on a login/registration wall. */
export const LOGIN_WALL_SIGNALS = [
  '[data-testid="auth-modal"]',
  'input[name="login"]',
  'h2:has-text("Log in")',
];

/**
 * Listing form fields. Each entry is an ordered list of candidate locators.
 * `byLabel` values are matched with Playwright's getByLabel (accessible name).
 */
export const FORM = {
  // The <input type=file>. Vinted keeps it hidden (class "u-hidden") in the DOM,
  // so setInputFiles works without clicking the drop-zone first. Its presence
  // also proves the SPA sell-form has finished rendering (see formReady).
  photoInput: [
    '[data-testid="add-photos-input"]',
    'input[type="file"][accept*="image"]',
    'input[type="file"]',
  ],
  // Any one of these existing ⇒ the sell form has mounted (used to wait out the
  // initial SPA loading spinner before we touch the form).
  formReady: [
    '[data-testid="add-photos-input"]',
    '[data-testid="title--input"]',
    "#title",
  ],

  title: {
    css: ["#title", '[data-testid="title--input"]', 'input[name="title"]'],
    byLabel: ["Title"],
  },

  description: {
    css: ["#description", '[data-testid="description--input"]', 'textarea[name="description"]'],
    byLabel: ["Describe your item", "Description"],
  },

  price: {
    css: ["#price", '[data-testid="price-input--input"]', 'input[name="price"]'],
    byLabel: ["Price"],
  },

  // Triggers that open a picker (dropdown/list/grid) when clicked.
  categoryTrigger: ['[data-testid="catalog-select-dropdown-input"]', "#category"],
  brandTrigger: ['[data-testid="brand-select-dropdown-input"]', "#brand"],
  sizeTrigger: ['[data-testid="category-size-single-grid-input"]', "#size"],
  conditionTrigger: ['[data-testid="category-condition-single-list-input"]', "#condition"],
  colorTrigger: ['[data-testid="color-select-dropdown-input"]', "#color"],
  materialTrigger: ['[data-testid="category-material-multi-list-input"]', "#material"],
};

/**
 * Category picker — search-driven and hierarchical. Open the trigger, type the
 * *leaf* category into the search box, then click the result row whose path
 * matches. Result rows read "<Leaf><Parents>", e.g. "TrainersMen > Shoes".
 */
export const CATEGORY = {
  searchInput: [
    "#catalog-search-input",
    '[data-testid="catalog-search-input"]',
    'input[name="catalog-search-input"]',
    'input[placeholder*="category" i]',
  ],
  resultRow: '[id^="catalog-search-"][id$="-result"]',
};

/**
 * Per-attribute option scopes inside an open picker. `optionCss` selects the
 * clickable option rows (role=button/checkbox), `search` is the in-dropdown
 * search box (if any), `multi` means the dropdown stays open after a pick (so we
 * Escape to close it), `typeInTrigger` means filter by typing into the trigger
 * itself rather than a separate search box.
 */
export const PICKERS = {
  condition: {
    optionCss: '[role="button"][data-testid^="condition-"]:not([data-testid*="radio"])',
    search: [] as string[],
    multi: false,
  },
  brand: {
    // Brand SEARCH-result rows are `<div role="button">` inside the dropdown
    // content WITHOUT per-option testids (only the popular list uses brand-<id>),
    // so scope to the content container and match the role=button rows by text.
    optionCss: '[data-testid="brand-select-dropdown-content"] [role="button"]',
    search: ["#brand-search-input", '[data-testid="brand-search--input"]'],
    multi: false,
  },
  size: {
    optionCss: '[data-testid*="grid-option-"]',
    search: [] as string[],
    multi: false,
  },
  color: {
    optionCss: '[role="button"][data-testid^="color-"]:not([data-testid*="checkbox"]):not([data-testid*="dropdown"])',
    search: [] as string[],
    multi: true,
  },
  material: {
    optionCss: '[role="button"][data-testid^="material-"]:not([data-testid*="checkbox"])',
    search: ["#material-search-input", '[data-testid="material-search--input"]'],
    multi: true,
  },
};

/**
 * Parcel/package size is three selectable cells (Small / Medium / Large), not a
 * dropdown. Match the cell whose text contains the size word.
 */
export const PACKAGE = {
  cell: '[data-testid$="-package-size--cell"]',
  word: { small: "Small", medium: "Medium", large: "Large" } as Record<string, string>,
};

/** Buttons that finish the flow. */
export const ACTIONS = {
  // Save the item as a draft (NOT publish).
  saveDraft: [
    '[data-testid="upload-form-save-draft-button"]',
    'button:has-text("Save draft")',
    'button:has-text("Save as draft")',
    'button:has-text("Save for later")',
  ],
  // Publish/upload the item live.
  publish: [
    '[data-testid="upload-form-save-button"]',
    'button:has-text("Upload")',
    'button:has-text("Publish")',
  ],
};
