import type { CoverImage } from "../metadata/types.ts";

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp|tiff?|jxl)$/i;

export function isImageName(name: string): boolean {
  return IMAGE_EXT.test(name) && !name.split("/").some((seg) => seg.startsWith(".") || seg === "__MACOSX");
}

export function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (
    { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", jxl: "image/jxl" }[ext] ??
    "application/octet-stream"
  );
}

export function cover(data: Uint8Array, mime: string): CoverImage | null {
  return data.byteLength > 0 ? { data, mime } : null;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural sort of archive paths ("page2" before "page10"). */
export function naturalSort(names: string[]): string[] {
  return [...names].sort(collator.compare);
}
