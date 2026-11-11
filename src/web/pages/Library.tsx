import { useEffect, useState } from "react";
import { Center, Group, Loader, Pagination, Stack, Text, Title } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import type { BookSummaryDto } from "../../shared/types.ts";
import { useLibrary } from "../api/hooks.ts";
import { BookGrid, BookList } from "../components/library/BookCards.tsx";
import { LibraryToolbar, type ViewMode } from "../components/library/LibraryToolbar.tsx";
import { SelectionBar } from "../components/library/SelectionBar.tsx";
import { PAGE_SIZE, useLibraryParams } from "../components/library/useLibraryParams.ts";
import { LibraryStatusBar } from "../components/LibraryStatusBar.tsx";

export function Library() {
  const { query, update } = useLibraryParams();
  const [view, setView] = useLocalStorage<ViewMode>({ key: "bookshelf.view", defaultValue: "grid" });
  // Selection keeps summaries so bulk actions work across pages.
  const [selection, setSelection] = useState<Map<number, BookSummaryDto>>(new Map());
  const selected = new Set(selection.keys());
  const lib = useLibrary(query);

  // Selection is per shelf: switching shelves clears it.
  useEffect(() => setSelection(new Map()), [query.shelf]);

  const toggle = (book: BookSummaryDto) =>
    setSelection((prev) => {
      const next = new Map(prev);
      if (next.has(book.id)) next.delete(book.id);
      else next.set(book.id, book);
      return next;
    });

  const heading = query.shelf === undefined ? "All books" : query.shelf === "" ? "Unshelved" : query.shelf;
  const data = lib.data;
  const filtered = !!(query.q || query.format || query.tag || query.series || query.author || query.confirmed !== undefined || query.missing || query.minRating);

  return (
    <Stack pb={80}>
      <LibraryStatusBar />
      <Group justify="space-between" align="baseline">
        <Title order={2}>{heading}</Title>
        {data && (
          <Text size="sm" c="dimmed">
            {data.total} book{data.total === 1 ? "" : "s"}
          </Text>
        )}
      </Group>
      <LibraryToolbar query={query} update={update} view={view} onViewChange={setView} />

      {lib.isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : data && data.total === 0 ? (
        <Text c="dimmed" py="xl" ta="center">
          {filtered ? "No books match these filters." : "No books here yet. Use “Add books” or drop files anywhere on this page."}
        </Text>
      ) : data ? (
        view === "grid" ? (
          <BookGrid books={data.items} selected={selected} onToggle={toggle} selecting={selected.size > 0} />
        ) : (
          <BookList books={data.items} selected={selected} onToggle={toggle} selecting={selected.size > 0} />
        )
      ) : null}

      {data && data.total > PAGE_SIZE && (
        <Group justify="center">
          <Pagination total={Math.ceil(data.total / PAGE_SIZE)} value={query.page ?? 1} onChange={(page) => update({ page })} />
        </Group>
      )}
      <SelectionBar selection={selection} onClear={() => setSelection(new Map())} />
    </Stack>
  );
}
