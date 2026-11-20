import type { MetadataCandidate } from "./types.ts";

/** DOI work types that are a whole book (Crossref types and CSL's `book`, dashes as spaces). */
const BOOK_KINDS: ReadonlySet<string> = new Set(["book", "monograph", "edited book", "reference book", "book set", "book series"]);

/**
 * The work's type, e.g. "journal article". Candidates queued before `workType` existed only
 * carry it in their label ("Crossref · journal article · Journal · 2019"). Without a type the
 * second part is the journal or the year, so only lowercase words count as a type, as all
 * Crossref and CSL types are.
 */
function doiKind(c: MetadataCandidate): string | null {
  if (c.workType) return c.workType.replace(/-/g, " ");
  const [via, kind] = c.label.split(" · ");
  return (via === "Crossref" || via === "DOI registry") && kind && /^[a-z]+( [a-z]+)*$/.test(kind) ? kind : null;
}

/**
 * What a DOI record is when it isn't a book (an article, a conference paper, a chapter…),
 * a sign the file was misidentified; null for books and for records of unknown type.
 */
export function paperKind(c: MetadataCandidate): string | null {
  if (c.source !== "doi") return null;
  const kind = doiKind(c);
  return kind && !BOOK_KINDS.has(kind) ? kind : null;
}
