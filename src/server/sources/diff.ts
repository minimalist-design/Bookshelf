import type { BookRecord } from "../db/repo/books.ts";
import { METADATA_FIELDS, type CandidateMetadata, type DiffStatus, type FieldDiff, type MetadataField } from "../../shared/types.ts";

type Value = string | number | string[] | null;

function isEmpty(v: Value | undefined): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Comparison key: case/whitespace/punctuation-insensitive for text, order-insensitive for tag sets. */
function key(field: MetadataField, v: Value): string {
  if (Array.isArray(v)) {
    const items = v.map((x) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim());
    return JSON.stringify(field === "tags" ? [...items].sort() : items);
  }
  if (typeof v === "number") return String(v);
  const s = (v ?? "").toLowerCase();
  if (field === "doi" || field === "isbn13" || field === "language") return s.trim();
  return s.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Field-by-field comparison of the book's metadata with a candidate. */
export function diffMetadata(book: BookRecord, candidate: CandidateMetadata): FieldDiff[] {
  return METADATA_FIELDS.map((field) => {
    const current = (book[field] ?? null) as Value;
    const cand = (candidate[field] ?? null) as Value;
    let status: DiffStatus;
    if (isEmpty(cand)) status = "missing";
    else if (isEmpty(current)) status = "fill";
    else if (key(field, current) === key(field, cand)) status = "same";
    else if (field === "publishedDate" && String(cand).startsWith(String(current)) && String(cand).length > String(current).length) status = "fill"; // more precise date
    else status = "conflict";
    return { field, current, candidate: cand, status };
  });
}
