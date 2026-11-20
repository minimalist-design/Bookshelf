/**
 * Finding books whose title and authors were stored the wrong way round (from "Title - Author"
 * filenames read as "Author - Title", or swapped PDF metadata). Pure functions: no I/O.
 */
import { splitAuthors } from "../naming/authors.ts";
import { orientationOf, personNameScore, type KnownAuthor } from "../naming/nameShape.ts";
import type { ParsedFilename } from "../naming/parseFilename.ts";
import type { SwapSuspectDto } from "../../shared/types.ts";
import { foldKey } from "./similarity.ts";

export interface SwapCandidate {
  id: number;
  title: string;
  authors: readonly string[];
  /** Filenames (relative paths) of the book's files on disk. */
  files: readonly string[];
}

const sameNames = (a: readonly string[], b: readonly string[]) =>
  a.length > 0 && a.length === b.length && a.every((x, i) => foldKey(x) === foldKey(b[i]!));

/**
 * Whether a book looks swapped, and the fix. A file whose name, read again, gives the book's
 * fields the other way round is the surest sign (and keeps the title as written: "Pride and
 * Prejudice", not "Pride, Prejudice"); otherwise the shapes of the two fields must say so
 * clearly. `parse` and `isKnownAuthor` should not count the book's own authors as known, or a
 * stored mix-up would vouch for itself.
 */
export function swapSuspect(
  book: SwapCandidate,
  parse: (filename: string) => ParsedFilename,
  isKnownAuthor?: KnownAuthor,
): SwapSuspectDto | null {
  if (!book.authors.length || !book.title.trim()) return null;
  const titleAsNames = splitAuthors(book.title);

  const reread = book.files
    .map((rel) => parse(rel.slice(rel.lastIndexOf("/") + 1)))
    .find((p) => p.title !== null && sameNames(p.authors, titleAsNames) && sameNames(splitAuthors(p.title), book.authors));
  const base = { id: book.id, title: book.title, authors: [...book.authors], files: [...book.files] };
  if (reread) return { ...base, proposed: { title: reread.title!, authors: reread.authors }, basis: "filename" };

  const titleScore = personNameScore(book.title, isKnownAuthor);
  const authorsScore = personNameScore(book.authors.join("; "));
  if (orientationOf(titleScore, authorsScore) !== "first-is-author" || !titleAsNames.length) return null;
  return { ...base, proposed: { title: book.authors.join(", "), authors: titleAsNames }, basis: "swap" };
}
