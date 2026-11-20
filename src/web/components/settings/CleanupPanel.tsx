import { useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Anchor,
  Autocomplete,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  Collapse,
  Group,
  Loader,
  Pagination,
  Paper,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  type MantineSize,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconChevronDown, IconChevronRight, IconExternalLink, IconSearch, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AuthorSource, CleanupField, FacetDto, NameGroupDto, NameMatchKind } from "../../../shared/types.ts";
import { api } from "../../api/client.ts";
import { useInvalidateBooks } from "../../api/hooks.ts";
import { BooksWithName } from "./BookLinks.tsx";

const FIELDS: { value: CleanupField; label: string; noun: string }[] = [
  { value: "authors", label: "Authors", noun: "author" },
  { value: "tags", label: "Tags", noun: "tag" },
  { value: "series", label: "Series", noun: "series" },
  { value: "publishers", label: "Publishers", noun: "publisher" },
];
const nounOf = (field: CleanupField) => FIELDS.find((f) => f.value === field)!.noun;

const MATCH: Record<NameMatchKind, { label: string; color: string; hint: string }> = {
  main: { label: "most used", color: "teal", hint: "The spelling most books use" },
  case: { label: "case", color: "teal", hint: "Differs only in letter case, accents or spacing" },
  punctuation: { label: "punctuation", color: "teal", hint: "Differs in punctuation or name order" },
  typo: { label: "typo?", color: "yellow", hint: "A letter or two different: check it is the same" },
  initials: { label: "initials?", color: "yellow", hint: "Initials instead of given names: check it is the same person" },
  similar: { label: "similar?", color: "gray", hint: "Only similar to another spelling in this group" },
};

const GROUPS_PER_PAGE = 10;
const SINGLES_PER_PAGE = 20;
const plural = (n: number, w: string, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;

/** Merge names into one, with the result reported and every view of the books refreshed. */
function useMergeNames(field: CleanupField, onDone?: () => void) {
  const invalidate = useInvalidateBooks();
  return useMutation({
    mutationFn: ({ from, to }: { from: string[]; to: string }) => api.mergeNames({ field, from, to }),
    onSuccess: (r, { to }) => {
      invalidate();
      notifications.show({
        color: r.errors.length ? "yellow" : "teal",
        title: `Merged into “${to}”`,
        message:
          [`${plural(r.books, "book")} updated`, r.renamed.length ? `${plural(r.renamed.length, "file")} renamed` : ""].filter(Boolean).join(", ") +
          (r.errors.length ? `. ${plural(r.errors.length, "file")} could not be renamed: ${r.errors[0]}` : "."),
      });
      onDone?.();
    },
    onError: (e) => notifications.show({ color: "red", message: e.message }),
  });
}

const SOURCE_NAME: Record<AuthorSource, string> = { wikidata: "Wikidata", openlibrary: "Open Library" };

/** Text sizes: names stand out, details stay readable. */
const NAME: MantineSize = "md";
const DETAIL: MantineSize = "sm";

/** Authors matching a name (Wikidata, else Open Library); clicking one picks its spelling. */
function AuthorMatches({ q, onPick }: { q: string; onPick: (name: string) => void }) {
  // undefined: Wikidata, falling back to Open Library; "openlibrary": asked for by hand.
  const [source, setSource] = useState<AuthorSource | undefined>(undefined);
  const search = useQuery({
    queryKey: ["authorSearch", q, source ?? "auto"],
    queryFn: () => api.searchAuthors(q, source),
    staleTime: Infinity,
    retry: false,
  });
  if (search.isLoading)
    return (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size={DETAIL} c="dimmed">
          Looking up “{q}”…
        </Text>
      </Group>
    );
  if (search.isError) return <Text size={DETAIL} c="red">{search.error.message}</Text>;
  const data = search.data!;
  const switcher =
    data.source === "wikidata" ? (
      <Button size="compact-sm" variant="subtle" onClick={() => setSource("openlibrary")}>
        Search Open Library instead
      </Button>
    ) : source === "openlibrary" ? (
      <Button size="compact-sm" variant="subtle" onClick={() => setSource(undefined)}>
        Back to Wikidata
      </Button>
    ) : null;

  return (
    <Stack gap="xs">
      <Group justify="space-between" gap="xs">
        <Text size={DETAIL} c="dimmed">
          {data.note ? `${data.note} ` : ""}
          {data.matches.length
            ? `From ${SOURCE_NAME[data.source]}. Click a name to use it:`
            : `No author called “${q}” on ${SOURCE_NAME[data.source]} either. Type the name to use instead.`}
        </Text>
        {switcher}
      </Group>
      {data.matches.map((a) => (
        <Group key={`${a.source}:${a.key}`} gap="xs" wrap="nowrap" justify="space-between" align="flex-start">
          <Stack gap={4} style={{ minWidth: 0 }}>
            <UnstyledButton onClick={() => onPick(a.name)} aria-label={`Use ${a.name}`}>
              <Text size={NAME} fw={600} span>
                {a.name}
              </Text>
              <Text size={DETAIL} c="dimmed" span>
                {[
                  a.years,
                  a.description,
                  a.topWork,
                  a.workCount ? plural(a.workCount, "work") : null,
                  a.alternateNames[0] && a.alternateNames[0] !== a.name ? `also “${a.alternateNames[0]}”` : null,
                ]
                  .filter(Boolean)
                  .map((x) => ` · ${x}`)}
              </Text>
            </UnstyledButton>
            {a.authorities.length > 0 && (
              <Group gap={6}>
                {a.authorities.map((r) => (
                  <Tooltip key={r.name} label={`${a.name} in the ${r.name} records`}>
                    <Badge component="a" href={r.url} target="_blank" rel="noreferrer" size="sm" variant="outline" color="gray" style={{ cursor: "pointer" }}>
                      {r.name}
                    </Badge>
                  </Tooltip>
                ))}
              </Group>
            )}
          </Stack>
          <Anchor href={a.url} target="_blank" rel="noreferrer" aria-label={`${a.name} on ${SOURCE_NAME[a.source]}`}>
            <IconExternalLink size={16} />
          </Anchor>
        </Group>
      ))}
    </Stack>
  );
}

/** Opens or folds a row. */
function RowToggle({ open, onToggle, name }: { open: boolean; onToggle: () => void; name: string }) {
  return (
    <ActionIcon variant="subtle" color="gray" onClick={onToggle} aria-expanded={open} aria-label={`${open ? "Fold" : "Open"} ${name}`}>
      {open ? <IconChevronDown size={18} /> : <IconChevronRight size={18} />}
    </ActionIcon>
  );
}

/** Fetches matches for an author from Wikidata/Open Library; separate from opening the row. */
function LookupButton({ name, active, onClick }: { name: string; active: boolean; onClick: () => void }) {
  return (
    <Button size="xs" variant={active ? "filled" : "light"} leftSection={<IconSearch size={14} />} onClick={onClick} aria-label={`Look up ${name}`}>
      Look up
    </Button>
  );
}

/** A row's book count; clicking it opens the row, which lists the books. */
function BookCount({ count, open, onToggle, name }: { count: number; open: boolean; onToggle: () => void; name: string }) {
  return (
    <Anchor component="button" type="button" size={DETAIL} onClick={onToggle} aria-label={`${open ? "Hide" : "Show"} the books of ${name}`}>
      {plural(count, "book")}
    </Anchor>
  );
}

/** What opens below a row: the name to keep (or rename to) and, once looked up, the matches. */
function RowDetails({ children, colSpan }: { children: React.ReactNode; colSpan: number }) {
  return (
    <Table.Tr>
      <Table.Td colSpan={colSpan} bg="var(--mantine-color-default-hover)">
        <Box pl={36} py={4}>
          <Stack gap="sm">{children}</Stack>
        </Box>
      </Table.Td>
    </Table.Tr>
  );
}

function GroupRow({ field, group }: { field: CleanupField; group: NameGroupDto }) {
  const [open, setOpen] = useState(false);
  const [lookedUp, setLookedUp] = useState(false);
  const [checked, setChecked] = useState(() => new Set(group.variants.filter((v) => v.preselected).map((v) => v.name)));
  const [target, setTarget] = useState(group.main);
  const merge = useMergeNames(field);
  const to = target.replace(/\s+/g, " ").trim();
  const from = group.variants.map((v) => v.name).filter((n) => checked.has(n) && n !== to);
  const others = group.variants.filter((v) => v.name !== group.main);
  const books = group.variants.reduce((n, v) => n + v.books, 0);
  const toggle = (n: string) => setChecked((prev) => (prev.has(n) ? new Set([...prev].filter((x) => x !== n)) : new Set([...prev, n])));
  const authors = field === "authors";

  return (
    <>
      <Table.Tr>
        <Table.Td w={44}>
          <RowToggle open={open} onToggle={() => setOpen((o) => !o)} name={group.main} />
        </Table.Td>
        <Table.Td>
          <Text size={NAME} fw={600}>
            {to || group.main}
          </Text>
          <Text size={DETAIL} c="dimmed" lineClamp={open ? undefined : 1}>
            also {others.map((v) => `“${v.name}”`).join(", ")}
          </Text>
        </Table.Td>
        <Table.Td w={90}>
          <BookCount count={books} open={open} onToggle={() => setOpen((o) => !o)} name={group.main} />
        </Table.Td>
        <Table.Td w={authors ? 230 : 130}>
          <Group gap="xs" justify="flex-end" wrap="nowrap">
            {authors && (
              <LookupButton
                name={group.main}
                active={lookedUp}
                onClick={() => {
                  setLookedUp(true);
                  setOpen(true);
                }}
              />
            )}
            <Tooltip label={from.length ? `Merge ${from.map((n) => `“${n}”`).join(", ")} into “${to}”` : "Tick the spellings to merge"}>
              <Button size="xs" disabled={!to || from.length === 0} loading={merge.isPending} onClick={() => merge.mutate({ from, to })} aria-label={`Merge ${from.length} into ${to}`}>
                Merge {from.length || ""}
              </Button>
            </Tooltip>
          </Group>
        </Table.Td>
      </Table.Tr>
      {open && (
        <RowDetails colSpan={4}>
          <Stack gap="sm">
            {group.variants.map((v) => (
              <Stack key={v.name} gap={2}>
                <Group gap="sm" wrap="nowrap">
                  <Checkbox checked={checked.has(v.name)} onChange={() => toggle(v.name)} label={<Text size={NAME}>{v.name}</Text>} aria-label={`Merge ${v.name}`} />
                  <Text size={DETAIL} c="dimmed">
                    {plural(v.books, "book")}
                  </Text>
                  <Tooltip label={MATCH[v.match].hint}>
                    <Badge size="sm" variant="light" color={MATCH[v.match].color}>
                      {MATCH[v.match].label}
                    </Badge>
                  </Tooltip>
                </Group>
                <Box pl={32}>
                  <BooksWithName field={field} name={v.name} size={DETAIL} />
                </Box>
              </Stack>
            ))}
          </Stack>
          {authors ? (
            <TextInput label="Name to keep" value={target} onChange={(e) => setTarget(e.currentTarget.value)} maw={480} />
          ) : (
            <Autocomplete label="Name to keep" value={target} onChange={setTarget} data={group.variants.map((v) => v.name)} maw={480} />
          )}
          {lookedUp && <AuthorMatches q={group.main} onPick={setTarget} />}
        </RowDetails>
      )}
    </>
  );
}

/** A lone author name, renamed to a looked-up (or typed) spelling. */
function SingleRow({ entry }: { entry: FacetDto }) {
  const [open, setOpen] = useState(false);
  const [lookedUp, setLookedUp] = useState(false);
  const [target, setTarget] = useState(entry.name);
  const merge = useMergeNames("authors", () => setOpen(false));
  const to = target.replace(/\s+/g, " ").trim();
  const changed = !!to && to !== entry.name;
  return (
    <>
      <Table.Tr>
        <Table.Td w={44}>
          <RowToggle open={open} onToggle={() => setOpen((o) => !o)} name={entry.name} />
        </Table.Td>
        <Table.Td>
          <Text size={NAME}>{entry.name}</Text>
          {changed && (
            <Text size={DETAIL} c="dimmed">
              → {to}
            </Text>
          )}
        </Table.Td>
        <Table.Td w={90}>
          <BookCount count={entry.count} open={open} onToggle={() => setOpen((o) => !o)} name={entry.name} />
        </Table.Td>
        <Table.Td w={230}>
          <Group gap="xs" justify="flex-end" wrap="nowrap">
            <LookupButton
              name={entry.name}
              active={lookedUp}
              onClick={() => {
                setLookedUp(true);
                setOpen(true);
              }}
            />
            <Button size="xs" disabled={!changed} loading={merge.isPending} onClick={() => merge.mutate({ from: [entry.name], to })} aria-label={`Rename ${entry.name}`}>
              Rename
            </Button>
          </Group>
        </Table.Td>
      </Table.Tr>
      {open && (
        <RowDetails colSpan={4}>
          <BooksWithName field="authors" name={entry.name} size={DETAIL} />
          <TextInput label="Rename to" value={target} onChange={(e) => setTarget(e.currentTarget.value)} maw={480} />
          {lookedUp && <AuthorMatches q={entry.name} onPick={setTarget} />}
        </RowDetails>
      )}
    </>
  );
}

/** Bordered table with a line between rows; rows bring their own folded details. */
function RowsTable({ children }: { children: React.ReactNode }) {
  return (
    <Table withTableBorder withRowBorders verticalSpacing="sm" horizontalSpacing="sm">
      <Table.Tbody>{children}</Table.Tbody>
    </Table>
  );
}

function OtherAuthors({ singles }: { singles: FacetDto[] }) {
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const shown = singles.filter((s) => s.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const pages = Math.max(1, Math.ceil(shown.length / SINGLES_PER_PAGE));
  useEffect(() => setPage(1), [filter]);
  return (
    <Stack gap="xs">
      <Group justify="space-between" align="flex-end">
        <div>
          <Text fw={600} size={NAME}>
            Other authors
          </Text>
          <Text size={DETAIL} c="dimmed">
            Names with a single spelling. Look one up to replace it with the spelling from Wikidata (or Open Library).
          </Text>
        </div>
        <TextInput placeholder="Filter" leftSection={<IconSearch size={16} />} value={filter} onChange={(e) => setFilter(e.currentTarget.value)} aria-label="Filter authors" />
      </Group>
      {shown.length ? (
        <RowsTable>
          {shown.slice((page - 1) * SINGLES_PER_PAGE, page * SINGLES_PER_PAGE).map((s) => (
            <SingleRow key={s.name} entry={s} />
          ))}
        </RowsTable>
      ) : (
        <Text size={DETAIL} c="dimmed">
          No authors.
        </Text>
      )}
      {pages > 1 && <Pagination total={pages} value={page} onChange={setPage} />}
    </Stack>
  );
}

function RememberedAliases() {
  const [open, setOpen] = useState(false);
  const aliases = useQuery({ queryKey: ["cleanup", "aliases"], queryFn: api.aliases });
  const invalidate = useInvalidateBooks();
  const remove = useMutation({
    mutationFn: ({ field, variant }: { field: CleanupField; variant: string }) => api.removeAlias(field, variant),
    onSuccess: invalidate,
    onError: (e) => notifications.show({ color: "red", message: e.message }),
  });
  const list = aliases.data ?? [];
  return (
    <Stack gap="xs">
      <UnstyledButton onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Group gap={6}>
          {open ? <IconChevronDown size={18} /> : <IconChevronRight size={18} />}
          <Text fw={600} size={NAME}>
            Remembered spellings ({list.length})
          </Text>
        </Group>
      </UnstyledButton>
      <Collapse expanded={open}>
        {list.length === 0 ? (
          <Text size={DETAIL} c="dimmed">
            None yet. Merged spellings are listed here; new books and lookups use the name they were merged into.
          </Text>
        ) : (
          <RowsTable>
            {list.map((a) => (
              <Table.Tr key={`${a.field}:${a.variant}`}>
                <Table.Td w={110}>
                  <Text size={DETAIL} c="dimmed">
                    {FIELDS.find((f) => f.value === a.field)?.label}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size={NAME}>
                    {a.variant} → <b>{a.canonical}</b>
                  </Text>
                </Table.Td>
                <Table.Td w={50}>
                  <Tooltip label="Forget this spelling">
                    <ActionIcon variant="subtle" color="red" onClick={() => remove.mutate(a)} aria-label={`Forget ${a.variant}`}>
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Table.Td>
              </Table.Tr>
            ))}
          </RowsTable>
        )}
      </Collapse>
    </Stack>
  );
}

/** Settings › Clean up names: merge spelling variants of authors, tags, series and publishers. */
export function CleanupPanel() {
  const [field, setField] = useState<CleanupField>("authors");
  const [page, setPage] = useState(1);
  const groups = useQuery({ queryKey: ["cleanup", "groups", field], queryFn: () => api.nameGroups(field), retry: false });
  const list = groups.data?.groups ?? [];
  const pages = Math.max(1, Math.ceil(list.length / GROUPS_PER_PAGE));
  useEffect(() => setPage(1), [field]);
  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages]);
  const noun = nounOf(field);

  return (
    <Paper withBorder p="md">
      <Stack gap="md">
        <Group justify="space-between">
          <Title order={4}>Clean up names</Title>
          <SegmentedControl value={field} onChange={(v) => setField(v as CleanupField)} data={FIELDS} />
        </Group>
        <Text size={DETAIL} c="dimmed">
          Spellings that look like the same {noun} are grouped. Open a row to tick the spellings to merge and choose the name to keep:
          books get that name{field === "authors" ? " (their files are renamed to match)" : ""}, and the other spellings are remembered
          so new books and lookups use it too.
        </Text>
        {groups.isLoading ? (
          <Center py="md">
            <Loader size="sm" />
          </Center>
        ) : groups.isError ? (
          <Alert color="yellow">{groups.error.message}</Alert>
        ) : (
          <>
            {list.length === 0 ? (
              <Text size={NAME}>No similar spellings found.</Text>
            ) : (
              <Stack gap="xs">
                <Text size={DETAIL} c="dimmed">
                  {plural(list.length, "group")} of similar spellings
                </Text>
                <RowsTable>
                  {list.slice((page - 1) * GROUPS_PER_PAGE, page * GROUPS_PER_PAGE).map((g) => (
                    <GroupRow key={`${field}:${g.variants.map((v) => v.name).join("|")}`} field={field} group={g} />
                  ))}
                </RowsTable>
                {pages > 1 && <Pagination total={pages} value={page} onChange={setPage} />}
              </Stack>
            )}
            {field === "authors" && <OtherAuthors singles={groups.data?.singles ?? []} />}
          </>
        )}
        <RememberedAliases />
      </Stack>
    </Paper>
  );
}
