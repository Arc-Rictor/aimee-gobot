/**
 * Vinted listing data model.
 *
 * This is the shape Claude fills in from your photos (plus any notes you give it).
 * Everything except `photos`, `title`, `description`, `category`, `condition` and
 * `price` is optional — Vinted will still accept a draft with the basics, and you
 * can refine the rest in the review step.
 *
 * The connector only ever drives the *UK* site (vinted.co.uk), so sizes, prices
 * and the category tree are all UK/GBP.
 */

import { z } from "zod";

/** Vinted's fixed condition ladder, exactly as the labels appear on vinted.co.uk. */
export const VINTED_CONDITIONS = [
  "New with tags",
  "New without tags",
  "Very good",
  "Good",
  "Satisfactory",
] as const;
export type VintedCondition = (typeof VINTED_CONDITIONS)[number];

/** Parcel size buckets shown on the listing form (drives the shipping price band). */
export const VINTED_PARCEL_SIZES = ["small", "medium", "large"] as const;
export type VintedParcelSize = (typeof VINTED_PARCEL_SIZES)[number];

export const ListingSchema = z.object({
  /**
   * Absolute paths to the photos for this item, in display order.
   * The first photo becomes the cover image. 1–20 photos (Vinted's limit).
   */
  photos: z.array(z.string().min(1)).min(1).max(20),

  /**
   * Listing title, e.g. "Nike Air Max 90 Trainers UK 9 White Grey". Keep it
   * searchable, and avoid em-dashes (—), slashes and other symbol runs: Vinted
   * rejects symbol-heavy titles server-side ("Title contains too many symbol
   * characters") and the draft won't save.
   */
  title: z.string().min(3).max(100),

  /** Full description. Mention flaws honestly — it reduces returns/disputes. */
  description: z.string().min(1).max(3000),

  /**
   * Category path from broad to specific, e.g.
   * ["Men", "Shoes", "Trainers"] or ["Women", "Clothing", "Dresses"].
   * The connector walks Vinted's category picker level by level using these labels.
   */
  category: z.array(z.string().min(1)).min(1),

  condition: z.enum(VINTED_CONDITIONS),

  /** Price in GBP (pounds). e.g. 24.5 → £24.50. */
  price: z.number().positive().max(100000),

  /** Brand name as it appears in Vinted's brand search, e.g. "Nike". Optional. */
  brand: z.string().optional(),

  /** Size label exactly as Vinted lists it for the category, e.g. "UK 9", "M", "10". */
  size: z.string().optional(),

  /** Up to 2 colours, e.g. ["White", "Grey"]. */
  colors: z.array(z.string()).max(2).optional(),

  /** Optional material, e.g. "Cotton". */
  material: z.string().optional(),

  /** Parcel size band; defaults to "small" if omitted. */
  parcelSize: z.enum(VINTED_PARCEL_SIZES).default("small"),

  /** Free-form notes from you to Claude (not sent to Vinted) — e.g. "small mark on left sleeve". */
  notes: z.string().optional(),
});

export type Listing = z.infer<typeof ListingSchema>;

/**
 * Input shape for the MCP `create_draft` tool. Same as a Listing but photos may
 * be given as a `photoDir` folder instead of explicit paths — handy when driving
 * from Claude Desktop, where you'd rather name a folder than list every file.
 * One of `photos` or `photoDir` is required; resolved into `photos` server-side.
 */
export const DraftInputSchema = ListingSchema.extend({
  photos: z.array(z.string().min(1)).max(20).optional()
    .describe("Explicit photo paths, in display order (first = cover). Omit if using photoDir."),
  photoDir: z.string().optional()
    .describe("Folder of photos to use automatically, sorted by filename. Alternative to listing photos."),
});

export type DraftInput = z.infer<typeof DraftInputSchema>;

/** Per-field outcome reported back after a draft attempt, so the human review is informed. */
export interface FieldResult {
  field: string;
  status: "ok" | "skipped" | "failed";
  detail?: string;
}

export interface DraftResult {
  /** Whether the draft was saved on Vinted. */
  saved: boolean;
  /** URL of the saved draft, when known. */
  draftUrl?: string;
  /** Path to a screenshot of the final form state, for the human to eyeball. */
  screenshotPath?: string;
  /** Field-by-field outcome. */
  fields: FieldResult[];
  /** Human-readable summary. */
  summary: string;
}

/** One comparable listing found while researching a price. */
export interface PriceComparable {
  title: string;
  brand?: string;
  condition?: string;
  size?: string;
  /** Base listing price in GBP (what the seller set — buyer protection is added on top). */
  price: number;
  url: string;
}

/**
 * Result of researching a price from comparable *active* Vinted listings (asking
 * prices, not sold prices — so they skew a little high). Claude turns this into a
 * recommendation in conversation; the suggestion bands are a starting point.
 */
export interface ResearchResult {
  query: string;
  /** The catalog search URL used. */
  url: string;
  /** Total comparable cards sampled from the search. */
  sampled: number;
  /** How many were used for the stats (after any size/condition filter). */
  used: number;
  filteredBy?: { size?: string; condition?: string };
  /** Price distribution of the used comparables (GBP), or null if none found. */
  stats: { min: number; p25: number; median: number; p75: number; max: number } | null;
  /** Suggested price bands derived from the distribution (GBP), or null. */
  suggestion: { quickSale: number; market: number; topEnd: number } | null;
  /** A sample of the comparables behind the numbers. */
  comparables: PriceComparable[];
  /** Human-readable caveat about what the numbers mean. */
  note: string;
}
