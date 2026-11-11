import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Group,
  Image,
  Paper,
  ScrollArea,
  Spoiler,
  Stack,
  Table,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconExternalLink } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import type { BookSummaryDto, CandidateWithDiff, FieldDiff, LookupResult, MetadataField } from "../../../shared/types.ts";
import { api } from "../../api/client.ts";
import { useInvalidateBooks } from "../../api/hooks.ts";
import { CoverThumb } from "../CoverThumb.tsx";

export const FIELD_LABELS: Record<MetadataField, string> = {
  title: "Title",
  subtitle: "Subtitle",
  authors: "Authors",
  isbn13: "ISBN",
  doi: "DOI",
  publisher: "Publisher",
  publishedDate: "Published",
  language: "Language",
  pages: "Pages",
  description: "Description",
  series: "Series",
  seriesIndex: "Number in series",
  tags: "Tags",
};

const STATUS_BADGE = {
  fill: { color: "teal", label: "new" },
  conflict: { color: "orange", label: "differs" },
  same: { color: "gray", label: "same" },
  missing: { color: "gray", label: "—" },
} as const;

const SOURCE_NAME = { openlibrary: "Open Library", doi: "DOI" } as const;

function Value({ value, field }: { value: FieldDiff["current"]; field: MetadataField }) {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  const text = Array.isArray(value) ? value.join(field === "tags" ? " · " : ", ") : String(value);
  if (field === "description") {
    return (
      <Spoiler maxHeight={60} showLabel="more" hideLabel="less">
        <Text size="sm" style={{ whiteSpace: "pre-line" }}>
          {text}
        </Text>
      </Spoiler>
    );
  }
  return (
    <Text size="sm" style={{ wordBreak: "break-word" }}>
      {text}
    </Text>
  );
}

/** Fields worth pre-selecting: everything the book is missing; differences need an explicit choice. */
function defaultSelection(c: CandidateWithDiff): Set<MetadataField> {
  return new Set(c.diff.filter((d) => d.status === "fill").map((d) => d.field));
}

interface Props {
  book: BookSummaryDto;
  result: LookupResult;
  onApplied?: () => void;
  /** Shown in the review queue. */
  onSkip?: () => void;
  skipping?: boolean;
}

export function MetadataReview({ book, result, onApplied, onSkip, skipping }: Props) {
  const [index, setIndex] = useState(0);
  const candidate = result.candidates[index];
  const [fields, setFields] = useState<Set<MetadataField>>(() => (candidate ? defaultSelection(candidate) : new Set()));
  const [useCover, setUseCover] = useState(false);
  const invalidate = useInvalidateBooks();

  useEffect(() => setIndex(0), [result]);
  useEffect(() => {
    if (!candidate) return;
    setFields(defaultSelection(candidate));
    setUseCover(!!candidate.coverUrl && !book.hasCover);
  }, [candidate, book.hasCover]);

  const apply = useMutation({
    mutationFn: () => api.applyMetadata(book.id, { candidate: candidate!, fields: [...fields], cover: useCover }),
    onSuccess: (r) => {
      invalidate();
      notifications.show({
        color: "teal",
        title: fields.size || useCover ? "Metadata updated" : "Confirmed",
        message: r.renamed.length ? `Renamed ${r.renamed.length} file(s)` : `Confirmed from ${SOURCE_NAME[candidate!.source]}`,
      });
      onApplied?.();
    },
  });

  const selectable = useMemo(() => candidate?.diff.filter((d) => d.status === "fill" || d.status === "conflict") ?? [], [candidate]);

  if (!candidate) {
    return (
      <Stack>
        {result.errors.map((e) => (
          <Alert key={e} color="red" variant="light">
            {e}
          </Alert>
        ))}
        <Text c="dimmed">No matching records found. Try another search.</Text>
        {onSkip && (
          <Group>
            <Button variant="default" onClick={onSkip} loading={skipping}>
              Remove from queue
            </Button>
          </Group>
        )}
      </Stack>
    );
  }

  const toggle = (f: MetadataField) =>
    setFields((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  const nothingSelected = fields.size === 0 && !useCover;

  return (
    <Stack>
      {result.errors.map((e) => (
        <Alert key={e} color="yellow" variant="light" p="xs">
          {e}
        </Alert>
      ))}

      {result.candidates.length > 1 && (
        <ScrollArea type="auto" offsetScrollbars>
          <Group gap="xs" wrap="nowrap">
            {result.candidates.map((c, i) => (
              <UnstyledButton key={`${c.source}:${c.id}`} onClick={() => setIndex(i)} aria-pressed={i === index}>
                <Paper
                  withBorder
                  p={6}
                  w={210}
                  style={{ borderColor: i === index ? "var(--mantine-primary-color-filled)" : undefined, borderWidth: i === index ? 2 : 1 }}
                >
                  <Group gap={8} wrap="nowrap" align="flex-start">
                    {c.coverUrl ? (
                      <Image src={c.coverUrl.replace("-L.jpg", "-S.jpg")} w={28} h={42} fit="cover" radius={2} alt="" />
                    ) : null}
                    <div style={{ minWidth: 0 }}>
                      <Text size="xs" fw={600} lineClamp={2}>
                        {c.metadata.title}
                      </Text>
                      <Text size="xs" c="dimmed" lineClamp={1}>
                        {c.metadata.authors.join(", ")}
                      </Text>
                      <Text size="xs" c="dimmed" lineClamp={1}>
                        {c.label}
                      </Text>
                    </div>
                  </Group>
                </Paper>
              </UnstyledButton>
            ))}
          </Group>
        </ScrollArea>
      )}

      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs">
          <Badge color={c(candidate)} variant="light">
            {candidate.match === "search" ? "Title search" : candidate.match === "isbn" ? "ISBN match" : "DOI match"}
          </Badge>
          <Text size="sm" c="dimmed">
            {candidate.label}
          </Text>
        </Group>
        <Anchor href={candidate.url} target="_blank" rel="noreferrer" size="sm">
          <Group gap={4} wrap="nowrap">
            View record <IconExternalLink size={14} />
          </Group>
        </Anchor>
      </Group>
      {candidate.match === "search" && (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />} p="xs">
          <Text size="sm">Found by title/author search — check that this is the same book (and edition) before applying.</Text>
        </Alert>
      )}

      <Table.ScrollContainer minWidth={560}>
        <Table verticalSpacing={6} layout="fixed">
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={36} />
              <Table.Th w={130}>Field</Table.Th>
              <Table.Th>Current</Table.Th>
              <Table.Th>{SOURCE_NAME[candidate.source]}</Table.Th>
              <Table.Th w={78} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {candidate.coverUrl && (
              <Table.Tr>
                <Table.Td>
                  <Checkbox checked={useCover} onChange={() => setUseCover((v) => !v)} aria-label="Use this cover" />
                </Table.Td>
                <Table.Td>
                  <Text size="sm" fw={500}>
                    Cover
                  </Text>
                </Table.Td>
                <Table.Td>
                  <CoverThumb bookId={book.id} hasCover={book.hasCover} width={60} />
                </Table.Td>
                <Table.Td>
                  <Image src={candidate.coverUrl.replace("-L.jpg", "-M.jpg")} w={60} h={90} fit="cover" radius={4} alt="Candidate cover" />
                </Table.Td>
                <Table.Td>
                  <Badge size="xs" color={book.hasCover ? "orange" : "teal"} variant="light">
                    {book.hasCover ? "differs" : "new"}
                  </Badge>
                </Table.Td>
              </Table.Tr>
            )}
            {candidate.diff
              .filter((d) => d.status !== "missing" || (d.current !== null && !(Array.isArray(d.current) && !d.current.length)))
              .map((d) => {
                const canPick = d.status === "fill" || d.status === "conflict";
                return (
                  <Table.Tr key={d.field} style={{ opacity: canPick ? 1 : 0.6 }}>
                    <Table.Td>
                      {canPick && <Checkbox checked={fields.has(d.field)} onChange={() => toggle(d.field)} aria-label={`Use ${FIELD_LABELS[d.field]}`} />}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {FIELD_LABELS[d.field]}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Value value={d.current} field={d.field} />
                    </Table.Td>
                    <Table.Td>
                      <Value value={d.candidate} field={d.field} />
                    </Table.Td>
                    <Table.Td>
                      <Badge size="xs" color={STATUS_BADGE[d.status].color} variant="light">
                        {STATUS_BADGE[d.status].label}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      {apply.isError && <Alert color="red">{apply.error.message}</Alert>}
      <Group justify="space-between">
        <Group gap="xs">
          <Button size="xs" variant="subtle" onClick={() => setFields(new Set(selectable.map((d) => d.field)))} disabled={!selectable.length}>
            Select all differences
          </Button>
          <Button size="xs" variant="subtle" color="gray" onClick={() => setFields(new Set())}>
            Select none
          </Button>
        </Group>
        <Group gap="xs">
          {onSkip && (
            <Button variant="default" onClick={onSkip} loading={skipping}>
              Skip
            </Button>
          )}
          <Button onClick={() => apply.mutate()} loading={apply.isPending}>
            {nothingSelected ? "Confirm as correct" : `Apply ${fields.size + (useCover ? 1 : 0)} change${fields.size + (useCover ? 1 : 0) === 1 ? "" : "s"}`}
          </Button>
        </Group>
      </Group>
      <Text size="xs" c="dimmed">
        Applying marks the metadata as confirmed by {SOURCE_NAME[candidate.source]}: it is kept even if the book's files are removed.
      </Text>
    </Stack>
  );
}

function c(candidate: CandidateWithDiff): string {
  return candidate.match === "search" ? "yellow" : "teal";
}
