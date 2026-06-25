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

  /** Listing title, e.g. "Nike Air Max 90 — UK 9 — White/Grey". Keep it searchable. */
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
