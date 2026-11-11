import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ActionIcon, Box, Center, Group, Loader, NumberInput, Text, Tooltip } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { IconArrowsHorizontal, IconExternalLink, IconZoomIn, IconZoomOut } from "@tabler/icons-react";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/types/src/display/api";
import type { BookDetailDto } from "../../../shared/types.ts";
import { downloadUrl, fileUrl } from "./fileUrls.ts";
import { ReaderFrame } from "./ReaderFrame.tsx";
import { usePositionSaver } from "./usePositionSaver.ts";

pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.min.mjs";

interface Props {
  book: BookDetailDto;
  hash: string;
  onBack: () => void;
}

const GAP = 12;

/** pdf.js reader: continuous scroll, pages rendered only near the viewport, byte-range loading. */
export function PdfReader({ book, hash, onBack }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aspect, setAspect] = useState(1.414); // height / width of page 1, used until a page reports its own
  const [zoom, setZoom] = useState(1); // 1 = fit width
  const [current, setCurrent] = useState(1);
  const [jump, setJump] = useState<number | string>("");
  const scroller = useRef<HTMLDivElement>(null);
  const { ref: sizeRef, width: containerWidth } = useElementSize();
  const save = usePositionSaver(book.id, hash);
  const restored = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const task = pdfjs.getDocument({
      url: fileUrl(book.id, hash),
      cMapUrl: "/vendor/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
      disableAutoFetch: true, // only fetch byte ranges for pages actually shown
      rangeChunkSize: 256 * 1024,
    });
    task.promise
      .then(async (d) => {
        const first = await d.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        if (cancelled) return;
        setAspect(vp.height / vp.width);
        setDoc(d);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Could not open this PDF"));
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [book.id, hash]);

  const pageWidth = Math.max(200, Math.min(containerWidth - 32, 1400) * zoom);
  const pageHeight = pageWidth * aspect;

  const scrollToPage = useCallback(
    (n: number) => {
      scroller.current?.scrollTo({ top: (n - 1) * (pageHeight + GAP) });
    },
    [pageHeight],
  );

  // Resume once the layout is known.
  useEffect(() => {
    if (!doc || !containerWidth || restored.current) return;
    restored.current = true;
    const saved = book.readingPosition?.hash === hash ? Number(book.readingPosition.position) : 1;
    if (saved > 1 && saved <= doc.numPages) requestAnimationFrame(() => scrollToPage(saved));
  }, [doc, containerWidth, book.readingPosition, hash, scrollToPage]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el || !doc) return;
    const page = Math.min(doc.numPages, Math.max(1, Math.floor((el.scrollTop + el.clientHeight / 3) / (pageHeight + GAP)) + 1));
    if (page !== current) {
      setCurrent(page);
      save(String(page), doc.numPages > 1 ? (page - 1) / (doc.numPages - 1) : 1);
    }
  };

  // Keep the same page in view when zooming.
  const changeZoom = (z: number) => {
    const page = current;
    setZoom(z);
    requestAnimationFrame(() => scroller.current && scroller.current.scrollTo({ top: (page - 1) * (pageWidthFor(z) * aspect + GAP) }));
  };
  const pageWidthFor = (z: number) => Math.max(200, Math.min(containerWidth - 32, 1400) * z);

  const controls = (
    <Group gap={4} wrap="nowrap">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(jump);
          if (doc && n >= 1 && n <= doc.numPages) scrollToPage(n);
          setJump("");
        }}
      >
        <NumberInput
          size="xs"
          w={70}
          placeholder={String(current)}
          value={jump}
          onChange={setJump}
          min={1}
          max={doc?.numPages}
          hideControls
          aria-label="Go to page"
        />
      </form>
      <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
        / {doc?.numPages ?? "…"}
      </Text>
      <Tooltip label="Zoom out">
        <ActionIcon variant="subtle" onClick={() => changeZoom(Math.max(0.4, zoom - 0.2))} aria-label="Zoom out">
          <IconZoomOut size={18} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Fit width">
        <ActionIcon variant={zoom === 1 ? "light" : "subtle"} onClick={() => changeZoom(1)} aria-label="Fit width">
          <IconArrowsHorizontal size={18} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Zoom in">
        <ActionIcon variant="subtle" onClick={() => changeZoom(Math.min(3, zoom + 0.2))} aria-label="Zoom in">
          <IconZoomIn size={18} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Open in the browser's PDF viewer (search, print)">
        <ActionIcon variant="subtle" component="a" href={fileUrl(book.id, hash)} target="_blank" aria-label="Open in browser viewer">
          <IconExternalLink size={18} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );

  return (
    <ReaderFrame
      title={book.title}
      subtitle={book.authors.join(", ")}
      onBack={onBack}
      downloadHref={downloadUrl(book.id, hash)}
      controls={controls}
      status={doc ? `${Math.round(((current - 1) / Math.max(1, doc.numPages - 1)) * 100)}%` : undefined}
    >
      <Box ref={sizeRef} style={{ position: "absolute", inset: 0 }}>
        <div
          ref={scroller}
          onScroll={onScroll}
          style={{ position: "absolute", inset: 0, overflow: "auto", background: "var(--mantine-color-default-hover)" }}
        >
          {error ? (
            <Center h="100%">
              <Text c="red">{error}</Text>
            </Center>
          ) : !doc || !containerWidth ? (
            <Center h="100%">
              <Loader />
            </Center>
          ) : (
            <div style={{ padding: `${GAP}px 16px`, display: "flex", flexDirection: "column", alignItems: "center", gap: GAP }}>
              {Array.from({ length: doc.numPages }, (_, i) => (
                <PdfPage key={i + 1} doc={doc} n={i + 1} width={pageWidth} height={pageHeight} root={scroller.current} />
              ))}
            </div>
          )}
        </div>
      </Box>
    </ReaderFrame>
  );
}

interface PageProps {
  doc: PDFDocumentProxy;
  n: number;
  width: number;
  height: number;
  root: HTMLElement | null;
}

/** One page slot; renders its canvas while near the viewport and frees it when far away. */
const PdfPage = memo(function PdfPage({ doc, n, width, height, root }: PageProps) {
  const slot = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [ownHeight, setOwnHeight] = useState<number | null>(null);

  useEffect(() => {
    const el = slot.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), { root, rootMargin: "150% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    doc.getPage(n).then((page) => {
      if (cancelled || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const vp = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
      setOwnHeight(base.height * scale);
      const c = canvas.current;
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      task = page.render({ canvas: c, viewport: vp } as Parameters<typeof page.render>[0]);
      task.promise.catch(() => {});
    });
    return () => {
      cancelled = true;
      task?.cancel();
      // Free the bitmap of pages that scrolled far away.
      if (canvas.current) {
        canvas.current.width = 0;
        canvas.current.height = 0;
      }
    };
  }, [visible, doc, n, width]);

  const h = ownHeight ?? height;
  return (
    <div ref={slot} style={{ width, height: h, background: "white", boxShadow: "0 1px 4px rgba(0,0,0,.25)", flexShrink: 0 }} data-page={n}>
      {visible && <canvas ref={canvas} style={{ width, height: h, display: "block" }} aria-label={`Page ${n}`} />}
    </div>
  );
});
