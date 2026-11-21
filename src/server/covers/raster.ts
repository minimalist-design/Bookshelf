/**
 * `Bun.Image` cannot read raw pixels (DjVu pages arrive as PPM), so they are wrapped in an uncompressed 24-bit BMP,
 * which it decodes.
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
