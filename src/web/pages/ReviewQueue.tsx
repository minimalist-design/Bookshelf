import { useRef, useState, type MouseEvent } from "react";
import { Alert, Anchor, Button, Center, Divider, Group, Loader, Modal, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { useWindowEvent } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconChecks, IconChevronDown, IconChevronRight, IconRefresh, IconSearch } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { Link, useLocation, useSearchParams } from "react-router";
import { api } from "../api/client.ts";
import { useInvalidateBooks, useLookupStatus, useReviewQueue } from "../api/hooks.ts";
import { CoverThumb } from "../components/CoverThumb.tsx";
import { FormatBadges } from "../components/library/BookCards.tsx";
import { returnState } from "../components/library/returnTo.ts";
import { LookupResults, LookupSearchForm, type LookupQuery } from "../components/lookup/LookupSearch.tsx";
import { MetadataReview } from "../components/lookup/MetadataReview.tsx";
import type { ReviewItemDto } from "../../shared/types.ts";
import { paperKind } from "../../shared/workType.ts";
import { BookPage } from "./BookDetail.tsx";

/**
 * The queued candidates for one book, or the results of a manual search that replaces them on
 * screen. The search form is up front when the lookup found nothing or found a paper rather
 * than a book (the file was likely misidentified); otherwise it waits behind "Search again".
 */
function ReviewItemBody({ item, onSkip, skipping }: { item: ReviewItemDto; onSkip: () => void; skipping: boolean }) {
  const { candidates } = item.result;
  const paper = candidates[0] ? paperKind(candidates[0]) : null;
  const upFront = candidates.length === 0 || paper !== null;
  const [searching, setSearching] = useState(upFront);
  const [query, setQuery] = useState<LookupQuery | null>(null);
  const searchAgain = (
    <Anchor component="button" type="button" size="sm" onClick={() => setSearching(true)}>
      <Group gap={4} wrap="nowrap">
        <IconSearch size={14} /> Search again
      </Group>
    </Anchor>
  );
  return (
    <Stack gap="md">
      {paper && !query && (
        <Text size="sm" c="dimmed">
          The lookup found {/^[aeiou]/.test(paper) ? "an" : "a"} {paper}, not a book. Search for the book, or check the match below.
        </Text>
      )}
      {searching && (
        <LookupSearchForm
          onSearch={setQuery}
          extra={
            candidates.length > 0 &&
            (query !== null || !upFront) && (
              <Button
                variant="subtle"
                color="gray"
                onClick={() => {
                  setQuery(null);
                  setSearching(upFront);
                }}
              >
                Back to queued results
              </Button>
            )
          }
        />
      )}
      {query ? (
        <LookupResults book={item.book} query={query} onSkip={onSkip} skipping={skipping} />
      ) : (
        <MetadataReview book={item.book} result={item.result} onSkip={onSkip} skipping={skipping} headerExtra={!searching && searchAgain} />
      )}
    </Stack>
  );
}

/** A plain left click, as opposed to one asking the browser to open the link elsewhere (new tab, window). */
export function isPlainClick(e: Pick<MouseEvent, "button" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): boolean {
  return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}

/** The book ids whose editors are open, from the `open` URL parameter (`?open=3,17`). */
export function parseOpen(param: string | null): ReadonlySet<number> {
  return new Set((param ?? "").split(",").filter(Boolean).map(Number).filter(Number.isInteger));
}

/** The `open` URL parameter with `id` opened or closed; null once nothing is open. */
export function toggleOpen(open: ReadonlySet<number>, id: number): string | null {
  const next = open.has(id) ? [...open].filter((o) => o !== id) : [...open, id];
  return next.length ? next.join(",") : null;
}

/** What the lookup found for a book, in a few words, and the colour that says how far to trust it. */
export function matchSummary({ result }: ReviewItemDto): { text: string; color: string } {
  const [top] = result.candidates;
  const paper = top ? paperKind(top) : null;
  return !top
    ? { text: "No match", color: "dimmed" }
    : paper
      ? { text: `Found ${/^[aeiou]/.test(paper) ? "an" : "a"} ${paper}`, color: "orange.7" }
      : top.match === "search"
        ? { text: "Title search", color: "orange.7" }
        : { text: top.match === "isbn" ? "ISBN match" : "DOI match", color: "teal.7" };
}

/**
 * One book in the queue: a row that opens and closes its editor when clicked. Its "Book page" link
 * leads to the book's page; a plain click previews that page in an overlay instead of leaving the queue.
 */
function ReviewRow({
  item,
  open,
  onToggle,
  onPreview,
  onSkip,
  skipping,
}: {
  item: ReviewItemDto;
  open: boolean;
  onToggle: () => void;
  onPreview: () => void;
  onSkip: () => void;
  skipping: boolean;
}) {
  const location = useLocation();
  const { book } = item;
  const ids = [book.isbn13 && `ISBN ${book.isbn13}`, book.doi && `DOI ${book.doi}`].filter(Boolean);
  const match = matchSummary(item);
  const bodyId = `review-${book.id}`;
  const Chevron = open ? IconChevronDown : IconChevronRight;
  return (
    <Stack gap={0}>
      <Group wrap="nowrap" gap="md" align="center" py="sm">
        <UnstyledButton onClick={onToggle} aria-expanded={open} aria-controls={bodyId} style={{ flex: 1, minWidth: 0 }}>
          <Group wrap="nowrap" gap="md" align="center">
            <Chevron size={16} color="var(--mantine-color-dimmed)" style={{ flexShrink: 0 }} />
            <CoverThumb bookId={book.id} hasCover={book.hasCover} width={40} />
            <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
              <Text fw={600} lh={1.3} truncate>
                {book.title}
              </Text>
              <Text size="sm" truncate>
                {book.authors.join(", ") || <Text span c="dimmed">Unknown author</Text>}
              </Text>
              <Group gap="xs">
                {ids.length > 0 && (
                  <Text size="xs" c="dimmed">
                    {ids.join(" · ")}
                  </Text>
                )}
                <FormatBadges book={book} />
              </Group>
            </Stack>
            <Text size="sm" fw={600} c={match.color} style={{ flexShrink: 0 }}>
              {match.text}
            </Text>
          </Group>
        </UnstyledButton>
        <Anchor
          component={Link}
          to={`/books/${book.id}`}
          state={returnState(location)}
          size="sm"
          aria-label={`Preview ${book.title}`}
          style={{ flexShrink: 0 }}
          onClick={(e: MouseEvent) => {
            if (!isPlainClick(e)) return;
            e.preventDefault();
            onPreview();
          }}
        >
          Book page
        </Anchor>
      </Group>
      {open && (
        <Stack id={bodyId} pt="xs" pb="xl">
          <ReviewItemBody item={item} onSkip={onSkip} skipping={skipping} />
        </Stack>
      )}
      <Divider />
    </Stack>
  );
}

/**
 * A book's page in an overlay. Escape closes it only when pressed inside it: modals and menus opened
 * from the page (Edit, Look up…) live in their own portals, and Escape there closes just them.
 */
function BookPreview({ id, onClose }: { id: number | null; onClose: () => void }) {
  const content = useRef<HTMLDivElement>(null);
  useWindowEvent("keydown", (e) => {
    const target = e.target as Node;
    if (id !== null && e.key === "Escape" && !e.isComposing && (target === document.body || content.current?.contains(target))) onClose();
  });
  return (
    <Modal opened={id !== null} onClose={onClose} size="80rem" padding="xl" withCloseButton={false} closeOnEscape={false}>
      <div ref={content}>{id !== null && <BookPage id={id} onClose={onClose} />}</div>
    </Modal>
  );
}

/** Results of bulk lookups: every queued book in a list, each opening its own editor. */
export function ReviewQueue() {
  const queue = useReviewQueue();
  const status = useLookupStatus();
  const invalidate = useInvalidateBooks();
  // Open rows live in the URL, so they survive a reload and a visit to a book's page and back.
  const [params, setParams] = useSearchParams();
  const open = parseOpen(params.get("open"));
  const toggle = (id: number) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const value = toggleOpen(parseOpen(prev.get("open")), id);
        if (value) next.set("open", value);
        else next.delete("open");
        return next;
      },
      { replace: true },
    );
  // The book whose page is shown in an overlay, if any.
  const [previewId, setPreviewId] = useState<number | null>(null);
  const closePreview = () => setPreviewId(null);
  const items = queue.data ?? [];

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

  const retry = useMutation({
    mutationFn: api.retryFailedLookups,
    onError: (e) => notifications.show({ color: "red", message: e.message }),
  });

  const s = status.data;
  const identifierMatches = items.filter((i) => i.result.candidates[0] && i.result.candidates[0].match !== "search").length;

  return (
    <Stack maw={1200} gap="lg">
      <Group justify="space-between" align="flex-end">
        <Stack gap={4}>
          <Title order={2}>Review queue</Title>
          <Text c="dimmed" size="sm">
            Results of bulk metadata lookups. Nothing changes until you apply it.
          </Text>
        </Stack>
        {identifierMatches > 0 && (
          <Button variant="light" leftSection={<IconChecks size={16} />} loading={acceptFills.isPending} onClick={() => acceptFills.mutate()}>
            Fill missing fields for {identifierMatches} ISBN/DOI match{identifierMatches === 1 ? "" : "es"}
          </Button>
        )}
      </Group>

      {/* While a run is going, its progress bar is shown above every page. */}
      {!s?.running && s && s.done > 0 && (s.noMatch > 0 || s.failed > 0) && (
        <Alert variant="light" color="gray">
          <Group justify="space-between" gap="xs">
            <Text size="sm">
              Last run: {s.done} looked up{s.noMatch ? `, ${s.noMatch} without any match` : ""}
              {s.failed ? `, ${s.failed} failed (network or service errors)` : ""}.
            </Text>
            {s.failed > 0 && (
              <Button size="compact-sm" variant="light" leftSection={<IconRefresh size={14} />} loading={retry.isPending} onClick={() => retry.mutate()}>
                Retry {s.failed} failed
              </Button>
            )}
          </Group>
        </Alert>
      )}

      {queue.isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : items.length === 0 ? (
        <Text c="dimmed" py="xl" ta="center">
          Nothing to review. Select books in the library and choose “Look up metadata”.
        </Text>
      ) : (
        <Stack gap={0}>
          <Text size="sm" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: "0.04em" }} pb="xs">
            {items.length} book{items.length === 1 ? "" : "s"}
          </Text>
          <Divider />
          {items.map((item) => (
            <ReviewRow
              key={item.book.id}
              item={item}
              open={open.has(item.book.id)}
              onToggle={() => toggle(item.book.id)}
              onPreview={() => setPreviewId(item.book.id)}
              onSkip={() => skip.mutate(item.book.id)}
              skipping={skip.isPending && skip.variables === item.book.id}
            />
          ))}
        </Stack>
      )}

      <BookPreview id={previewId} onClose={closePreview} />
    </Stack>
  );
}
