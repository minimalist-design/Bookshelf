import { useEffect, useRef, useState } from "react";
import { ActionIcon, Box, Center, Drawer, Group, Loader, NavLink, ScrollArea, SegmentedControl, Text, Tooltip, useComputedColorScheme } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { IconChevronLeft, IconChevronRight, IconList, IconTextDecrease, IconTextIncrease } from "@tabler/icons-react";
import ePub, { type Book, type NavItem, type Rendition } from "epubjs";
import type { BookDetailDto } from "../../../shared/types.ts";
import { downloadUrl, fileUrl } from "./fileUrls.ts";
import { ReaderFrame } from "./ReaderFrame.tsx";
import { usePositionSaver } from "./usePositionSaver.ts";

interface Props {
  book: BookDetailDto;
  hash: string;
  onBack: () => void;
}

const THEMES = {
  light: { body: { background: "#ffffff", color: "#1b1b1b" } },
  sepia: { body: { background: "#f4ecd8", color: "#433422" } },
  dark: { body: { background: "#1f1f1f", color: "#d6d6d6" }, a: { color: "#8ab4f8" } },
} as const;
type ThemeName = keyof typeof THEMES;

/** epub.js reader: paginated, TOC, font size, light/sepia/dark, resumes from the saved CFI. */
export function EpubReader({ book, hash, onBack }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const rendition = useRef<Rendition | null>(null);
  const [toc, setToc] = useState<NavItem[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | null>(book.readingPosition?.hash === hash ? book.readingPosition.fraction : null);
  const [chapter, setChapter] = useState<string>("");
  const scheme = useComputedColorScheme("light");
  const [theme, setTheme] = useLocalStorage<ThemeName | "auto">({ key: "bookshelf.epub.theme", defaultValue: "auto" });
  const [fontSize, setFontSize] = useLocalStorage<number>({ key: "bookshelf.epub.fontSize", defaultValue: 100 });
  const save = usePositionSaver(book.id, hash);
  const effectiveTheme: ThemeName = theme === "auto" ? (scheme === "dark" ? "dark" : "light") : theme;

  useEffect(() => {
    if (!host.current) return;
    let cancelled = false;
    const epub: Book = ePub(fileUrl(book.id, hash), { openAs: "epub" });
    const r = epub.renderTo(host.current, { width: "100%", height: "100%", spread: "auto", allowScriptedContent: false } as never);
    rendition.current = r;
    for (const [name, rules] of Object.entries(THEMES)) r.themes.register(name, rules);

    const start = book.readingPosition?.hash === hash ? book.readingPosition.position : undefined;
    r.display(start)
      .catch(() => r.display()) // stale/invalid CFI: start at the beginning
      .then(() => !cancelled && setLoading(false))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Could not open this EPUB"));

    epub.loaded.navigation.then((nav) => !cancelled && setToc(nav.toc)).catch(() => {});
    // Locations (for percentages) are computed in the background; cheap enough for typical books.
    let locationsReady = false;
    epub.ready
      .then(() => epub.locations.generate(1600))
      .then(() => {
        locationsReady = true;
        const loc = r.currentLocation() as unknown as { start?: { cfi: string } };
        if (!cancelled && loc?.start) setPercent(epub.locations.percentageFromCfi(loc.start.cfi));
      })
      .catch(() => {});

    r.on("relocated", (loc: { start: { cfi: string; href: string } }) => {
      const pct = locationsReady ? epub.locations.percentageFromCfi(loc.start.cfi) : null;
      if (pct !== null) setPercent(pct);
      save(loc.start.cfi, pct);
      const item = epub.navigation?.get(loc.start.href);
      setChapter(item?.label?.trim() ?? "");
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") r.next();
      if (e.key === "ArrowLeft" || e.key === "PageUp") r.prev();
    };
    r.on("keydown", onKey); // keys pressed inside the book's iframe
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
      rendition.current = null;
      epub.destroy();
    };
  }, [book.id, hash]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    rendition.current?.themes.select(effectiveTheme);
  }, [effectiveTheme, loading]);
  useEffect(() => {
    rendition.current?.themes.fontSize(`${fontSize}%`);
  }, [fontSize, loading]);

  const controls = (
    <Group gap={4} wrap="nowrap">
      <Tooltip label="Contents">
        <ActionIcon variant="subtle" onClick={() => setTocOpen(true)} disabled={!toc.length} aria-label="Table of contents">
          <IconList size={18} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Smaller text">
        <ActionIcon variant="subtle" onClick={() => setFontSize((s) => Math.max(60, s - 10))} aria-label="Smaller text">
          <IconTextDecrease size={18} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Larger text">
        <ActionIcon variant="subtle" onClick={() => setFontSize((s) => Math.min(200, s + 10))} aria-label="Larger text">
          <IconTextIncrease size={18} />
        </ActionIcon>
      </Tooltip>
      <SegmentedControl
        size="xs"
        value={theme}
        onChange={(v) => setTheme(v as ThemeName | "auto")}
        data={[
          { value: "auto", label: "Auto" },
          { value: "light", label: "Light" },
          { value: "sepia", label: "Sepia" },
          { value: "dark", label: "Dark" },
        ]}
        visibleFrom="sm"
      />
    </Group>
  );

  return (
    <ReaderFrame
      title={book.title}
      subtitle={chapter || book.authors.join(", ")}
      onBack={onBack}
      downloadHref={downloadUrl(book.id, hash)}
      controls={controls}
      status={percent !== null ? `${Math.round(percent * 100)}%` : undefined}
    >
      <Box style={{ position: "absolute", inset: 0, background: THEMES[effectiveTheme].body.background }}>
        <div ref={host} style={{ position: "absolute", inset: "12px 56px" }} />
        <ActionIcon
          variant="subtle"
          size="xl"
          style={{ position: "absolute", left: 4, top: "50%", transform: "translateY(-50%)" }}
          onClick={() => rendition.current?.prev()}
          aria-label="Previous page"
        >
          <IconChevronLeft />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          size="xl"
          style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)" }}
          onClick={() => rendition.current?.next()}
          aria-label="Next page"
        >
          <IconChevronRight />
        </ActionIcon>
        {(loading || error) && (
          <Center style={{ position: "absolute", inset: 0 }}>
            {error ? <Text c="red">{error}</Text> : <Loader />}
          </Center>
        )}
      </Box>
      <Drawer opened={tocOpen} onClose={() => setTocOpen(false)} title="Contents" size="sm">
        <ScrollArea>
          <TocList
            items={toc}
            onPick={(href) => {
              rendition.current?.display(href);
              setTocOpen(false);
            }}
          />
        </ScrollArea>
      </Drawer>
    </ReaderFrame>
  );
}

function TocList({ items, onPick, depth = 0 }: { items: NavItem[]; onPick: (href: string) => void; depth?: number }) {
  return (
    <>
      {items.map((item) => (
        <div key={item.id ?? item.href}>
          <NavLink label={item.label.trim()} onClick={() => onPick(item.href)} pl={12 + depth * 16} />
          {item.subitems?.length ? <TocList items={item.subitems} onPick={onPick} depth={depth + 1} /> : null}
        </div>
      ))}
    </>
  );
}
