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

/**
 * Plausible original DOIs for a filename token, most likely first. Used by
 * lookups to retry when the first guess is not found (suffixes may contain `/`).
 */
export function doiCandidatesFromFilename(token: string): string[] {
  const m = /^(10\.\d{4,9})_(.+)$/.exec(token.trim());
  if (!m) return [];
  const [, prefix, suffix] = m as unknown as [string, string, string];
  return [`${prefix}/${suffix}`, ...(suffix.includes("_") ? [`${prefix}/${suffix.replace(/_/g, "/")}`] : [])];
}
