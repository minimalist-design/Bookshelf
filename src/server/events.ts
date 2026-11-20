import type { ServerEvent } from "../shared/types.ts";

type Listener = (event: ServerEvent) => void;

/** In-process pub/sub; the HTTP server forwards events to WebSocket clients. */
export interface EventBus {
  /** Returns the function that unsubscribes. */
  subscribe(fn: Listener): () => void;
  emit(event: ServerEvent): void;
  /** Coalesce bursts of library changes into one event (~250 ms). */
  libraryChanged(bookIds: Iterable<number>): void;
}

const COALESCE_MS = 250;

export function createEventBus(): EventBus {
  const listeners = new Set<Listener>();
  const pendingChanged = new Set<number>();
  let changedTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = (event: ServerEvent) => {
    for (const fn of listeners) {
      try {
        fn(event);
      } catch (err) {
        console.error("Event listener failed:", err);
      }
    }
  };

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit,
    libraryChanged(bookIds) {
      for (const id of bookIds) pendingChanged.add(id);
      if (changedTimer) return;
      changedTimer = setTimeout(() => {
        const ids = [...pendingChanged];
        pendingChanged.clear();
        changedTimer = null;
        emit({ type: "library.changed", bookIds: ids });
      }, COALESCE_MS);
    },
  };
}
