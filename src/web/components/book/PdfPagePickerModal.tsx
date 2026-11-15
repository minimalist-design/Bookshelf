import { useEffect, useRef, useState } from "react";
import { Button, Center, Group, Loader, Modal, Paper, Select, SimpleGrid, Stack, Text, UnstyledButton } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist/types/src/display/api";
import type { BookDetailDto } from "../../../shared/types.ts";
import { api } from "../../api/client.ts";
import { useInvalidateBooks } from "../../api/hooks.ts";
import { openPdf } from "../reader/pdf.ts";

const PAGES_PER_STEP = 10;
const THUMB_WIDTH = 150;
/** Longest side of the saved cover, like covers rendered from a PDF on import. */
const COVER_SIZE = 1200;

/** Render a PDF page into a canvas at the scale `scaleFor(width, height)` picks for its unscaled size. */
function renderPage(page: PDFPageProxy, canvas: HTMLCanvasElement, scaleFor: (w: number, h: number) => number): RenderTask {
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: scaleFor(base.width, base.height) });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  return page.render({ canvas, viewport: vp, background: "white" } as Parameters<typeof page.render>[0]);
}

/** Pick one of the first pages of a PDF file as the book's cover (rendered in the browser with pdf.js). */
export function PdfPagePickerModal({ book, opened, onClose }: { book: BookDetailDto; opened: boolean; onClose: () => void }) {
  const pdfs = book.files.filter((f) => f.format === "pdf");
  const [hash, setHash] = useState<string | null>(pdfs[0]?.hash ?? null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGES_PER_STEP);
  const [selected, setSelected] = useState<number | null>(null);
  const invalidate = useInvalidateBooks();

  useEffect(() => {
    if (opened) setHash((h) => (h && pdfs.some((f) => f.hash === h) ? h : (pdfs[0]?.hash ?? null)));
  }, [opened]);

  useEffect(() => {
    if (!opened || !hash) return;
    setDoc(null);
    setError(null);
    setShown(PAGES_PER_STEP);
    setSelected(null);
    let cancelled = false;
    const task = openPdf(book.id, hash);
    task.promise
      .then((d) => !cancelled && setDoc(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Could not open this PDF"));
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [opened, hash, book.id]);

  const save = useMutation({
    mutationFn: async (n: number) => {
      const page = await doc!.getPage(n);
      const canvas = document.createElement("canvas");
      await renderPage(page, canvas, (w, h) => COVER_SIZE / Math.max(w, h)).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
      if (!blob) throw new Error("The page could not be rendered");
      return api.setCover(book.id, blob);
    },
    onSuccess: (_book, n) => {
      invalidate();
      notifications.show({ color: "teal", message: `Page ${n} is now the cover` });
      onClose();
    },
    onError: (e: Error) => notifications.show({ color: "red", message: e.message }),
  });

  const count = doc ? Math.min(shown, doc.numPages) : 0;

  return (
    <Modal opened={opened} onClose={onClose} title={`Use a page of “${book.title}” as the cover`} size="56rem">
      <Stack>
        {pdfs.length > 1 && (
          <Select
            label="PDF file"
            data={pdfs.map((f) => ({ value: f.hash, label: f.filename }))}
            value={hash}
            onChange={setHash}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
          />
        )}
        {error ? (
          <Text c="red">{error}</Text>
        ) : !doc ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : (
          <>
            <SimpleGrid cols={{ base: 2, xs: 3, sm: 5 }} spacing="sm">
              {Array.from({ length: count }, (_, i) => (
                <PageThumb key={`${hash}:${i + 1}`} doc={doc} n={i + 1} selected={selected === i + 1} onSelect={() => setSelected(i + 1)} />
              ))}
            </SimpleGrid>
            <Group justify="space-between">
              {count < doc.numPages ? (
                <Button variant="subtle" size="xs" onClick={() => setShown((s) => s + PAGES_PER_STEP)}>
                  Show {Math.min(PAGES_PER_STEP, doc.numPages - count)} more pages
                </Button>
              ) : (
                <span />
              )}
              <Group gap="xs">
                <Button variant="default" onClick={onClose}>
                  Cancel
                </Button>
                <Button disabled={selected === null} loading={save.isPending} onClick={() => selected && save.mutate(selected)}>
                  {selected ? `Use page ${selected}` : "Select a page"}
                </Button>
              </Group>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}

function PageThumb({ doc, n, selected, onSelect }: { doc: PDFDocumentProxy; n: number; selected: boolean; onSelect: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let task: RenderTask | null = null;
    let cancelled = false;
    doc
      .getPage(n)
      .then((page) => {
        if (cancelled || !canvas.current) return;
        task = renderPage(page, canvas.current, (w) => (THUMB_WIDTH * (window.devicePixelRatio || 1)) / w);
        return task.promise.then(() => !cancelled && setState("ready"));
      })
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, n]);

  return (
    <UnstyledButton onClick={onSelect} aria-pressed={selected} aria-label={`Page ${n}`} disabled={state === "error"}>
      <Paper
        withBorder
        p={4}
        style={{
          borderColor: selected ? "var(--mantine-primary-color-filled)" : undefined,
          borderWidth: selected ? 2 : 1,
          margin: selected ? 0 : 1,
        }}
      >
        <div style={{ position: "relative", minHeight: 80, background: "white" }}>
          <canvas ref={canvas} style={{ width: "100%", height: "auto", display: "block" }} />
          {state !== "ready" && (
            <Center style={{ position: "absolute", inset: 0 }}>
              {state === "loading" ? <Loader size="xs" /> : <Text size="xs" c="dimmed">Could not render</Text>}
            </Center>
          )}
        </div>
        <Text size="xs" ta="center" mt={4} c={selected ? undefined : "dimmed"} fw={selected ? 600 : undefined}>
          Page {n}
        </Text>
      </Paper>
    </UnstyledButton>
  );
}
