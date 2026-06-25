/**
 * Photo resolution shared by the CLI and the MCP server.
 *
 * Lets a caller specify either explicit `photos` paths OR a `photoDir` folder
 * whose images are picked up automatically (sorted by filename, so 01.jpg,
 * 02.jpg … controls display order and the first becomes the cover).
 */

import { readdirSync, existsSync, statSync } from "fs";
import { join, isAbsolute, resolve } from "path";

export const IMAGE_RE = /\.(jpe?g|png|webp|heic)$/i;

/** Every image file directly inside `dir`, sorted, as absolute paths. */
export function imagesInDir(dir: string): string[] {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  return readdirSync(root)
    .filter((f) => IMAGE_RE.test(f))
    .sort()
    .map((f) => join(root, f));
}

/**
 * Resolve a final ordered list of photo paths from `photos` and/or `photoDir`.
 * `photos` entries are taken relative to `photoDir` (or cwd) when not absolute.
 * Throws if nothing resolves.
 */
export function resolvePhotos(input: { photos?: string[]; photoDir?: string }): string[] {
  const base = input.photoDir ? resolve(input.photoDir) : undefined;
  let photos = input.photos ?? [];
  if (photos.length) {
    photos = photos.map((p) => (isAbsolute(p) ? p : join(base ?? process.cwd(), p)));
  } else if (base) {
    photos = imagesInDir(base);
  }
  if (!photos.length) {
    throw new Error(
      `No photos found. Provide "photos" paths or a "photoDir" containing images (${IMAGE_RE}).`
    );
  }
  return photos;
}
