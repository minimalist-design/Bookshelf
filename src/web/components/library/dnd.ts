import type { DragEvent } from "react";

/** Internal drag type for moving books onto shelves (distinct from OS file drops). */
export const BOOK_DRAG_TYPE = "application/x-bookshelf-books";

export function startBookDrag(e: DragEvent, ids: number[], label: string): void {
  e.dataTransfer.setData(BOOK_DRAG_TYPE, JSON.stringify(ids));
  e.dataTransfer.setData("text/plain", label);
  e.dataTransfer.effectAllowed = "move";
}

export function isBookDrag(e: DragEvent): boolean {
  return e.dataTransfer.types.includes(BOOK_DRAG_TYPE);
}

export function readBookDrag(e: DragEvent): number[] {
  try {
    const ids = JSON.parse(e.dataTransfer.getData(BOOK_DRAG_TYPE));
    return Array.isArray(ids) ? ids.filter((x) => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}
