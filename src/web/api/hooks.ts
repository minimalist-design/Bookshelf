import { useEffect } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BookDetailDto, BookUpdate, LibraryQuery, LibraryStatus, LookupQueueStatus, ServerEvent, SettingsUpdate } from "../../shared/types.ts";
import { api } from "./client.ts";

export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: api.getSettings });

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (update: SettingsUpdate) => api.updateSettings(update),
    onSuccess: (data) => {
      qc.setQueryData(["settings"], data);
      qc.invalidateQueries({ queryKey: ["library"] });
      qc.invalidateQueries({ queryKey: ["shelves"] });
      qc.invalidateQueries({ queryKey: ["libraryStatus"] });
    },
  });
}

export const useBrowse = (path: string | undefined) =>
  useQuery({ queryKey: ["browse", path ?? ""], queryFn: () => api.browse(path) });

export const useLibrary = (query: LibraryQuery) =>
  useQuery({ queryKey: ["library", query], queryFn: () => api.getLibrary(query), placeholderData: keepPreviousData });

export const useShelves = () => useQuery({ queryKey: ["shelves"], queryFn: api.getShelves });

export const useLibraryStatus = () => useQuery({ queryKey: ["libraryStatus"], queryFn: api.getStatus });

export const useBook = (id: number | null) =>
  useQuery({ queryKey: ["book", id], queryFn: () => api.getBook(id!), enabled: id !== null, retry: false });

export const useLookupStatus = () => useQuery({ queryKey: ["lookupStatus"], queryFn: api.lookupStatus });
export const useReviewQueue = () => useQuery({ queryKey: ["reviewQueue"], queryFn: api.reviewQueue });

export const useFacets = () => useQuery({ queryKey: ["facets"], queryFn: api.getFacets, staleTime: 30_000 });

/** Invalidate everything derived from book data after a mutation. */
export function useInvalidateBooks() {
  const qc = useQueryClient();
  return () => {
    for (const key of ["library", "shelves", "book", "facets", "libraryStatus", "reviewQueue", "lookupStatus", "maintenance"]) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  };
}

export function useUpdateBook(id: number) {
  const qc = useQueryClient();
  const invalidate = useInvalidateBooks();
  return useMutation({
    mutationFn: (update: BookUpdate) => api.updateBook(id, update),
    onSuccess: (res) => {
      qc.setQueryData<BookDetailDto>(["book", id], res.book);
      invalidate();
    },
  });
}

/** Live updates: server events invalidate cached queries. Reconnects with backoff. */
export function useServerEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        if (retry > 0) qc.invalidateQueries(); // we may have missed events
        retry = 0;
      };
      ws.onmessage = (msg) => {
        const event = JSON.parse(String(msg.data)) as ServerEvent;
        if (event.type === "library.changed") {
          qc.invalidateQueries({ queryKey: ["library"] });
          qc.invalidateQueries({ queryKey: ["shelves"] });
          qc.invalidateQueries({ queryKey: ["book"] });
          qc.invalidateQueries({ queryKey: ["facets"] });
          qc.invalidateQueries({ queryKey: ["maintenance"] });
        } else if (event.type === "lookup.status") {
          const prev = qc.getQueryData<LookupQueueStatus>(["lookupStatus"]);
          qc.setQueryData(["lookupStatus"], event.status);
          if (prev?.reviewCount !== event.status.reviewCount) qc.invalidateQueries({ queryKey: ["reviewQueue"] });
        } else if (event.type === "library.status") {
          const prev = qc.getQueryData<LibraryStatus>(["libraryStatus"]);
          qc.setQueryData(["libraryStatus"], event.status);
          if (prev?.state !== event.status.state) {
            qc.invalidateQueries({ queryKey: ["library"] });
            qc.invalidateQueries({ queryKey: ["shelves"] });
          }
        }
      };
      ws.onclose = () => {
        if (closed) return;
        timer = setTimeout(connect, Math.min(30_000, 500 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [qc]);
}
