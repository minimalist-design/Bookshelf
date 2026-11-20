import { useState, type ReactNode } from "react";
import { Button, Center, Group, Loader, SegmentedControl, Text, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { BookSummaryDto, LookupSource } from "../../../shared/types.ts";
import { api } from "../../api/client.ts";
import { useSettings } from "../../api/hooks.ts";
import { MetadataReview } from "./MetadataReview.tsx";

export type SourceChoice = "auto" | LookupSource;
export interface LookupQuery {
  source: SourceChoice;
  q: string;
}

export const AUTO_QUERY: LookupQuery = { source: "auto", q: "" };

/** Pick a source and type an optional query (title and author, an ISBN or a DOI). */
export function LookupSearchForm({ onSearch, extra }: { onSearch: (query: LookupQuery) => void; extra?: ReactNode }) {
  const [source, setSource] = useState<SourceChoice>("auto");
  const [text, setText] = useState("");
  const isbndb = useSettings().data?.isbndb.configured ?? false;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSearch({ source, q: text.trim() });
      }}
    >
      <Group gap="xs" align="flex-end" wrap="wrap">
        <SegmentedControl
          value={source}
          onChange={(v) => setSource(v as SourceChoice)}
          data={[
            { value: "auto", label: "Automatic" },
            ...(isbndb ? [{ value: "isbndb", label: "ISBNdb" }] : []),
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
        {extra}
      </Group>
    </form>
  );
}

const asking = (source: SourceChoice) =>
  source === "doi"
    ? "the DOI registries"
    : source === "openlibrary"
      ? "Open Library"
      : source === "isbndb"
        ? "ISBNdb"
        : "Open Library and the DOI registries";

/** Run a lookup for one book and show its candidates for review. */
export function LookupResults({
  book,
  query,
  onApplied,
  onSkip,
  skipping,
}: {
  book: BookSummaryDto;
  query: LookupQuery;
  onApplied?: () => void;
  onSkip?: () => void;
  skipping?: boolean;
}) {
  const lookup = useQuery({
    queryKey: ["lookup", book.id, query],
    queryFn: () => api.lookup(book.id, { source: query.source === "auto" ? undefined : query.source, q: query.q || undefined }),
    staleTime: 5 * 60_000,
    retry: false,
  });

  return lookup.isFetching ? (
    <Center py="xl">
      <Group gap="sm">
        <Loader size="sm" />
        <Text c="dimmed">Asking {asking(query.source)}…</Text>
      </Group>
    </Center>
  ) : lookup.isError ? (
    <Text c="red">{lookup.error.message}</Text>
  ) : lookup.data ? (
    <MetadataReview book={book} result={lookup.data} onApplied={onApplied} onSkip={onSkip} skipping={skipping} />
  ) : null;
}
