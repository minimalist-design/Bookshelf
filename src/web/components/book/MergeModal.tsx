import { useState } from "react";
import { Alert, Button, Group, Loader, Modal, Radio, ScrollArea, Stack, Text, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconSearch } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import type { BookDetailDto } from "../../../shared/types.ts";
import { api } from "../../api/client.ts";
import { useInvalidateBooks, useLibrary } from "../../api/hooks.ts";
import { CoverThumb } from "../CoverThumb.tsx";
import { FormatBadges } from "../library/BookCards.tsx";

/**
 * Merge another book into this one: its files join this book, this book's metadata wins
 * (empty fields are filled from the other), and the other entry disappears.
 */
export function MergeModal({ book, opened, onClose }: { book: BookDetailDto; opened: boolean; onClose: () => void }) {
  const [search, setSearch] = useState(book.title);
  const [q] = useDebouncedValue(search, 250);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const results = useLibrary({ q, size: 20 });
  const invalidate = useInvalidateBooks();
  const thisFormats = new Set(book.files.map((f) => f.format));

  const merge = useMutation({
    mutationFn: () => api.mergeBooks(Number(sourceId), book.id),
    onSuccess: (r) => {
      invalidate();
      notifications.show({ color: "teal", title: "Books merged", message: `${r.book.title} now has ${r.book.files.length} files` });
      onClose();
    },
  });
  const candidates = (results.data?.items ?? []).filter((b) => b.id !== book.id);

  return (
    <Modal opened={opened} onClose={onClose} title="Merge another book into this one" size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          Use this for different formats of the same book that weren't matched automatically (no shared ISBN/DOI). The
          other book's files join “{book.title}”, this book's metadata is kept, and empty fields are filled from the other.
        </Text>
        <TextInput leftSection={<IconSearch size={16} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} placeholder="Search books" data-autofocus />
        <ScrollArea.Autosize mah={340}>
          {results.isFetching && !results.data ? (
            <Loader size="sm" />
          ) : candidates.length === 0 ? (
            <Text size="sm" c="dimmed">
              No other books found.
            </Text>
          ) : (
            <Radio.Group value={sourceId} onChange={setSourceId}>
              <Stack gap="xs">
                {candidates.map((b) => {
                  const clash = b.files.find((f) => thisFormats.has(f.format));
                  return (
                    <Radio.Card key={b.id} value={String(b.id)} p="xs" radius="md" disabled={!!clash} style={{ opacity: clash ? 0.5 : 1 }}>
                      <Group wrap="nowrap" gap="sm">
                        <Radio.Indicator disabled={!!clash} />
                        <CoverThumb bookId={b.id} hasCover={b.hasCover} width={32} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Text size="sm" fw={500} truncate>
                            {b.title}
                          </Text>
                          <Text size="xs" c="dimmed" truncate>
                            {b.authors.join(", ") || "Unknown author"}
                            {clash ? ` · both have ${clash.format.toUpperCase()}` : ""}
                          </Text>
                        </div>
                        <FormatBadges book={b} />
                      </Group>
                    </Radio.Card>
                  );
                })}
              </Stack>
            </Radio.Group>
          )}
        </ScrollArea.Autosize>
        {merge.isError && <Alert color="red">{merge.error.message}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!sourceId} loading={merge.isPending} onClick={() => merge.mutate()}>
            Merge into this book
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
