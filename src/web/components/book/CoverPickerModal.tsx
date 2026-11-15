import { useEffect, useState } from "react";
import { Alert, Anchor, Badge, Button, Center, Group, Image, Loader, Modal, Paper, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconExternalLink, IconSearch } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { BookDetailDto, CoverOption } from "../../../shared/types.ts";
import { api } from "../../api/client.ts";
import { useInvalidateBooks } from "../../api/hooks.ts";

const languageNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    return null;
  }
})();
const languageName = (code: string) => {
  try {
    return languageNames?.of(code) ?? code;
  } catch {
    return code;
  }
};

/** Pick a cover from all Open Library editions of the book; only the cover changes, the rest of the metadata is left alone. */
export function CoverPickerModal({ book, opened, onClose }: { book: BookDetailDto; opened: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const invalidate = useInvalidateBooks();

  useEffect(() => {
    if (opened) {
      setText("");
      setQuery("");
    }
  }, [opened, book.id]);

  const covers = useQuery({
    queryKey: ["covers", book.id, query],
    queryFn: () => api.coverCandidates(book.id, query),
    enabled: opened,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const choose = useMutation({
    mutationFn: (o: CoverOption) => api.setCoverFromUrl(book.id, o.coverUrl),
    onSuccess: () => {
      invalidate();
      notifications.show({ color: "teal", message: "Cover updated" });
      onClose();
    },
    onError: (e: Error) => notifications.show({ color: "red", message: e.message }),
  });

  const options = covers.data?.options ?? [];

  return (
    <Modal opened={opened} onClose={onClose} title={`Choose a cover for “${book.title}”`} size="44rem">
      <Stack>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(text.trim());
          }}
        >
          <Group gap="xs" wrap="nowrap">
            <TextInput
              style={{ flex: 1 }}
              placeholder="Optional: title and author, or an ISBN"
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

        {covers.isFetching ? (
          <Center py="xl">
            <Group gap="sm">
              <Loader size="sm" />
              <Text c="dimmed">Collecting the covers of every edition from Open Library…</Text>
            </Group>
          </Center>
        ) : covers.isError ? (
          <Text c="red">{covers.error.message}</Text>
        ) : covers.data ? (
          <>
            {covers.data.errors.map((e) => (
              <Alert key={e} color="yellow" variant="light" p="xs">
                {e}
              </Alert>
            ))}
            {options.length === 0 ? (
              <Text c="dimmed">No covers found. Try another search.</Text>
            ) : (
              <Stack gap="xs">
                <Text size="sm" c="dimmed">
                  {options.length} cover{options.length === 1 ? "" : "s"}
                  {book.language ? `, editions in ${languageName(book.language)} first` : ""}
                </Text>
                {options.map((o) => (
                  <CoverRow
                    key={o.coverUrl}
                    option={o}
                    loading={choose.isPending && choose.variables?.coverUrl === o.coverUrl}
                    disabled={choose.isPending}
                    onChoose={() => choose.mutate(o)}
                  />
                ))}
              </Stack>
            )}
          </>
        ) : null}
      </Stack>
    </Modal>
  );
}

function CoverRow({ option: o, loading, disabled, onChoose }: { option: CoverOption; loading: boolean; disabled: boolean; onChoose: () => void }) {
  return (
    <Paper withBorder p="xs">
      <Group wrap="nowrap" align="flex-start" gap="md">
        <Image src={o.coverUrl.replace("-L.jpg", "-M.jpg")} w={80} h={120} fit="cover" radius={4} loading="lazy" alt={`Cover of ${o.title}`} />
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text fw={600} lineClamp={2}>
            {o.title}
          </Text>
          {o.subtitle && (
            <Text size="sm" c="dimmed" lineClamp={1}>
              {o.subtitle}
            </Text>
          )}
          <Text size="sm" lineClamp={1}>
            {o.authors.length ? o.authors.join(", ") : "Unknown author"}
          </Text>
          {o.details && (
            <Text size="xs" c="dimmed" lineClamp={2}>
              {o.details}
            </Text>
          )}
          <Group gap="xs" mt={4}>
            {o.thisEdition && (
              <Badge size="xs" variant="light" color="teal">
                This edition
              </Badge>
            )}
            {o.language && (
              <Badge size="xs" variant="default">
                {languageName(o.language)}
              </Badge>
            )}
            {o.isbn13 && (
              <Text size="xs" c="dimmed" ff="monospace">
                {o.isbn13}
              </Text>
            )}
            <Anchor href={o.url} target="_blank" rel="noreferrer" size="xs">
              <Group gap={4} wrap="nowrap">
                View record <IconExternalLink size={12} />
              </Group>
            </Anchor>
          </Group>
        </Stack>
        <Button size="xs" variant="light" onClick={onChoose} loading={loading} disabled={disabled && !loading} style={{ flexShrink: 0 }}>
          Use this cover
        </Button>
      </Group>
    </Paper>
  );
}
