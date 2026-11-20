import { useEffect, useState } from "react";
import { Alert, Badge, Button, Center, Checkbox, Group, Loader, Pagination, Paper, Stack, Table, Text, TextInput, Title, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { SwapSuspectDto, TitleAuthorFix } from "../../../shared/types.ts";
import { api } from "../../api/client.ts";
import { useInvalidateBooks } from "../../api/hooks.ts";
import { AuthorsInput } from "../AuthorsInput.tsx";
import { BookLink } from "./BookLinks.tsx";

const PER_PAGE = 10;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

interface Draft {
  title: string;
  authors: string[];
  checked: boolean;
}

/** The suggested fix, ticked when it comes from the file's name (the surer kind). */
const draftOf = (s: SwapSuspectDto): Draft => ({ ...s.proposed, checked: s.basis === "filename" });

/** Drafts for the current suspects: edits survive a refresh, other suspects show their suggestion. */
const syncDrafts = (prev: Record<number, Draft>, list: readonly SwapSuspectDto[]): Record<number, Draft> =>
  Object.fromEntries(list.map((s) => [s.id, prev[s.id] ?? draftOf(s)]));

const BASIS = {
  filename: { label: "from filename", color: "teal", hint: "The book's file name, read again, has the title and author the other way round" },
  swap: { label: "swap?", color: "yellow", hint: "The title reads like a person's name and the author like a title: check before swapping" },
} as const;

function SuspectRow({ suspect, draft, onChange }: { suspect: SwapSuspectDto; draft: Draft; onChange: (d: Draft) => void }) {
  const basis = BASIS[suspect.basis];
  return (
    <Table.Tr>
      <Table.Td w={40} style={{ verticalAlign: "top" }}>
        <Checkbox
          mt={6}
          checked={draft.checked}
          onChange={(e) => onChange({ ...draft, checked: e.currentTarget.checked })}
          aria-label={`Fix ${suspect.title}`}
        />
      </Table.Td>
      <Table.Td>
        <Stack gap={6}>
          <Group gap="xs" wrap="nowrap" justify="space-between" align="flex-start">
            <Text size="sm" c="dimmed">
              Now: <BookLink id={suspect.id} title={suspect.title} size="sm" /> by <b>{suspect.authors.join(", ")}</b>
            </Text>
            <Tooltip label={basis.hint} multiline w={260}>
              <Badge variant="light" color={basis.color} style={{ flexShrink: 0 }}>
                {basis.label}
              </Badge>
            </Tooltip>
          </Group>
          <TextInput
            label="Title"
            value={draft.title}
            onChange={(e) => onChange({ ...draft, title: e.currentTarget.value })}
            error={draft.title.trim() ? null : "The title is empty"}
          />
          <AuthorsInput label="Authors" value={draft.authors} onChange={(authors) => onChange({ ...draft, authors })} />
          {suspect.files.map((f) => (
            <Text key={f} size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
              {f}
            </Text>
          ))}
        </Stack>
      </Table.Td>
    </Table.Tr>
  );
}

/** Settings › Swapped titles and authors: find books stored the wrong way round and fix them. */
export function SwapPanel() {
  const suspects = useQuery({ queryKey: ["cleanup", "swaps"], queryFn: api.swapSuspects, retry: false });
  const list = suspects.data ?? [];
  const [edits, setEdits] = useState<Record<number, Draft>>({});
  const drafts = syncDrafts(edits, list);
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages]);

  const invalidate = useInvalidateBooks();
  const fix = useMutation({
    mutationFn: (items: TitleAuthorFix[]) => api.fixTitleAuthor({ items }),
    onSuccess: (r) => {
      invalidate();
      notifications.show({
        color: r.errors.length ? "yellow" : "teal",
        title: "Titles and authors fixed",
        message:
          [`${plural(r.books, "book")} updated`, r.renamed.length ? `${plural(r.renamed.length, "file")} renamed` : ""].filter(Boolean).join(", ") +
          (r.errors.length ? `. ${plural(r.errors.length, "file")} could not be renamed: ${r.errors[0]}` : "."),
      });
    },
    onError: (e) => notifications.show({ color: "red", message: e.message }),
  });

  const chosen = list.filter((s) => drafts[s.id]?.checked);
  const valid = chosen.every((s) => drafts[s.id]!.title.trim());
  const shown = list.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const setAll = (checked: boolean) => setEdits(Object.fromEntries(Object.entries(drafts).map(([id, d]) => [id, { ...d, checked }])));

  return (
    <Paper withBorder p="md">
      <Stack gap="md">
        <Title order={4}>Swapped titles and authors</Title>
        <Text size="sm" c="dimmed">
          Books whose title reads like a person's name and whose author reads like a title, usually from files named “Title - Author”. Check the
          suggested fix (you can edit it), tick the books to fix and apply: their files are renamed to match. Confirmed books aren't listed.
        </Text>
        {suspects.isLoading ? (
          <Center py="md">
            <Loader size="sm" />
          </Center>
        ) : suspects.isError ? (
          <Alert color="yellow">{suspects.error.message}</Alert>
        ) : list.length === 0 ? (
          <Text size="md">No swapped titles and authors found.</Text>
        ) : (
          <Stack gap="xs">
            <Group justify="space-between">
              <Checkbox
                label={`${plural(list.length, "book")} to check`}
                checked={chosen.length === list.length}
                indeterminate={chosen.length > 0 && chosen.length < list.length}
                onChange={(e) => setAll(e.currentTarget.checked)}
              />
              <Button
                disabled={!chosen.length || !valid}
                loading={fix.isPending}
                onClick={() => fix.mutate(chosen.map((s) => ({ id: s.id, title: drafts[s.id]!.title.trim(), authors: drafts[s.id]!.authors })))}
              >
                Fix {plural(chosen.length, "book")}
              </Button>
            </Group>
            <Table withTableBorder withRowBorders verticalSpacing="sm" horizontalSpacing="sm">
              <Table.Tbody>
                {shown.map((s) => (
                  <SuspectRow key={s.id} suspect={s} draft={drafts[s.id]!} onChange={(d) => setEdits((prev) => ({ ...prev, [s.id]: d }))} />
                ))}
              </Table.Tbody>
            </Table>
            {pages > 1 && <Pagination total={pages} value={page} onChange={setPage} />}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
