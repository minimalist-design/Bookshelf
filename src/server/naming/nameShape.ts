/**
 * Telling a person's name from a book title by its shape, so "Title - Author" filenames and
 * swapped metadata fields can be put the right way round. Pure functions: no I/O.
 *
 * Scores are positive for name-like text and negative for title-like text; near zero means
 * the text could be either ("Emma", "Brave New World").
 */
import { splitAuthors } from "./authors.ts";

/** Optional: whether a name is already an author in the library (the strongest hint there is). */
export type KnownAuthor = (name: string) => boolean;

/** Lowercase words allowed inside names. */
const PARTICLES = new Set([
  "van", "von", "der", "den", "de", "del", "della", "di", "da", "du", "la", "le", "ter", "ten", "bin", "ibn", "al",
  "y", "e", "dos", "das", "do", "zu", "st.",
]);
/** Words that start titles, never names ("Le", "La", "De" start surnames too, so they are not here). */
const LEADING_ARTICLES = new Set(["the", "an", "der", "die", "das", "a"]);
/** Function words: lowercase or capitalised in the middle of a string, they belong to titles. */
const FUNCTION_WORDS = new Set([
  "of", "the", "and", "in", "to", "for", "on", "with", "a", "an", "from", "at", "by", "or", "into", "about", "how",
  "what", "why", "is", "are", "your", "my", "our", "its", "not", "no", "vs",
]);
/** Words common in titles and rare in names. */
const TITLE_WORDS = new Set([
  "introduction", "guide", "handbook", "manual", "history", "theory", "principles", "volume", "vol", "part", "book",
  "edition", "ed", "chapter", "programming", "language", "languages", "learning", "learn", "beginners", "complete",
  "essential", "essentials", "fundamentals", "basics", "practical", "advanced", "modern", "art", "science", "analysis",
  "design", "notes", "lectures", "lecture", "course", "primer", "tutorial", "companion", "collection", "selected",
  "works", "stories", "poems", "novel", "series", "world", "life", "love", "war", "how", "using", "applied",
  "mathematics", "physics", "chemistry", "biology", "economics", "philosophy", "encyclopedia", "dictionary", "atlas",
  "cookbook", "reference", "systems", "system", "methods", "approach", "foundations", "elements", "proceedings",
  "journal", "review", "report", "thesis", "dissertation", "category", "categories", "algebra", "calculus", "geometry",
]);

const INITIAL = /^\p{Lu}\.?$|^(\p{Lu}\.){2,}$/u;
const CAPITALISED = /^\p{Lu}[\p{L}'’.-]*$/u;
const ROMAN = /^(?:[IVX]+|[ivx]+)$/;

/** "The Republic", "A gentle introduction" — but not "A. Smith" or "A J Smith". */
function leadingArticle(tokens: string[], lower: string[]): boolean {
  if (tokens.length < 2 || !LEADING_ARTICLES.has(lower[0]!) || /\.$/.test(tokens[0]!)) return false;
  return lower[0] !== "a" || (tokens.length > 2 && !INITIAL.test(tokens[1]!));
}

export const NAME_SCORE = { clearlyName: 2, clearlyTitle: -2 } as const;

/**
 * All-lowercase or all-capitals text carries no case hints ("jane austen", "PRIDE AND PREJUDICE"):
 * it is scored as if written in title case, with function words and particles in lowercase.
 */
function recase(text: string): string {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return text;
  return text
    .toLowerCase()
    .split(" ")
    .map((w, i) => (i > 0 && (FUNCTION_WORDS.has(w) || PARTICLES.has(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Shape score of one person's name (already split from a list, in display order). In a list,
 * one-word members ("Pride and Prejudice" → "Pride", "Prejudice") count against it, since
 * co-authors are rarely given by one name.
 */
function scoreOne(original: string, inList: boolean, isKnownAuthor?: KnownAuthor): number {
  const name = recase(original);
  const tokens = name.split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  const lower = tokens.map((t) => t.toLowerCase().replace(/[.,]+$/, ""));

  const penalties =
    (tokens.length > 4 ? 3 + (tokens.length - 5) : 0) +
    tokens.reduce((sum, t, i) => {
      const w = lower[i]!;
      if (/\d/.test(t) && !ROMAN.test(t)) return sum + 3;
      if (TITLE_WORDS.has(w)) return sum + 3;
      if (FUNCTION_WORDS.has(w) && !(PARTICLES.has(w) && i > 0) && !(i === 0 && INITIAL.test(t))) return sum + 2;
      if (/^\p{Ll}/u.test(t) && !PARTICLES.has(w)) return sum + 2;
      return sum;
    }, 0) +
    (leadingArticle(tokens, lower) ? 2 : 0) +
    (/[:?!"“”«»()]/.test(name) ? 3 : 0);

  const allNameTokens = tokens.every((t, i) => INITIAL.test(t) || CAPITALISED.test(t) || (i > 0 && PARTICLES.has(lower[i]!)));
  const initials = tokens.filter((t) => INITIAL.test(t)).length;
  const shape =
    tokens.length === 1
      ? CAPITALISED.test(tokens[0]!) && !INITIAL.test(tokens[0]!) ? 0.5 : 0
      : allNameTokens && tokens.length <= 4
        ? 2 + (initials > 0 && initials < tokens.length ? 1 : 0)
        : 0;

  const plausible = shape - penalties - (inList && tokens.length === 1 ? 1.5 : 0);
  // A known author counts only for names that already lean towards a name: a book whose
  // title was stored as its author must not make that title look like a person.
  const known = isKnownAuthor && plausible > 0 && isKnownAuthor(original) ? 3 : 0;
  return plausible + known;
}

/** How much `s` looks like a list of people's names (positive) or a title (negative); lists by their least name-like member. */
export function personNameScore(s: string | null | undefined, isKnownAuthor?: KnownAuthor): number {
  const raw = s?.replace(/\s+/g, " ").trim();
  if (!raw) return 0;
  const names = splitAuthors(raw);
  if (!names.length) return 0;
  const scores = names.map((n) => scoreOne(n, names.length > 1, isKnownAuthor));
  return Math.min(...scores);
}

export type Orientation = "first-is-author" | "second-is-author";

/**
 * Which of two strings is the author, when their shapes say so clearly: one reads as a name
 * and the other doesn't, or one reads as a title and the other doesn't, with a clear gap
 * between them. `null` when both could be either.
 */
export function orientation(first: string, second: string, isKnownAuthor?: KnownAuthor): Orientation | null {
  return orientationOf(personNameScore(first, isKnownAuthor), personNameScore(second, isKnownAuthor));
}

export function orientationOf(a: number, b: number): Orientation | null {
  const decisive = (author: number, title: number) =>
    author - title >= 2.5 &&
    ((author >= NAME_SCORE.clearlyName && title <= 0.5) || (title <= NAME_SCORE.clearlyTitle && author > 0));
  if (decisive(a, b)) return "first-is-author";
  if (decisive(b, a)) return "second-is-author";
  return null;
}

/** The decisiveness of an orientation (bigger is surer), to choose between several ways of splitting. */
export function orientationMargin(a: number, b: number): number {
  return Math.abs(a - b);
}
