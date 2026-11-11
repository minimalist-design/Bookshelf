import { useCallback, useEffect, useRef } from "react";
import { api } from "../../api/client.ts";

/**
 * Debounced reading-position saver. Flushes on unmount and when the page is hidden
 * (tab closed / switched), using keepalive so the request survives unloading.
 */
export function usePositionSaver(bookId: number, hash: string, delayMs = 1500) {
  const pending = useRef<{ position: string; fraction: number | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(
    (keepalive = false) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const p = pending.current;
      pending.current = null;
      if (p) api.savePosition(bookId, { hash, ...p }, keepalive).catch(() => {});
    },
    [bookId, hash],
  );

  const save = useCallback(
    (position: string, fraction: number | null) => {
      pending.current = { position, fraction };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => flush(), delayMs);
    },
    [flush, delayMs],
  );

  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && flush(true);
    const onPageHide = () => flush(true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      flush(true);
    };
  }, [flush]);

  return save;
}
