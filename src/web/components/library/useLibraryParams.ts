import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import type { BookFormat, LibraryQuery, LibrarySort, MissingFilter } from "../../../shared/types.ts";

export const PAGE_SIZE = 60;

/** Library view state lives in the URL so back/forward and reloads restore it. */
export function useLibraryParams() {
  const [params, setParams] = useSearchParams();

  const query: LibraryQuery = useMemo(() => {
    const get = (k: string) => params.get(k) || undefined;
    const confirmed = params.get("confirmed");
    return {
      shelf: params.has("shelf") ? params.get("shelf")! : undefined,
      q: get("q"),
      format: get("format") as BookFormat | undefined,
      tag: get("tag"),
      series: get("series"),
      author: get("author"),
      confirmed: confirmed === "true" ? true : confirmed === "false" ? false : undefined,
      missing: get("missing") as MissingFilter | undefined,
      minRating: Number(params.get("minRating")) || undefined,
      sort: (get("sort") as LibrarySort | undefined) ?? "title",
      order: params.get("order") === "desc" ? "desc" : "asc",
      page: Number(params.get("page")) || 1,
      size: PAGE_SIZE,
    };
  }, [params]);

  /** Patch URL params; any change other than `page` resets to page 1. */
  const update = useCallback(
    (patch: Record<string, string | number | boolean | undefined | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === null || v === "") next.delete(k);
            else next.set(k, String(v));
          }
          if (!("page" in patch)) next.delete("page");
          return next;
        },
        { replace: "q" in patch }, // typing in search shouldn't flood history
      );
    },
    [setParams],
  );

  return { query, update };
}
