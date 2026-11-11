import { useEffect, useState } from "react";
import { Button, Center, Group, Loader, Modal, SegmentedControl, Stack, Text, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { BookSummaryDto, LookupSource } from "../../../shared/types.ts";
import { api } from "../../api/client.ts";
import { MetadataReview } from "./MetadataReview.tsx";

type SourceChoice = "auto" | LookupSource;

/** Look up one book: automatic (by ISBN/DOI, else title search) or a manual query. */
export function LookupModal({ book, opened, onClose }: { book: BookSummaryDto; opened: boolean; onClose: () => void }) {
  const [source, setSource] = useState<SourceChoice>("auto");
  const [text, setText] = useState("");
  const [query, setQuery] = useState<{ source: SourceChoice; q: string }>({ source: "auto", q: "" });

  useEffect(() => {
    if (opened) {
      setSource("auto");
      setText("");
      setQuery({ source: "auto", q: "" });
    }
  }, [opened, book.id]);

  const lookup = useQuery({
    queryKey: ["lookup", book.id, query],
    queryFn: () => api.lookup(book.id, { source: query.source === "auto" ? undefined : query.source, q: query.q || undefined }),
    enabled: opened,
    staleTime: 5 * 60_000,
    retry: false,
  });

  return (
    <Modal opened={opened} onClose={onClose} title={`Look up “${book.title}”`} size="70rem">
      <Stack>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery({ source, q: text.trim() });
          }}
        >
          <Group gap="xs" align="flex-end" wrap="wrap">
            <SegmentedControl
              value={source}
              onChange={(v) => setSource(v as SourceChoice)}
              data={[
                { value: "auto", label: "Automatic" },
                { value: "openlibrary", label: "Open Library" },
                { value: "doi", label: "DOI / Crossref" },
              ]}
            />
            <TextInput
              style={{ flex: 1, minWidth: 220 }}
              placeholder="Optional: title and author, an ISBN or a DOI"
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              leftSection={<IconSearch size={16} />}
              aria-label="Search query"
            />
            <Button type="submit" variant="light">
              Search
            </Button>
          </Group>
        </form>
        {lookup.isFetching ? (
          <Center py="xl">
            <Group gap="sm">
              <Loader size="sm" />
              <Text c="dimmed">Asking {query.source === "doi" ? "the DOI registries" : query.source === "openlibrary" ? "Open Library" : "Open Library and the DOI registries"}…</Text>
            </Group>
          </Center>
        ) : lookup.isError ? (
          <Text c="red">{lookup.error.message}</Text>
        ) : lookup.data ? (
          <MetadataReview book={book} result={lookup.data} onApplied={onClose} />
        ) : null}
      </Stack>
    </Modal>
  );
}
