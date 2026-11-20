import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Group, Text } from "@mantine/core";
import { Dropzone, type FileWithPath } from "@mantine/dropzone";
import { notifications } from "@mantine/notifications";
import { IconFileUpload } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { SUPPORTED_EXTENSIONS, type ImportResultDto, type LookupJobDto } from "../../shared/types.ts";
import { api, uploadBook } from "../api/client.ts";

export const UNSHELVED = "__unshelved__";
const CONCURRENCY = 2;
const AUTO_LOOKUP_KEY = "bookshelf.autoLookup";

/**
 * queued → uploading (progress; ≥ 1 means the server is processing) → lookup (new book waiting
 * for / in its metadata lookup) → removed. Rows that need attention stay until dismissed:
 * duplicate, error (upload failed), rejected (unsupported type), lookup-failed.
 */
export type ItemState = "queued" | "uploading" | "lookup" | "duplicate" | "error" | "rejected" | "lookup-failed";

export interface QueueItem {
  id: number;
  file: File;
  shelf: string | null;
  /** Queue a metadata lookup if the upload creates a new book (the switch when the file was added). */
  lookup: boolean;
  state: ItemState;
  progress: number;
  result?: ImportResultDto;
  error?: string;
}

/** Counts since this tab opened; they survive rows leaving the list. */
export interface SessionStats {
  /** Server time (epoch ms) the session started; null until known. */
  start: number | null;
  added: number;
  duplicates: number;
  failed: number;
}

export const ACTIVE_STATES: readonly ItemState[] = ["queued", "uploading", "lookup"];
const FINISHED_STATES: readonly ItemState[] = ["duplicate", "error", "rejected", "lookup-failed"];

interface ImportQueueApi {
  items: QueueItem[];
  /** Lookup jobs of the rows in `lookup` state, by book id. */
  jobs: Record<number, LookupJobDto | null>;
  session: SessionStats;
  shelf: string;
  setShelf: (shelf: string) => void;
  autoLookup: boolean;
  setAutoLookup: (on: boolean) => void;
  /** Queue files for the selected shelf, or for `shelf` (which then becomes the selection). */
  addFiles: (files: FileWithPath[], shelf?: string) => void;
  retry: (id: number) => void;
  retryLookup: (id: number) => void;
  dismiss: (id: number) => void;
  clearFinished: () => void;
  /** Go to the Add books page, defaulting the shelf to the one being viewed. */
  open: () => void;
}

const ImportQueueContext = createContext<ImportQueueApi | null>(null);

export function useImportQueue(): ImportQueueApi {
  const ctx = useContext(ImportQueueContext);
  if (!ctx) throw new Error("useImportQueue outside ImportQueueProvider");
  return ctx;
}

export function isSupported(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext) && lower.length > ext.length);
}

function readAutoLookup(): boolean {
  try {
    return localStorage.getItem(AUTO_LOOKUP_KEY) !== "0";
  } catch {
    return true;
  }
}

let nextId = 1;

/**
 * The upload queue, app-wide: uploads keep going while you move around the app. Also the
 * full-window drop target (dropped files are queued and the Add books page opens).
 */
export function ImportQueueProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [session, setSession] = useState<SessionStats>({ start: null, added: 0, duplicates: 0, failed: 0 });
  const [autoLookup, setAutoLookupState] = useState(readAutoLookup);
  const [params] = useSearchParams();
  const pathname = useLocation().pathname;
  const navigate = useNavigate();
  const viewedShelf = pathname === "/" && params.has("shelf") ? params.get("shelf") || UNSHELVED : UNSHELVED;
  const [shelf, setShelf] = useState<string>(viewedShelf);
  const running = useRef(new Set<number>());
  const qc = useQueryClient();

  const count = useCallback((patch: Partial<Record<"added" | "duplicates" | "failed", number>>) => {
    setSession((s) => ({
      ...s,
      added: s.added + (patch.added ?? 0),
      duplicates: s.duplicates + (patch.duplicates ?? 0),
      failed: s.failed + (patch.failed ?? 0),
    }));
  }, []);

  // The session starts now, in server time (the usage counts are filtered on the server's clock).
  useEffect(() => {
    let cancelled = false;
    api
      .metadataUsage()
      .then((u) => !cancelled && setSession((s) => ({ ...s, start: u.now })))
      .catch(() => !cancelled && setSession((s) => ({ ...s, start: Date.now() })));
    return () => {
      cancelled = true;
    };
  }, []);

  const setAutoLookup = useCallback((on: boolean) => {
    setAutoLookupState(on);
    try {
      localStorage.setItem(AUTO_LOOKUP_KEY, on ? "1" : "0");
    } catch {
      /* not remembered; still applies to this tab */
    }
  }, []);

  const update = useCallback((id: number, patch: Partial<QueueItem>) => {
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }, []);
  const remove = useCallback((id: number) => setItems((list) => list.filter((i) => i.id !== id)), []);

  const hasActive = items.some((i) => ACTIVE_STATES.includes(i.state));
  const active = useRef(hasActive);
  active.current = hasActive;

  const addFiles = useCallback(
    (files: FileWithPath[], pick?: string) => {
      if (pick !== undefined) setShelf(pick);
      const chosen = pick ?? shelf;
      const target = chosen === UNSHELVED ? null : chosen;
      const rejected = files.filter((f) => !isSupported(f.name)).length;
      if (rejected) count({ failed: rejected });
      setItems((list) => [
        ...list,
        ...files.map<QueueItem>((file) => ({
          id: nextId++,
          file,
          shelf: target,
          lookup: autoLookup,
          state: isSupported(file.name) ? "queued" : "rejected",
          progress: 0,
          error: isSupported(file.name) ? undefined : "Unsupported file type",
        })),
      ]);
    },
    [shelf, autoLookup, count],
  );

  const open = useCallback(() => {
    if (!active.current) setShelf(viewedShelf);
    navigate("/add");
  }, [navigate, viewedShelf]);

  // Simple worker pool: start queued uploads (oldest first) while fewer than CONCURRENCY run.
  useEffect(() => {
    for (const item of items) {
      if (running.current.size >= CONCURRENCY) break;
      if (item.state !== "queued" || running.current.has(item.id)) continue;
      running.current.add(item.id);
      update(item.id, { state: "uploading" });
      uploadBook(item.file, { shelf: item.shelf, lookup: item.lookup }, (progress) => update(item.id, { progress }))
        .then((result) => {
          if (result.status === "duplicate") {
            count({ duplicates: 1 });
            update(item.id, { state: "duplicate", progress: 1, result });
          } else {
            count({ added: 1 });
            if (result.lookupQueued) update(item.id, { state: "lookup", progress: 1, result });
            else remove(item.id);
          }
        })
        .catch((err: Error) => {
          count({ failed: 1 });
          update(item.id, { state: "error", error: err.message });
        })
        .finally(() => {
          running.current.delete(item.id);
          setItems((l) => [...l]); // re-run the pool
        });
    }
  }, [items, update, remove, count]);

  // Follow the lookups of new books; done (or no match, or cancelled) means the row is finished.
  const lookupIds = items.filter((i) => i.state === "lookup" && i.result).map((i) => i.result!.bookId);
  const jobsQuery = useQuery({
    queryKey: ["lookupJobs", lookupIds],
    queryFn: () => api.lookupJobs(lookupIds),
    enabled: lookupIds.length > 0,
  });
  const jobs = jobsQuery.data;
  useEffect(() => {
    if (!jobs) return;
    const finished = new Set<number>();
    const failed = new Map<number, string>();
    for (const i of items) {
      if (i.state !== "lookup" || !i.result || !(i.result.bookId in jobs)) continue;
      const job = jobs[i.result.bookId];
      if (!job || job.state === "done" || job.state === "no_match") finished.add(i.id);
      else if (job.state === "failed") failed.set(i.id, job.error ?? "The lookup failed");
    }
    if (!finished.size && !failed.size) return;
    setItems((list) =>
      list.flatMap((i) =>
        finished.has(i.id) ? [] : failed.has(i.id) && i.state === "lookup" ? [{ ...i, state: "lookup-failed" as const, error: failed.get(i.id) }] : [i],
      ),
    );
    if (failed.size) count({ failed: failed.size });
  }, [jobs, items, count]);

  const retry = useCallback(
    (id: number) => {
      count({ failed: -1 });
      update(id, { state: "queued", progress: 0, error: undefined });
    },
    [update, count],
  );

  const retryLookup = useCallback(
    (id: number) => {
      const item = items.find((i) => i.id === id);
      if (!item?.result) return;
      api
        .enqueueLookups([item.result.bookId])
        .then(() => {
          qc.removeQueries({ queryKey: ["lookupJobs"] }); // the cached "failed" must not end the row again
          count({ failed: -1 });
          update(id, { state: "lookup", error: undefined });
        })
        .catch((e: Error) => notifications.show({ color: "red", message: e.message }));
    },
    [items, update, count, qc],
  );

  const clearFinished = useCallback(() => setItems((list) => list.filter((i) => !FINISHED_STATES.includes(i.state))), []);

  // Files still in the browser are lost on reload or close: ask first.
  const uploading = items.some((i) => i.state === "queued" || i.state === "uploading");
  useEffect(() => {
    if (!uploading) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  const value = useMemo<ImportQueueApi>(
    () => ({
      items,
      jobs: jobs ?? {},
      session,
      shelf,
      setShelf,
      autoLookup,
      setAutoLookup,
      addFiles,
      retry,
      retryLookup,
      dismiss: remove,
      clearFinished,
      open,
    }),
    [items, jobs, session, shelf, autoLookup, setAutoLookup, addFiles, retry, retryLookup, remove, clearFinished, open],
  );

  return (
    <ImportQueueContext.Provider value={value}>
      {children}
      <Dropzone.FullScreen
        onDrop={(files) => {
          // Dropped on a shelf view (with nothing uploading): into that shelf, like the old dialog.
          if (pathname === "/add") addFiles(files);
          else {
            addFiles(files, active.current ? undefined : viewedShelf);
            navigate("/add");
          }
        }}
        activateOnClick={false}
      >
        <Group justify="center" mih="50vh" style={{ pointerEvents: "none" }}>
          <IconFileUpload size={64} stroke={1.5} />
          <Text size="xl">Drop books to add them to the library</Text>
        </Group>
      </Dropzone.FullScreen>
    </ImportQueueContext.Provider>
  );
}
