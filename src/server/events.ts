import type { ServerEvent } from "../shared/types.ts";

type Listener = (event: ServerEvent) => void;

/** In-process pub/sub; the HTTP server forwards events to WebSocket clients. */
export class EventBus {
  private readonly listeners = new Set<Listener>();
  private pendingChanged = new Set<number>();
  private changedTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event: ServerEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (err) {
        console.error("Event listener failed:", err);
      }
    }
  }

  /** Coalesce bursts of library changes into one event (~250 ms). */
  libraryChanged(bookIds: Iterable<number>): void {
    for (const id of bookIds) this.pendingChanged.add(id);
    if (this.changedTimer) return;
    this.changedTimer = setTimeout(() => {
      const ids = [...this.pendingChanged];
      this.pendingChanged = new Set();
      this.changedTimer = null;
      this.emit({ type: "library.changed", bookIds: ids });
    }, 250);
  }
}
