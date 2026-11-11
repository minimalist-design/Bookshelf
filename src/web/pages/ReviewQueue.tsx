import { useEffect, useState } from "react";
import { Alert, Anchor, Button, Center, Group, Loader, Pagination, Paper, Progress, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconChecks } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api/client.ts";
import { useInvalidateBooks, useLookupStatus, useReviewQueue } from "../api/hooks.ts";
import { CoverThumb } from "../components/CoverThumb.tsx";
import { FormatBadges } from "../components/library/BookCards.tsx";
import { MetadataReview } from "../components/lookup/MetadataReview.tsx";

/** Results of bulk lookups, reviewed one book at a time. */
export function ReviewQueue() {
  const queue = useReviewQueue();
  const status = useLookupStatus();
  const invalidate = useInvalidateBooks();
  const [position, setPosition] = useState(1);
  const items = queue.data ?? [];
  const item = items[Math.min(position, items.length) - 1];
  useEffect(() => {
    if (position > items.length && items.length) setPosition(items.length);
  }, [items.length, position]);

  const skip = useMutation({ mutationFn: (id: number) => api.skipReview(id), onSuccess: invalidate });
  const acceptFills = useMutation({
    mutationFn: api.acceptFills,
    onSuccess: (r) => {
      invalidate();
      notifications.show({
        color: r.errors.length ? "yellow" : "teal",
        title: `Updated ${r.applied} book${r.applied === 1 ? "" : "s"}`,
        message: [r.skipped ? `${r.skipped} title-search match(es) left for review.` : "", r.errors[0] ?? ""].filter(Boolean).join(" ") || undefined,
      });
    },
    onError: (e) => notifications.show({ color: "red", message: e.message }),
  });

  const s = status.data;
  const total = s ? s.done + s.pending : 0;
  const identifierMatches = items.filter((i) => i.result.candidates[0] && i.result.candidates[0].match !== "search").length;

  return (
    <Stack maw={1200}>
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>Review queue</Title>
          <Text c="dimmed" size="sm">
            Results of bulk metadata lookups. Nothing changes until you apply it.
          </Text>
        </div>
        {identifierMatches > 0 && (
          <Button variant="light" leftSection={<IconChecks size={16} />} loading={acceptFills.isPending} onClick={() => acceptFills.mutate()}>
            Fill missing fields for {identifierMatches} ISBN/DOI match{identifierMatches === 1 ? "" : "es"}
          </Button>
        )}
      </Group>

      {s?.running && (
        <Paper withBorder p="sm">
          <Text size="sm" mb={6}>
            Looking up books… {s.done} of {total}
            {s.noMatch ? ` · ${s.noMatch} without matches` : ""}
            {s.failed ? ` · ${s.failed} failed` : ""}
          </Text>
          <Progress value={total ? (100 * s.done) / total : 0} animated />
        </Paper>
      )}
      {!s?.running && s && s.done > 0 && (s.noMatch > 0 || s.failed > 0) && (
        <Alert variant="light" color="gray">
          Last run: {s.done} looked up{s.noMatch ? `, ${s.noMatch} without any match` : ""}
          {s.failed ? `, ${s.failed} failed (network or service errors — try again later)` : ""}.
        </Alert>
      )}

      {queue.isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : !item ? (
        <Text c="dimmed" py="xl" ta="center">
          Nothing to review. Select books in the library and choose “Look up metadata”.
        </Text>
      ) : (
        <>
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {Math.min(position, items.length)} of {items.length}
            </Text>
            <Pagination size="sm" total={items.length} value={Math.min(position, items.length)} onChange={setPosition} siblings={1} />
          </Group>
          <Paper withBorder p="md">
            <Group wrap="nowrap" gap="md" mb="md" align="flex-start">
              <CoverThumb bookId={item.book.id} hasCover={item.book.hasCover} width={48} />
              <div style={{ minWidth: 0 }}>
                <Anchor component={Link} to={`/books/${item.book.id}`} fw={600}>
                  {item.book.title}
                </Anchor>
                <Text size="sm" c="dimmed">
                  {item.book.authors.join(", ") || "Unknown author"}
                  {item.book.isbn13 ? ` · ISBN ${item.book.isbn13}` : ""}
                  {item.book.doi ? ` · DOI ${item.book.doi}` : ""}
                </Text>
                <FormatBadges book={item.book} />
              </div>
            </Group>
            <MetadataReview
              key={item.book.id}
              book={item.book}
              result={item.result}
              onSkip={() => skip.mutate(item.book.id)}
              skipping={skip.isPending}
            />
          </Paper>
        </>
      )}
    </Stack>
  );
}
