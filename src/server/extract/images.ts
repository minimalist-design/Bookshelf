import type { CoverImage } from "../metadata/types.ts";

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp|tiff?|jxl)$/i;

export function isImageName(name: string): boolean {
  return IMAGE_EXT.test(name) && !name.split("/").some((seg) => seg.startsWith(".") || seg === "__MACOSX");
}

export function cover(data: Uint8Array): CoverImage | null {
  return data.byteLength > 0 ? { data } : null;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural sort of archive paths ("page2" before "page10"). */
export function naturalSort(names: readonly string[]): string[] {
  return names.toSorted(collator.compare);
}
