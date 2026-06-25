/**
 * Centralised Vinted UK selectors.
 *
 * ⚠️  Vinted ships UI changes without notice and does not publish a stable API.
 * Every field below lists *several* candidate selectors and the client tries them
 * in order, preferring accessible roles/labels (which change less often) over CSS
 * classes. When the site changes, this is the ONE file you edit — run the
 * connector with VINTED_DEBUG=1 to capture screenshots that show what broke.
 *
 * Verified against the vinted.co.uk "List an item" form layout; treat as a
 * starting point and tune on your first real run (see docs/vinted.md).
 */

export const URLS = {
  home: "/",
  newItem: "/items/new",
  memberItems: "/member/items",
  draftsHint: "/member/items?status=drafts",
};

/** Signals that we're logged in (any one present ⇒ authenticated). */
export const LOGGED_IN_SIGNALS = [
  '[data-testid="header--user-menu-button"]',
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
  // The <input type=file>. Vinted keeps it in the DOM even when hidden, so
  // setInputFiles works without clicking the drop-zone first.
  photoInput: [
    'input[type="file"][accept*="image"]',
    '[data-testid="photo-uploader"] input[type="file"]',
    'input[type="file"]',
  ],

  title: {
    css: ['#title', 'input[name="title"]', '[data-testid="title--input"] input'],
    byLabel: ["Title"],
  },

  description: {
    css: [
      "#description",
      'textarea[name="description"]',
      '[data-testid="description--input"] textarea',
    ],
    byLabel: ["Describe your item"],
  },

  price: {
    css: ['#price', 'input[name="price"]', '[data-testid="price-input--input"] input'],
    byLabel: ["Price"],
  },

  // These open a picker (drawer/dropdown) when clicked.
  categoryTrigger: [
    '[data-testid="catalog-select-dropdown-input"]',
    'button:has-text("Category")',
    'div:has-text("Category") input',
    '#catalog_id',
  ],
  brandTrigger: [
    '[data-testid="brand-select-dropdown-input"]',
    '#brand_id',
    'button:has-text("Brand")',
    'input[placeholder*="brand" i]',
  ],
  sizeTrigger: [
    '[data-testid="size-select-dropdown-input"]',
    '#size_id',
    'button:has-text("Size")',
  ],
  conditionTrigger: [
    '[data-testid="condition-select-dropdown-input"]',
    '#status_id',
    'button:has-text("Condition")',
  ],
  colorTrigger: [
    '[data-testid="color-select-dropdown-input"]',
    '#color',
    'button:has-text("Colour")',
    'button:has-text("Color")',
  ],
  materialTrigger: [
    '[data-testid="material-select-dropdown-input"]',
    'button:has-text("Material")',
  ],
  parcelTrigger: [
    '[data-testid="package-size-select-dropdown-input"]',
    'button:has-text("Parcel size")',
    'button:has-text("Package size")',
  ],
};

/**
 * Inside an open picker/drawer: the search box and the option rows.
 * Options are matched by visible text (case-insensitive) by the client.
 */
export const PICKER = {
  searchInput: [
    '[data-testid="search-input"]',
    'input[type="search"]',
    'input[placeholder*="Search" i]',
  ],
  // A single selectable row/option within the open list.
  option: (label: string) => [
    `[role="option"]:has-text("${label}")`,
    `[data-testid*="dropdown"] li:has-text("${label}")`,
    `label:has-text("${label}")`,
    `button:has-text("${label}")`,
  ],
  // "Done"/confirm button some multi-select drawers use.
  confirm: ['button:has-text("Done")', 'button:has-text("Add")', 'button:has-text("Save")'],
};

/** Buttons that finish the flow. */
export const ACTIONS = {
  // Save the item as a draft (NOT publish). Vinted labels this variously.
  saveDraft: [
    'button:has-text("Save as draft")',
    'button:has-text("Save draft")',
    'button:has-text("Save for later")',
    '[data-testid="item-save-draft-button"]',
  ],
  // Publish/upload the item live.
  publish: [
    'button:has-text("Upload")',
    'button:has-text("Publish")',
    '[data-testid="item-upload-button"]',
    'button[type="submit"]:has-text("Upload")',
  ],
};
