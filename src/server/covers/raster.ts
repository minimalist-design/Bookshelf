import { inflateSync } from "node:zlib";

/**
 * Small raster helpers that fill the gaps in `Bun.Image`: it cannot read raw pixels (DjVu pages arrive as PPM) and
 * it drops alpha instead of compositing when encoding JPEG. Both are bridged through uncompressed 24-bit BMP, which
 * `Bun.Image` decodes.
 */

/** Wrap packed 8-bit RGB pixels (top-down rows) in a 24-bit BMP. */
export function rgbToBmp(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const stride = (width * 3 + 3) & ~3;
  const size = 54 + stride * height;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; // "BM"
  out[1] = 0x4d;
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true); // pixel data offset
  dv.setUint32(14, 40, true); // BITMAPINFOHEADER
  dv.setInt32(18, width, true);
  dv.setInt32(22, height, true); // positive → bottom-up rows
  dv.setUint16(26, 1, true); // planes
  dv.setUint16(28, 24, true); // bits per pixel
  dv.setUint32(34, stride * height, true);
  for (let y = 0; y < height; y++) {
    const src = y * width * 3;
    const dst = 54 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      out[dst + x * 3] = rgb[src + x * 3 + 2]!;
      out[dst + x * 3 + 1] = rgb[src + x * 3 + 1]!;
      out[dst + x * 3 + 2] = rgb[src + x * 3]!;
    }
  }
  return out;
}

interface DecodedPng {
  width: number;
  height: number;
  /** 1 = grey, 2 = grey+alpha, 3 = RGB, 4 = RGBA; always 8 bits per channel. */
  channels: number;
  pixels: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Minimal PNG decoder for the PNGs `Bun.Image` itself encodes: non-interlaced, non-palette, 8 or 16 bits per
 * channel (16-bit samples are reduced to their high byte). Returns null for anything else.
 */
export function decodePng(png: Uint8Array): DecodedPng | null {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (png.length < 33 || dv.getUint32(0) !== 0x89504e47) return null;
  let width = 0, height = 0, depth = 0, colorType = -1, interlace = 0;
  const idat: Uint8Array[] = [];
  for (let pos = 8; pos + 8 <= png.length; ) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(png[pos + 4]!, png[pos + 5]!, png[pos + 6]!, png[pos + 7]!);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(pos + 8);
      height = dv.getUint32(pos + 12);
      depth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const channels = CHANNELS[colorType];
  if (!channels || (depth !== 8 && depth !== 16) || interlace !== 0 || !width || !height) return null;

  const bpp = channels * (depth / 8); // bytes per pixel in the filtered stream
  const rowLen = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (rowLen + 1) * height) return null;

  const cur = new Uint8Array(rowLen);
  const prev = new Uint8Array(rowLen);
  const pixels = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const off = y * (rowLen + 1);
    const filter = raw[off]!;
    for (let i = 0; i < rowLen; i++) {
      const x = raw[off + 1 + i]!;
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: return null;
      }
      cur[i] = v & 0xff;
    }
    const step = depth / 8;
    for (let i = 0, o = y * width * channels; i < rowLen; i += step, o++) pixels[o] = cur[i]!;
    prev.set(cur);
  }
  return { width, height, channels, pixels };
}

/** Composite a decoded PNG onto a white background and return BMP bytes (RGB). */
export function flattenOnWhite(img: DecodedPng): Uint8Array {
  const { width, height, channels, pixels } = img;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, o = 0; o < rgb.length; i += channels, o += 3) {
    const grey = channels <= 2;
    const r = pixels[i]!, g = grey ? r : pixels[i + 1]!, b = grey ? r : pixels[i + 2]!;
    const alpha = channels === 2 ? pixels[i + 1]! : channels === 4 ? pixels[i + 3]! : 255;
    const inv = 255 - alpha;
    rgb[o] = Math.round((r * alpha + 255 * inv) / 255);
    rgb[o + 1] = Math.round((g * alpha + 255 * inv) / 255);
    rgb[o + 2] = Math.round((b * alpha + 255 * inv) / 255);
  }
  return rgbToBmp(rgb, width, height);
}
