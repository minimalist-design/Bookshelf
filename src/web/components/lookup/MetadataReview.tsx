import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Alert,
  Anchor,
  Box,
  Button,
  Checkbox,
  Group,
  Image,
  NumberInput,
  ScrollArea,
  Spoiler,
  Stack,
  Table,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconExternalLink } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import type { ApplyMetadataRequest, BookSummaryDto, CandidateWithDiff, DiffStatus, FieldDiff, LookupResult, MetadataField } from "../../../shared/types.ts";
import { api } from "../../api/client.ts";
import { useInvalidateBooks } from "../../api/hooks.ts";
import { AuthorsInput } from "../AuthorsInput.tsx";
import { CoverThumb } from "../CoverThumb.tsx";

export const FIELD_LABELS: Record<MetadataField, string> = {
  title: "Title",
  subtitle: "Subtitle",
  authors: "Authors",
  isbn13: "ISBN",
  doi: "DOI",
  publisher: "Publisher",
  edition: "Edition",
  publishedDate: "Published",
  language: "Language",
  pages: "Pages",
  description: "Description",
  series: "Series",
  seriesIndex: "Number in series",
  tags: "Tags",
};

const SOURCE_NAME = { isbndb: "ISBNdb", openlibrary: "Open Library", doi: "DOI" } as const;

/** Top padding that puts plain text on the first line of the xs inputs beside it. */
const TEXT_TOP = 5;

function Value({ value, field }: { value: FieldDiff["current"]; field: MetadataField }) {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
    return (
      <Text size="sm" c="dimmed" pt={TEXT_TOP}>
        —
      </Text>
    );
  }
  const text = Array.isArray(value) ? value.join(field === "tags" ? " · " : ", ") : String(value);
  if (field === "description") {
    return (
      <Spoiler maxHeight={60} showLabel="more" hideLabel="less" styles={{ control: { fontSize: "var(--mantine-font-size-sm)" } }}>
        <Text size="sm" pt={TEXT_TOP} style={{ whiteSpace: "pre-line" }}>
          {text}
        </Text>
      </Spoiler>
    );
  }
  return (
    <Text size="sm" pt={TEXT_TOP} style={{ wordBreak: "break-word" }}>
      {text}
    </Text>
  );
}

type FieldValue = FieldDiff["current"];
type Edits = Partial<Record<MetadataField, FieldValue>>;

const LIST_FIELDS: ReadonlySet<MetadataField> = new Set(["authors", "tags"]);
const NUMBER_FIELDS: ReadonlySet<MetadataField> = new Set(["pages", "seriesIndex"]);

/** What a field holds once saved: trimmed text, `null` for empty, lists without blank entries. */
function normalize(field: MetadataField, v: FieldValue | undefined): FieldValue {
  if (LIST_FIELDS.has(field)) return Array.isArray(v) ? v.map((x) => x.trim()).filter(Boolean) : [];
  if (v === null || v === undefined || Array.isArray(v)) return null;
  if (NUMBER_FIELDS.has(field)) return v === "" ? null : Number(v);
  return String(v).trim() || null;
}

const sameValue = (a: FieldValue, b: FieldValue) => JSON.stringify(a) === JSON.stringify(b);

/** Edits that actually change the book, leaving out fields taken from the candidate. */
function effectiveEdits(diff: FieldDiff[], edits: Edits, chosen: ReadonlySet<MetadataField>): NonNullable<ApplyMetadataRequest["edits"]> {
  return Object.fromEntries(
    diff
      .filter((d) => d.field in edits && !chosen.has(d.field))
      .map((d) => [d.field, normalize(d.field, edits[d.field])] as const)
      .filter(([f, v]) => !sameValue(v, normalize(f, diffCurrent(diff, f)))),
  );
}

const diffCurrent = (diff: FieldDiff[], f: MetadataField) => diff.find((d) => d.field === f)?.current ?? null;

/** An input for one field of the book, shaped like the field (list, number, long text or text). */
function CurrentEditor({ field, value, onChange }: { field: MetadataField; value: FieldValue; onChange: (v: FieldValue) => void }) {
  const label = `Current ${FIELD_LABELS[field]}`;
  if (field === "authors") {
    return (
      <AuthorsInput size="xs" variant="filled" aria-label={label} value={Array.isArray(value) ? value : []} onChange={onChange} splitChars={[";"]} placeholder="Add author, Enter" />
    );
  }
  if (LIST_FIELDS.has(field)) {
    return (
      <TagsInput
        size="xs" variant="filled"
        aria-label={label}
        value={Array.isArray(value) ? value : []}
        onChange={onChange}
        splitChars={[",", ";"]}
        placeholder="Add tag"
      />
    );
  }
  const text = value === null || Array.isArray(value) ? "" : value;
  if (NUMBER_FIELDS.has(field)) {
    return (
      <NumberInput
        size="xs" variant="filled"
        aria-label={label}
        min={field === "pages" ? 1 : 0}
        allowDecimal={field === "seriesIndex"}
        decimalScale={2}
        value={text}
        onChange={(v) => onChange(v === "" ? null : v)}
      />
    );
  }
  if (field === "description") {
    return <Textarea size="xs" variant="filled" aria-label={label} autosize minRows={1} maxRows={6} value={text} onChange={(e) => onChange(e.currentTarget.value)} />;
  }
  return (
    <TextInput
      size="xs" variant="filled"
      aria-label={label}
      value={text}
      onChange={(e) => onChange(e.currentTarget.value)}
      error={field === "title" && !String(text).trim() ? "Required" : undefined}
      ff={field === "isbn13" || field === "doi" ? "monospace" : undefined}
    />
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
  /** Next to the candidate's "View record" link (e.g. a way to search again). */
  headerExtra?: ReactNode;
}

export function MetadataReview({ book, result, onApplied, onSkip, skipping, headerExtra }: Props) {
  const [index, setIndex] = useState(0);
  const candidate = result.candidates[index];
  const [fields, setFields] = useState<Set<MetadataField>>(() => (candidate ? defaultSelection(candidate) : new Set()));
  const [useCover, setUseCover] = useState(false);
  // Edits belong to the book, not the candidate: they stay when another candidate is picked.
  const [edits, setEdits] = useState<Edits>({});
  // Notes are local only: no source has them, so they are never compared or picked.
  const [notes, setNotes] = useState<string | undefined>(undefined);
  const [showEmpty, setShowEmpty] = useState(false);
  const invalidate = useInvalidateBooks();

  useEffect(() => setIndex(0), [result]);
  useEffect(() => {
    if (!candidate) return;
    // Fields already typed in by hand stay unchecked when another candidate is picked.
    setFields(new Set([...defaultSelection(candidate)].filter((f) => !(f in edits))));
    setUseCover(!!candidate.coverUrl && !book.hasCover);
    // Only a new candidate resets the selection, not each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidate, book.hasCover]);

  const notesChanged = notes !== undefined && (notes.trim() || null) !== result.notes;
  const changedEdits = useMemo(
    () => ({
      ...(candidate ? effectiveEdits(candidate.diff, edits, fields) : {}),
      ...(notesChanged ? { notes: notes!.trim() || null } : {}),
    }),
    [candidate, edits, fields, notes, notesChanged],
  );
  const editCount = Object.keys(changedEdits).length;
  const titleMissing = "title" in changedEdits && !changedEdits.title;

  const apply = useMutation({
    mutationFn: () => api.applyMetadata(book.id, { candidate: candidate!, fields: [...fields], cover: useCover, edits: changedEdits }),
    onSuccess: (r) => {
      invalidate();
      notifications.show({
        color: "teal",
        title: fields.size || useCover || editCount ? "Metadata updated" : "Confirmed",
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
  // Typing a value of your own means keeping it over the candidate's.
  const edit = (f: MetadataField, v: FieldValue) => {
    setEdits((prev) => ({ ...prev, [f]: v }));
    setFields((prev) => (prev.has(f) ? new Set([...prev].filter((x) => x !== f)) : prev));
  };
  const changeCount = fields.size + (useCover ? 1 : 0) + editCount;
  const source = SOURCE_NAME[candidate.source];

  const allChosen = selectable.length > 0 && selectable.every((d) => fields.has(d.field));
  const someChosen = selectable.some((d) => fields.has(d.field));
  // Rows with nothing on either side are folded away; they can still be filled in by hand.
  const isEmptyRow = (d: FieldDiff) => d.status === "missing" && isEmpty(d.field in edits ? edits[d.field] : d.current);
  const emptyCount = candidate.diff.filter(isEmptyRow).length;
  const rows = showEmpty ? candidate.diff : candidate.diff.filter((d) => !isEmptyRow(d));
  const summary = [
    fields.size ? `${plural(fields.size, "value")} from ${source}` : "",
    useCover ? `the ${source} cover` : "",
    editCount ? `${plural(editCount, "edit")} by hand` : "",
  ].filter(Boolean);

  return (
    <Stack gap="md">
      {result.errors.map((e) => (
        <Alert key={e} color="yellow" variant="light" p="xs">
          {e}
        </Alert>
      ))}

      {result.candidates.length > 1 && (
        <ScrollArea type="auto" offsetScrollbars>
          <Group gap="xs" wrap="nowrap" align="stretch">
            {result.candidates.map((c, i) => (
              <UnstyledButton key={`${c.source}:${c.id}`} onClick={() => setIndex(i)} aria-pressed={i === index}>
                <Box
                  p="xs"
                  w={230}
                  h="100%"
                  style={{
                    borderRadius: "var(--mantine-radius-sm)",
                    boxShadow: `inset 0 0 0 ${i === index ? 2 : 1}px ${i === index ? "var(--mantine-primary-color-filled)" : "var(--mantine-color-default-border)"}`,
                  }}
                >
                  <Group gap={8} wrap="nowrap" align="flex-start">
                    {c.coverUrl ? <Image src={c.coverUrl.replace("-L.jpg", "-S.jpg")} w={28} h={42} fit="cover" radius={2} alt="" /> : null}
                    <div style={{ minWidth: 0 }}>
                      <Text size="sm" fw={600} lineClamp={2}>
                        {c.metadata.title}
                      </Text>
                      <Text size="xs" c="dimmed" lineClamp={1}>
                        {c.metadata.authors.join(", ")}
                      </Text>
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {c.label}
                      </Text>
                    </div>
                  </Group>
                </Box>
              </UnstyledButton>
            ))}
          </Group>
        </ScrollArea>
      )}

      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="md">
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Group gap="xs" wrap="wrap">
            <Text size="sm" fw={700} c={candidate.match === "search" ? "orange.7" : "teal.7"}>
              {candidate.match === "search" ? "Title search" : candidate.match === "isbn" ? "ISBN match" : "DOI match"}
            </Text>
            <Text size="sm" c="dimmed">
              {source} · {candidate.label}
            </Text>
            {candidate.kept && (
              <Text size="sm" c="dimmed" title="Read from the ISBNdb records kept in the database: no call was made">
                · kept copy
              </Text>
            )}
          </Group>
          {candidate.match === "search" && (
            <Group gap={6} wrap="nowrap">
              <IconAlertTriangle size={16} color="var(--mantine-color-orange-7)" style={{ flexShrink: 0 }} />
              <Text size="sm" c="orange.8">
                Found by title and author: check it is the same book and edition before applying.
              </Text>
            </Group>
          )}
        </Stack>
        <Group gap="md" wrap="nowrap">
          {headerExtra}
          <Anchor href={candidate.url} target="_blank" rel="noreferrer" size="sm">
            <Group gap={4} wrap="nowrap">
              View record <IconExternalLink size={14} />
            </Group>
          </Anchor>
        </Group>
      </Group>

      <Table.ScrollContainer minWidth={620}>
        {/* Rows align at the top, text cells nudged to sit on the inputs' first line. */}
        <Table verticalSpacing={8} layout="fixed" styles={{ td: { verticalAlign: "top" } }}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={140}>
                <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                  Field
                </Text>
              </Table.Th>
              <Table.Th>
                <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                  Current
                </Text>
              </Table.Th>
              <Table.Th w={36}>
                <Checkbox
                  size="sm"
                  checked={allChosen}
                  indeterminate={someChosen && !allChosen}
                  disabled={!selectable.length}
                  onChange={() => setFields(allChosen ? new Set() : new Set(selectable.map((d) => d.field)))}
                  aria-label={`Use every ${source} value`}
                />
              </Table.Th>
              <Table.Th>
                <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                  {source}
                </Text>
              </Table.Th>
              <Table.Th w={64} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {candidate.coverUrl && (
              <Table.Tr>
                <Table.Td>
                  <FieldName>Cover</FieldName>
                </Table.Td>
                <Table.Td style={{ opacity: useCover ? 0.45 : 1 }}>
                  <CoverThumb bookId={book.id} hasCover={book.hasCover} width={60} />
                </Table.Td>
                <Table.Td>
                  <Checkbox size="sm" mt={TEXT_TOP} checked={useCover} onChange={() => setUseCover((v) => !v)} aria-label="Use this cover" />
                </Table.Td>
                <Table.Td>
                  <Image src={candidate.coverUrl.replace("-L.jpg", "-M.jpg")} w={60} h={90} fit="cover" radius={2} alt="Candidate cover" />
                </Table.Td>
                <Table.Td>
                  <StatusText status={book.hasCover ? "conflict" : "fill"} />
                </Table.Td>
              </Table.Tr>
            )}
            {rows.map((d) => {
              const canPick = d.status === "fill" || d.status === "conflict";
              const replaced = fields.has(d.field);
              const edited = d.field in changedEdits;
              return (
                <Table.Tr key={d.field}>
                  <Table.Td>
                    <FieldName>{FIELD_LABELS[d.field]}</FieldName>
                  </Table.Td>
                  <Table.Td style={{ opacity: replaced ? 0.45 : 1 }} title={replaced ? `Replaced by the ${source} value` : undefined}>
                    <CurrentEditor field={d.field} value={d.field in edits ? edits[d.field]! : d.current} onChange={(v) => edit(d.field, v)} />
                  </Table.Td>
                  <Table.Td>
                    {canPick && <Checkbox size="sm" mt={TEXT_TOP} checked={replaced} onChange={() => toggle(d.field)} aria-label={`Use ${FIELD_LABELS[d.field]}`} />}
                  </Table.Td>
                  <Table.Td style={{ opacity: canPick ? 1 : 0.55 }}>
                    <Value value={d.candidate} field={d.field} />
                  </Table.Td>
                  <Table.Td>
                    <StatusText status={edited ? "edited" : d.status} />
                  </Table.Td>
                </Table.Tr>
              );
            })}
            <Table.Tr>
              <Table.Td>
                <FieldName>Notes</FieldName>
              </Table.Td>
              <Table.Td>
                <Textarea
                  size="xs"
                  variant="filled"
                  aria-label="Current Notes"
                  placeholder="Private notes"
                  autosize
                  minRows={1}
                  maxRows={6}
                  value={notes ?? result.notes ?? ""}
                  onChange={(e) => setNotes(e.currentTarget.value)}
                />
              </Table.Td>
              <Table.Td />
              <Table.Td>
                <Text size="xs" c="dimmed" pt={TEXT_TOP + 2}>
                  Only in this library
                </Text>
              </Table.Td>
              <Table.Td>{notesChanged && <StatusText status="edited" />}</Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {emptyCount > 0 && (
        <Group>
          <Anchor component="button" type="button" size="sm" onClick={() => setShowEmpty((v) => !v)}>
            {showEmpty ? `Hide ${plural(emptyCount, "empty field")}` : `Show ${plural(emptyCount, "empty field")}`}
          </Anchor>
        </Group>
      )}
      <Text size="xs" c="dimmed">
        Tick a value to take it from {source}, or edit the current one by hand. Applying marks the metadata as confirmed by {source}: it is kept
        even if the book's files are removed.
      </Text>

      {/* Always in reach, however long the comparison is. */}
      <Box
        py="sm"
        style={{
          position: "sticky",
          bottom: 0,
          zIndex: 2,
          background: "var(--mantine-color-body)",
          borderTop: "1px solid var(--mantine-color-default-border)",
        }}
      >
        {apply.isError && (
          <Text size="sm" c="red" mb="xs">
            {apply.error.message}
          </Text>
        )}
        <Group justify="space-between" wrap="nowrap" gap="md">
          <Text size="sm" c={summary.length ? undefined : "dimmed"}>
            {summary.length ? `Will apply ${summary.join(", ")}.` : "Nothing selected: applying confirms the current metadata as correct."}
          </Text>
          <Group gap="xs" wrap="nowrap">
            {onSkip && (
              <Button variant="default" onClick={onSkip} loading={skipping}>
                Skip
              </Button>
            )}
            <Button onClick={() => apply.mutate()} loading={apply.isPending} disabled={titleMissing}>
              {changeCount === 0 ? "Confirm as correct" : `Apply ${changeCount} change${changeCount === 1 ? "" : "s"}`}
            </Button>
          </Group>
        </Group>
      </Box>
    </Stack>
  );
}

function FieldName({ children }: { children: React.ReactNode }) {
  return (
    <Text size="sm" fw={500} pt={TEXT_TOP}>
      {children}
    </Text>
  );
}

const STATUS_TEXT: Partial<Record<DiffStatus | "edited", { label: string; color: string; hint: string }>> = {
  fill: { label: "new", color: "teal.7", hint: "The book has no value here" },
  conflict: { label: "differs", color: "orange.7", hint: "The book has a different value" },
  edited: { label: "edited", color: "blue.7", hint: "Changed by hand" },
};

/** Only what needs attention is marked: same or empty values say nothing. */
function StatusText({ status }: { status: DiffStatus | "edited" }) {
  const s = STATUS_TEXT[status];
  return s ? (
    <Text size="xs" fw={600} c={s.color} title={s.hint} pt={TEXT_TOP + 2}>
      {s.label}
    </Text>
  ) : null;
}

const isEmpty = (v: FieldValue | undefined) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
