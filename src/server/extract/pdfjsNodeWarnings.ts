/**
 * When pdf.js loads outside a browser it tries to `require("@napi-rs/canvas")`, an optional dependency of
 * pdfjs-dist, to polyfill `DOMMatrix` and `Path2D`. Those are only needed to render pages, and the server never
 * renders (covers come from `pdftoppm`), so the package isn't installed. pdf.js then logs three warnings while
 * it loads, before any `verbosity` option can apply.
 *
 * Importing this module first installs a `console.warn` filter that drops exactly those three messages. The
 * importer calls `restoreConsoleWarn()` once pdf.js has loaded, so no other warning is ever affected.
 */

const SILENCED = ['Cannot load "@napi-rs/canvas"', "Cannot polyfill `DOMMatrix`", "Cannot polyfill `Path2D`"];

const originalWarn = console.warn;

console.warn = (...args: unknown[]) => {
  const [first] = args;
  if (typeof first === "string" && first.startsWith("Warning: ") && SILENCED.some((s) => first.includes(s))) return;
  originalWarn.apply(console, args);
};

/** Puts the original `console.warn` back. */
export function restoreConsoleWarn(): void {
  console.warn = originalWarn;
}
