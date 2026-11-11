import { useCallback, useEffect, useState } from "react";
import { ActionIcon, Box, Center, Group, Loader, NumberInput, SegmentedControl, Slider, Text, Tooltip } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { IconArrowsHorizontal, IconArrowsMaximize } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { BookDetailDto } from "../../../shared/types.ts";
import { api } from "../../api/client.ts";
import { downloadUrl, pageUrl } from "./fileUrls.ts";
import { ReaderFrame } from "./ReaderFrame.tsx";
import { usePositionSaver } from "./usePositionSaver.ts";

interface Props {
  book: BookDetailDto;
  hash: string;
  onBack: () => void;
}

type Fit = "screen" | "width";

/** Page-image reader for comics (CBZ/CBR) and scanned books (DJVU, rendered server-side). */
export function PageReader({ book, hash, onBack }: Props) {
  const pages = useQuery({ queryKey: ["pages", book.id, hash], queryFn: () => api.pageCount(book.id, hash), retry: false, staleTime: Infinity });
  const count = pages.data?.count ?? 0;
  const initial = book.readingPosition?.hash === hash ? Number(book.readingPosition.position) || 1 : 1;
  const [page, setPage] = useState(initial);
  const [jump, setJump] = useState<number | string>("");
  const [loaded, setLoaded] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null); // slider position while dragging
  const [fit, setFit] = useLocalStorage<Fit>({ key: "bookshelf.pages.fit", defaultValue: "screen" });
  const [rtl, setRtl] = useLocalStorage<boolean>({ key: `bookshelf.pages.rtl.${book.id}`, defaultValue: false });
  const save = usePositionSaver(book.id, hash);

  const go = useCallback(
    (n: number) => {
      if (!count) return;
      const next = Math.min(count, Math.max(1, n));
      if (next === page) return;
      setPage(next);
      setLoaded(false);
      save(String(next), count > 1 ? (next - 1) / (count - 1) : 1);
    },
    [count, page, save],
  );
  const forward = () => go(page + 1);
  const backward = () => go(page - 1);

  useEffect(() => {
    if (count && page > count) setPage(count);
  }, [count, page]);

  // Preload the next two pages.
  useEffect(() => {
    for (const n of [page + 1, page + 2]) if (n <= count) new Image().src = pageUrl(book.id, hash, n);
  }, [page, count, book.id, hash]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const nextKey = rtl ? "ArrowLeft" : "ArrowRight";
      const prevKey = rtl ? "ArrowRight" : "ArrowLeft";
      if (e.key === nextKey || e.key === "PageDown" || e.key === " ") forward();
      else if (e.key === prevKey || e.key === "PageUp") backward();
      else if (e.key === "Home") go(1);
      else if (e.key === "End") go(count);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const controls = (
    <Group gap={4} wrap="nowrap">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(Number(jump));
          setJump("");
        }}
      >
        <NumberInput size="xs" w={64} placeholder={String(page)} value={jump} onChange={setJump} min={1} max={count} hideControls aria-label="Go to page" />
      </form>
      <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
        / {count || "…"}
      </Text>
      <Tooltip label={fit === "screen" ? "Fit width" : "Fit screen"}>
        <ActionIcon variant="subtle" onClick={() => setFit(fit === "screen" ? "width" : "screen")} aria-label="Toggle fit">
          {fit === "screen" ? <IconArrowsHorizontal size={18} /> : <IconArrowsMaximize size={18} />}
        </ActionIcon>
      </Tooltip>
      <SegmentedControl
        size="xs"
        value={rtl ? "rtl" : "ltr"}
        onChange={(v) => setRtl(v === "rtl")}
        data={[
          { value: "ltr", label: "L→R" },
          { value: "rtl", label: "R→L" },
        ]}
        aria-label="Reading direction"
      />
    </Group>
  );

  return (
    <ReaderFrame
      title={book.title}
      subtitle={book.authors.join(", ")}
      onBack={onBack}
      downloadHref={downloadUrl(book.id, hash)}
      controls={controls}
      status={count ? `${Math.round(((page - 1) / Math.max(1, count - 1)) * 100)}%` : undefined}
    >
      <Box style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "#111" }}>
        <Box style={{ flex: 1, minHeight: 0, overflow: fit === "width" ? "auto" : "hidden", position: "relative" }}>
          {pages.isError ? (
            <Center h="100%">
              <Text c="red.4">{pages.error.message}</Text>
            </Center>
          ) : count ? (
            <>
              <img
                key={page}
                src={pageUrl(book.id, hash, page)}
                alt={`Page ${page}`}
                onLoad={() => setLoaded(true)}
                style={
                  fit === "screen"
                    ? { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }
                    : { display: "block", width: "100%", height: "auto" }
                }
              />
              {/* Click halves to turn pages (direction-aware). */}
              <div
                onClick={() => (rtl ? forward() : backward())}
                style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "35%", cursor: "w-resize" }}
                aria-hidden
              />
              <div
                onClick={() => (rtl ? backward() : forward())}
                style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: "35%", cursor: "e-resize" }}
                aria-hidden
              />
              {!loaded && (
                <Center style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                  <Loader color="gray" />
                </Center>
              )}
            </>
          ) : (
            <Center h="100%">
              <Loader color="gray" />
            </Center>
          )}
        </Box>
        {count > 1 && (
          <Box px="md" py={8} style={{ flexShrink: 0 }}>
            <Slider
              min={1}
              max={count}
              value={dragging ?? page}
              onChange={setDragging}
              onChangeEnd={(v) => {
                setDragging(null);
                go(v);
              }}
              label={(v) => `Page ${v}`}
              inverted={rtl}
              size="sm"
              color="gray"
              aria-label="Page"
            />
          </Box>
        )}
      </Box>
    </ReaderFrame>
  );
}
