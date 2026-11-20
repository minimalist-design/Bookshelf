import type { Location } from "react-router";

/**
 * Router state carried from a library view (or Settings) into a book's page (and through its reader
 * and back), so the book page's Back button returns to where the book was opened from.
 */
export interface ReturnState {
  from: string;
}

/** State to attach to a link opening a book from the library view at `location`. */
export function returnState(location: Pick<Location, "pathname" | "search">): ReturnState {
  return { from: location.pathname + location.search };
}

/** Pages other than the library that open books and are worth returning to. */
const RETURN_PAGES = new Set(["/settings", "/review"]);

/** Where a book page's Back goes: the library view, Settings or the review queue it was opened from, else All books. */
export function returnUrl(state: unknown): string {
  const from = (state as Partial<ReturnState> | null)?.from;
  return typeof from === "string" && (from === "/" || from.startsWith("/?") || RETURN_PAGES.has(from.split("?")[0]!)) ? from : "/";
}
