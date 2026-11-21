const DOI_CORE = /^10\.\d{4,9}\/\S+$/;

/** Normalize a DOI from a URL, `doi:` prefix, etc. Returns null when it is not a DOI. */
export function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw
    .trim()
    .replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, "")
    .replace(/^(urn:)?doi:\s*/i, "")
    .replace(/[.,;]+$/, "");
  return DOI_CORE.test(s) ? s : null;
}

/** Filenames cannot contain `/`: every slash becomes `_`. */
export function doiToFilename(doi: string): string {
  return doi.replace(/\//g, "_");
}

/**
 * Reverse of doiToFilename. Ambiguous by nature: only the first `_` after the
 * `10.NNNN` prefix is turned back into `/`. Already-slashed DOIs pass through.
 */
export function doiFromFilename(token: string): string | null {
  const t = token.trim();
  if (/^10\.\d{4,9}\//.test(t)) return normalizeDoi(t);
  const m = /^(10\.\d{4,9})_(.+)$/.exec(t);
  return m ? normalizeDoi(`${m[1]}/${m[2]}`) : null;
}
