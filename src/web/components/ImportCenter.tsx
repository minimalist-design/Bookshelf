import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  Progress,
  ScrollArea,
  Select,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import { Dropzone, type FileWithPath } from "@mantine/dropzone";
import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconFileUpload,
  IconLink,
  IconRestore,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import { useSearchParams } from "react-router";
import { SUPPORTED_EXTENSIONS, type ImportResultDto } from "../../shared/types.ts";
import { uploadBook } from "../api/client.ts";
import { useShelves } from "../api/hooks.ts";

const UNSHELVED = "__unshelved__";
const CONCURRENCY = 2;

type ItemState = "queued" | "uploading" | "done" | "error" | "rejected";

interface QueueItem {
  id: number;
  file: File;
  shelf: string | null;
  state: ItemState;
  progress: number;
  result?: ImportResultDto;
  error?: string;
}

interface ImportApi {
  open: () => void;
}

const ImportContext = createContext<ImportApi>({ open: () => {} });
export const useImport = () => useContext(ImportContext);

function isSupported(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext) && lower.length > ext.length);
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

let nextId = 1;

/** Upload dialog + full-window drop target + upload queue, available app-wide. */
export function ImportCenter({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [params] = useSearchParams();
  const currentShelf = params.has("shelf") ? params.get("shelf") || UNSHELVED : UNSHELVED;
  const [shelf, setShelf] = useState<string>(currentShelf);
  const shelves = useShelves();
  const running = useRef(new Set<number>());

  // Default the target shelf to the one being viewed whenever the dialog opens.
  useEffect(() => {
    if (opened && !items.some((i) => i.state === "queued" || i.state === "uploading")) setShelf(currentShelf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const update = useCallback((id: number, patch: Partial<QueueItem>) => {
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }, []);

  const addFiles = useCallback(
    (files: FileWithPath[]) => {
      const target = shelf === UNSHELVED ? null : shelf;
      setItems((list) => [
        ...files.map<QueueItem>((file) => ({
          id: nextId++,
          file,
          shelf: target,
          state: isSupported(file.name) ? "queued" : "rejected",
          progress: 0,
          error: isSupported(file.name) ? undefined : "Unsupported file type",
        })),
        ...list,
      ]);
      setOpened(true);
    },
    [shelf],
  );

  // Simple worker pool: start queued uploads while fewer than CONCURRENCY are running.
  useEffect(() => {
    const queued = items.filter((i) => i.state === "queued").reverse(); // oldest first
    for (const item of queued) {
      if (running.current.size >= CONCURRENCY) break;
      if (running.current.has(item.id)) continue;
      running.current.add(item.id);
      update(item.id, { state: "uploading" });
      uploadBook(item.file, item.shelf, (progress) => update(item.id, { progress }))
        .then((result) => update(item.id, { state: "done", progress: 1, result }))
        .catch((err: Error) => update(item.id, { state: "error", error: err.message }))
        .finally(() => {
          running.current.delete(item.id);
          setItems((l) => [...l]); // re-run the pool
        });
    }
  }, [items, update]);

  const active = items.filter((i) => i.state === "queued" || i.state === "uploading").length;
  const api = useMemo(() => ({ open: () => setOpened(true) }), []);
  const shelfOptions = [
    { value: UNSHELVED, label: "Unshelved (library root)" },
    ...(shelves.data ?? []).filter((s) => s.name !== null).map((s) => ({ value: s.name!, label: s.name! })),
  ];

  return (
    <ImportContext.Provider value={api}>
      {children}
      <Dropzone.FullScreen onDrop={addFiles} activateOnClick={false}>
        <Group justify="center" mih="50vh" style={{ pointerEvents: "none" }}>
          <IconFileUpload size={64} stroke={1.5} />
          <Text size="xl">Drop books to add them to the library</Text>
        </Group>
      </Dropzone.FullScreen>

      <Modal opened={opened} onClose={() => setOpened(false)} title="Add books" size="lg">
        <Stack>
          <Select
            label="Add to bookshelf"
            data={shelfOptions}
            value={shelf}
            onChange={(v) => v && setShelf(v)}
            allowDeselect={false}
            description="A new format of a book already in the library is placed next to its other files."
          />
          <Dropzone onDrop={addFiles}>
            <Group justify="center" gap="lg" mih={110} style={{ pointerEvents: "none" }}>
              <Dropzone.Idle>
                <IconUpload size={40} stroke={1.5} />
              </Dropzone.Idle>
              <Dropzone.Accept>
                <IconCheck size={40} stroke={1.5} />
              </Dropzone.Accept>
              <div>
                <Text size="lg">Drag books here or click to choose files</Text>
                <Text size="sm" c="dimmed">
                  EPUB, PDF, CBZ, CBR, DJVU, FB2. Files are copied; the originals stay untouched.
                </Text>
              </div>
            </Group>
          </Dropzone>

          {items.length > 0 && (
            <>
              <Group justify="space-between">
                <Text size="sm" c="dimmed">
                  {active ? `Uploading ${active} file${active === 1 ? "" : "s"}…` : "All uploads finished"}
                </Text>
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={items.every((i) => i.state === "queued" || i.state === "uploading")}
                  onClick={() => setItems((l) => l.filter((i) => i.state === "queued" || i.state === "uploading"))}
                >
                  Clear finished
                </Button>
              </Group>
              <ScrollArea.Autosize mah={360}>
                <Stack gap="xs">
                  {items.map((item) => (
                    <QueueRow key={item.id} item={item} onRemove={() => setItems((l) => l.filter((i) => i.id !== item.id))} />
                  ))}
                </Stack>
              </ScrollArea.Autosize>
            </>
          )}
        </Stack>
      </Modal>
    </ImportContext.Provider>
  );
}

const STATUS_VIEW = {
  imported: { color: "teal", icon: IconCheck, label: "Added" },
  attached: { color: "blue", icon: IconLink, label: "New format" },
  reconnected: { color: "violet", icon: IconRestore, label: "Restored" },
  duplicate: { color: "yellow", icon: IconCopy, label: "Duplicate" },
} as const;

function QueueRow({ item, onRemove }: { item: QueueItem; onRemove: () => void }) {
  const r = item.result;
  const view = r ? STATUS_VIEW[r.status] : null;
  const failed = item.state === "error" || item.state === "rejected";
  const Icon = view?.icon ?? (failed ? IconAlertTriangle : IconUpload);
  const color = view?.color ?? (failed ? "red" : "gray");
  return (
    <Paper withBorder p="xs">
      <Group wrap="nowrap" align="flex-start" gap="sm">
        <ThemeIcon variant="light" color={color} size="lg">
          <Icon size={18} />
        </ThemeIcon>
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" fw={500} truncate>
              {r ? r.title || item.file.name : item.file.name}
            </Text>
            {view && (
              <Badge size="xs" color={view.color} variant="light" style={{ flexShrink: 0 }}>
                {view.label}
              </Badge>
            )}
          </Group>
          {item.state === "uploading" || item.state === "queued" ? (
            <>
              <Text size="xs" c="dimmed" truncate>
                {item.state === "queued" ? "Waiting…" : item.progress >= 1 ? "Processing…" : `${Math.round(item.progress * 100)}% of ${formatSize(item.file.size)}`}
              </Text>
              <Progress value={item.progress * 100} size="sm" animated={item.progress >= 1} />
            </>
          ) : (
            <Text size="xs" c={failed ? "red" : "dimmed"} truncate>
              {failed ? item.error : r ? `${r.message} · ${r.relPath ?? ""}` : ""}
            </Text>
          )}
          {r && r.authors.length > 0 && (
            <Text size="xs" c="dimmed" truncate>
              {r.authors.join(", ")}
            </Text>
          )}
        </Stack>
        {item.state !== "uploading" && item.state !== "queued" && (
          <Tooltip label="Remove from list">
            <ActionIcon variant="subtle" color="gray" onClick={onRemove} aria-label="Remove from list">
              <IconX size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Paper>
  );
}
