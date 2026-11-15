import type { Location } from "react-router";

/**
 * Router state carried from a library view into a book's page (and through its reader and back),
 * so the book page's Back button returns to the shelf/view the book was opened from.
 */
export interface ReturnState {
  from: string;
}

/** State to attach to a link opening a book from the library view at `location`. */
export function returnState(location: Pick<Location, "pathname" | "search">): ReturnState {
  return { from: location.pathname + location.search };
}

/** Where a book page's Back goes: the library view it was opened from, else All books. */
export function returnUrl(state: unknown): string {
  const from = (state as Partial<ReturnState> | null)?.from;
  return typeof from === "string" && (from === "/" || from.startsWith("/?")) ? from : "/";
}
