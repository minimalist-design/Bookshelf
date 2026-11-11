import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconEraser, IconDatabaseX, IconFileTypography, IconRefresh, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../api/client.ts";
import { useInvalidateBooks, useLibraryStatus, useShelves } from "../../api/hooks.ts";

const SOURCE = { openlibrary: "Open Library", doi: "DOI", manual: "Edited" } as const;

function bytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const plural = (n: number, w: string, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;

export function MaintenancePanel() {
  const invalidate = useInvalidateBooks();
  const status = useLibraryStatus();
  const shelves = useShelves();
  const stats = useQuery({ queryKey: ["maintenance", "stats"], queryFn: api.maintenanceStats });
  const missing = useQuery({ queryKey: ["maintenance", "missing"], queryFn: api.missingBooks, retry: false });
  const [scope, setScope] = useState<string>("__all__");
  const [confirmNormalize, setConfirmNormalize] = useState(false);
  const [confirmForgetAll, setConfirmForgetAll] = useState(false);
  const onError = (e: Error) => notifications.show({ color: "red", message: e.message });

  const rescan = useMutation({ mutationFn: api.rescan, onSuccess: invalidate, onError });
  const forget = useMutation({
    mutationFn: (ids: number[]) => api.forgetBooks(ids),
    onSuccess: (r) => {
      invalidate();
      setConfirmForgetAll(false);
      notifications.show({ color: "teal", message: `Forgot ${plural(r.removedBooks, "book")}` });
    },
    onError,
  });
  const cleanup = useMutation({
    mutationFn: api.cleanup,
    onSuccess: (r) => {
      invalidate();
      notifications.show({ color: "teal", message: `Removed ${plural(r.removedBooks, "unconfirmed entry", "unconfirmed entries")} and ${plural(r.removedCoverFiles, "unused cover file")}` });
    },
    onError,
  });
  const normalize = useMutation({
    mutationFn: () => api.normalizeAll(scope === "__all__" ? undefined : scope === "__unshelved__" ? "" : scope),
    onSuccess: (r) => {
      invalidate();
      setConfirmNormalize(false);
      notifications.show({
        color: r.errors.length ? "yellow" : "teal",
        title: r.renamed.length ? `Renamed ${plural(r.renamed.length, "file")}` : "All filenames already match",
        message: r.errors.length ? `${plural(r.errors.length, "file")} could not be renamed: ${r.errors[0]}` : undefined,
      });
    },
    onError,
  });
  const clearCache = useMutation({
    mutationFn: api.clearHttpCache,
    onSuccess: (r) => {
      invalidate();
      notifications.show({ message: `Cleared ${plural(r.removed, "cached response")}` });
    },
    onError,
  });

  const s = stats.data;
  const lib = status.data;
  const confirmedMissing = (missing.data ?? []).filter((m) => m.confirmedSource);
  const scopeLabel =
    scope === "__all__" ? "the whole library" : scope === "__unshelved__" ? "Unshelved" : `the “${scope}” shelf`;

  return (
    <>
      <Paper withBorder p="md">
        <Stack gap="xs">
          <Group justify="space-between">
            <Title order={4}>Library status</Title>
            <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} loading={rescan.isPending || lib?.state === "scanning"} onClick={() => rescan.mutate()}>
              Rescan now
            </Button>
          </Group>
          {lib && (
            <Group gap="xs">
              <Badge color={lib.state === "ready" ? "teal" : lib.state === "scanning" ? "blue" : "red"} variant="light">
                {lib.state}
              </Badge>
              <Badge color={lib.watching ? "teal" : "yellow"} variant="light">
                {lib.watching ? "watching for changes" : "periodic rescans"}
              </Badge>
              {lib.message && (
                <Text size="sm" c="dimmed">
                  {lib.message}
                </Text>
              )}
            </Group>
          )}
          {s && (
            <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs" mt="xs">
              <Stat label="Books on disk" value={s.booksOnDisk} />
              <Stat label="Files" value={s.filesOnDisk} />
              <Stat label="Confirmed" value={s.confirmed} />
              <Stat label="Without files" value={s.missing} />
              <Stat label="Cover images" value={bytes(s.coverBytes)} />
              <Stat label="Database" value={bytes(s.databaseBytes)} />
              <Stat label="Lookup cache" value={s.httpCacheEntries} />
              <Stat label="Review queue" value={s.reviewQueue} />
            </SimpleGrid>
          )}
        </Stack>
      </Paper>

      <Paper withBorder p="md">
        <Stack gap="xs">
          <Title order={4}>Metadata of books without files</Title>
          <Text size="sm" c="dimmed">
            Confirmed metadata (looked up or edited) is kept when a book's files disappear, so it is recognized again if they
            come back. Forget entries you won't restore.
          </Text>
          {missing.isError ? (
            <Alert color="yellow">{missing.error.message}</Alert>
          ) : confirmedMissing.length === 0 ? (
            <Text size="sm">None.</Text>
          ) : (
            <>
              <ScrollArea.Autosize mah={320}>
                <Table verticalSpacing={4}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Title</Table.Th>
                      <Table.Th>Authors</Table.Th>
                      <Table.Th>Identifier</Table.Th>
                      <Table.Th>Confirmed by</Table.Th>
                      <Table.Th w={40} />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {confirmedMissing.map((m) => (
                      <Table.Tr key={m.id}>
                        <Table.Td>
                          <Text size="sm">{m.title}</Text>
                          <Text size="xs" c="dimmed">
                            {m.formats.map((f) => f.toUpperCase()).join(" · ")}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{m.authors.join(", ")}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" ff="monospace">
                            {m.isbn13 ?? m.doi ?? "—"}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{m.confirmedSource ? SOURCE[m.confirmedSource] : "—"}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Tooltip label="Forget">
                            <Button size="compact-xs" variant="subtle" color="red" onClick={() => forget.mutate([m.id])} aria-label={`Forget ${m.title}`}>
                              <IconTrash size={14} />
                            </Button>
                          </Tooltip>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea.Autosize>
              <Group>
                <Button size="xs" variant="light" color="red" leftSection={<IconDatabaseX size={14} />} onClick={() => setConfirmForgetAll(true)}>
                  Forget all {confirmedMissing.length}
                </Button>
              </Group>
            </>
          )}
        </Stack>
      </Paper>

      <Paper withBorder p="md">
        <Stack gap="sm">
          <Title order={4}>Housekeeping</Title>
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <div>
              <Text size="sm" fw={500}>
                Remove unconfirmed metadata without files
              </Text>
              <Text size="xs" c="dimmed">
                Normally automatic; needed only after a scan that found an empty library (e.g. an unmounted drive). Also
                deletes unused cover images.
                {s ? ` Currently ${plural(s.missingUnconfirmed, "entry", "entries")} and ${plural(s.orphanCoverFiles, "unused cover file")}.` : ""}
              </Text>
            </div>
            <Button size="xs" variant="light" leftSection={<IconEraser size={14} />} loading={cleanup.isPending} onClick={() => cleanup.mutate()}>
              Clean up
            </Button>
          </Group>
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <div style={{ flex: 1 }}>
              <Text size="sm" fw={500}>
                Normalize filenames
              </Text>
              <Text size="xs" c="dimmed" mb={6}>
                Rename files to “Author - Title [ISBN/DOI]”. Metadata is not changed.
              </Text>
              <Select
                size="xs"
                maw={280}
                value={scope}
                onChange={(v) => v && setScope(v)}
                allowDeselect={false}
                data={[
                  { value: "__all__", label: "Whole library" },
                  { value: "__unshelved__", label: "Unshelved" },
                  ...(shelves.data ?? []).filter((x) => x.name !== null).map((x) => ({ value: x.name!, label: x.name! })),
                ]}
                aria-label="Scope"
              />
            </div>
            <Button size="xs" variant="light" leftSection={<IconFileTypography size={14} />} onClick={() => setConfirmNormalize(true)}>
              Normalize…
            </Button>
          </Group>
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <div>
              <Text size="sm" fw={500}>
                Clear lookup cache
              </Text>
              <Text size="xs" c="dimmed">
                Open Library and Crossref answers are cached for a week; clear to fetch fresh data.
              </Text>
            </div>
            <Button size="xs" variant="light" loading={clearCache.isPending} onClick={() => clearCache.mutate()}>
              Clear
            </Button>
          </Group>
        </Stack>
      </Paper>

      <Modal opened={confirmNormalize} onClose={() => setConfirmNormalize(false)} title="Normalize filenames">
        <Stack>
          <Text size="sm">Every book file in {scopeLabel} that doesn't already follow “Author - Title [ID]” will be renamed.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmNormalize(false)}>
              Cancel
            </Button>
            <Button loading={normalize.isPending} onClick={() => normalize.mutate()}>
              Rename files
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal opened={confirmForgetAll} onClose={() => setConfirmForgetAll(false)} title="Forget metadata">
        <Stack>
          <Text size="sm">
            Permanently delete the saved metadata of {plural(confirmedMissing.length, "book")} whose files are gone. If a file comes
            back later it is imported as new.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmForgetAll(false)}>
              Cancel
            </Button>
            <Button color="red" loading={forget.isPending} onClick={() => forget.mutate(confirmedMissing.map((m) => m.id))}>
              Forget all
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={600}>{value}</Text>
    </div>
  );
}
