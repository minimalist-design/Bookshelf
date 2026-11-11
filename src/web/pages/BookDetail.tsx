import { useState, type ReactNode } from "react";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Center,
  FileButton,
  Grid,
  Group,
  Loader,
  Menu,
  Paper,
  Rating,
  Spoiler,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconArrowLeft,
  IconCloudSearch,
  IconBook,
  IconDownload,
  IconDots,
  IconEdit,
  IconFileTypography,
  IconGitMerge,
  IconPhotoUp,
  IconPhotoX,
  IconTrash,
  IconUnlink,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import type { BookDetailDto, BookFileDto } from "../../shared/types.ts";
import { api } from "../api/client.ts";
import { useBook, useInvalidateBooks, useUpdateBook } from "../api/hooks.ts";
import { EditBookModal } from "../components/book/EditBookModal.tsx";
import { MergeModal } from "../components/book/MergeModal.tsx";
import { LookupModal } from "../components/lookup/LookupModal.tsx";
import { downloadUrl, isReadable, READABLE, readerUrl } from "../components/reader/fileUrls.ts";
import { CoverThumb } from "../components/CoverThumb.tsx";
import { DeleteBooksModal } from "../components/book/DeleteBooksModal.tsx";
import { ConfirmedMark } from "../components/library/BookCards.tsx";
import { MoveToSubmenu } from "../components/library/MoveToMenu.tsx";
import { useBookActions } from "../components/library/useBookActions.ts";

const CONFIRMED_LABEL = { openlibrary: "Confirmed · Open Library", doi: "Confirmed · DOI", manual: "Confirmed · edited" } as const;
const SOURCE_LABEL = { embedded: "From the file's metadata", filename: "From the filename", mixed: "From file metadata and filename" } as const;

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function BookDetail() {
  const id = Number(useParams().id);
  const book = useBook(Number.isFinite(id) ? id : null);
  const navigate = useNavigate();

  if (book.isLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (!book.data) {
    return (
      <Stack align="flex-start">
        <Alert color="yellow" title="Book not found">
          It may have been removed from the library directory.
        </Alert>
        <Button variant="default" leftSection={<IconArrowLeft size={16} />} onClick={() => navigate(-1)}>
          Back
        </Button>
      </Stack>
    );
  }
  return <BookView book={book.data} />;
}

function BookView({ book }: { book: BookDetailDto }) {
  const navigate = useNavigate();
  const invalidate = useInvalidateBooks();
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const onError = (e: Error) => notifications.show({ color: "red", message: e.message });
  // undefined = closed, null = whole book, string = one file (hash)
  const [deleting, setDeleting] = useState<string | null | undefined>(undefined);
  const { move, remove } = useBookActions();
  const removeFile = useMutation({
    mutationFn: (hash: string) => api.deleteFile(book.id, hash),
    onSuccess: (r) => {
      invalidate();
      setDeleting(undefined);
      notifications.show({
        color: "teal",
        message: `Deleted ${r.deletedFiles[0] ?? "file"}${r.keptMetadata.length ? " (confirmed metadata kept)" : ""}`,
      });
      if (r.keptMetadata.length || r.removedMetadata.length) navigate("/");
    },
    onError,
  });
  const rate = useUpdateBook(book.id);

  const normalize = useMutation({
    mutationFn: () => api.normalizeFilenames([book.id]),
    onSuccess: (r) => {
      invalidate();
      notifications.show({
        color: r.errors.length ? "yellow" : "teal",
        message: r.errors.length ? r.errors.join("; ") : r.renamed.length ? `Renamed ${r.renamed.length} file(s)` : "Filenames already match",
      });
    },
    onError,
  });
  const setCover = useMutation({ mutationFn: (f: File) => api.setCover(book.id, f), onSuccess: invalidate, onError });
  const removeCover = useMutation({ mutationFn: () => api.removeCover(book.id), onSuccess: invalidate, onError });
  const detach = useMutation({
    mutationFn: (f: BookFileDto) => api.detachFile(book.id, f.hash),
    onSuccess: (r) => {
      invalidate();
      notifications.show({
        color: "teal",
        message: (
          <>
            Split off as <Anchor component={Link} to={`/books/${r.book.id}`}>{r.book.title}</Anchor>
          </>
        ),
      });
    },
    onError,
  });

  // Resume the file last read, else the best readable format.
  const lastRead = book.readingPosition ? book.files.find((f) => f.hash === book.readingPosition!.hash) : undefined;
  const readFile =
    lastRead ?? [...book.files].filter((f) => isReadable(f.format)).sort((a, b) => READABLE.indexOf(a.format) - READABLE.indexOf(b.format))[0];

  const facts: [string, ReactNode][] = [];
  if (book.isbn13) facts.push(["ISBN", <Text ff="monospace" size="sm">{book.isbn13}</Text>]);
  if (book.doi)
    facts.push([
      "DOI",
      <Anchor href={`https://doi.org/${book.doi}`} target="_blank" rel="noreferrer" ff="monospace" size="sm">
        {book.doi}
      </Anchor>,
    ]);
  if (book.series)
    facts.push([
      "Series",
      <Anchor component={Link} to={`/?series=${encodeURIComponent(book.series)}&sort=series`} size="sm">
        {book.series}
        {book.seriesIndex != null ? ` #${book.seriesIndex}` : ""}
      </Anchor>,
    ]);
  if (book.publisher) facts.push(["Publisher", book.publisher]);
  if (book.publishedDate) facts.push(["Published", book.publishedDate]);
  if (book.language) facts.push(["Language", book.language]);
  if (book.pages) facts.push(["Pages", String(book.pages)]);

  return (
    <Stack maw={1100}>
      <Group justify="space-between">
        <Button variant="subtle" leftSection={<IconArrowLeft size={16} />} onClick={() => navigate(-1)} px={4}>
          Back
        </Button>
        <Group gap="xs">
          {readFile && (
            <Button component={Link} to={readerUrl(book.id, readFile.hash)} color="teal" leftSection={<IconBook size={16} />}>
              {lastRead && book.progress ? `Continue · ${Math.round(book.progress * 100)}%` : "Read"}
              {book.files.length > 1 ? ` (${readFile.format.toUpperCase()})` : ""}
            </Button>
          )}
          <Button variant="light" leftSection={<IconCloudSearch size={16} />} onClick={() => setLookingUp(true)}>
            Look up
          </Button>
          <Button leftSection={<IconEdit size={16} />} onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="default" size="lg" aria-label="More actions">
                <IconDots size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconFileTypography size={16} />} onClick={() => normalize.mutate()}>
                Normalize filenames
              </Menu.Item>
              <Menu.Item leftSection={<IconGitMerge size={16} />} onClick={() => setMerging(true)}>
                Merge another book into this…
              </Menu.Item>
              <MoveToSubmenu current={book.shelves} onPick={(shelf) => move.mutate({ ids: [book.id], shelf })} />
              <Menu.Divider />
              <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => setDeleting(null)}>
                Delete from disk…
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>

      <Grid gap="xl">
        <Grid.Col span={{ base: 12, sm: 4, md: 3 }}>
          <Stack gap="xs" maw={280}>
            <CoverThumb bookId={book.id} hasCover={book.hasCover} width="100%" size="full" version={book.updatedAt} />
            <Group gap="xs" justify="center">
              <FileButton onChange={(f) => f && setCover.mutate(f)} accept="image/*">
                {(props) => (
                  <Button {...props} size="xs" variant="subtle" leftSection={<IconPhotoUp size={14} />} loading={setCover.isPending}>
                    {book.hasCover ? "Replace cover" : "Upload cover"}
                  </Button>
                )}
              </FileButton>
              {book.hasCover && (
                <Tooltip label="Remove cover">
                  <ActionIcon variant="subtle" color="gray" onClick={() => removeCover.mutate()} aria-label="Remove cover">
                    <IconPhotoX size={16} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          </Stack>
        </Grid.Col>

        <Grid.Col span={{ base: 12, sm: 8, md: 9 }}>
          <Stack gap="md">
            <div>
              <Group gap="xs" wrap="nowrap" align="flex-start">
                <Title order={2}>{book.title}</Title>
                <ConfirmedMark book={book} />
              </Group>
              {book.subtitle && (
                <Text size="lg" c="dimmed">
                  {book.subtitle}
                </Text>
              )}
              <Group gap={6} mt={4}>
                {book.authors.length ? (
                  book.authors.map((a, i) => (
                    <Anchor key={a} component={Link} to={`/?author=${encodeURIComponent(a)}`}>
                      {a}
                      {i < book.authors.length - 1 ? "," : ""}
                    </Anchor>
                  ))
                ) : (
                  <Text c="dimmed">Unknown author</Text>
                )}
              </Group>
            </div>

            <Group gap="xs">
              <Rating value={book.rating ?? 0} onChange={(v) => rate.mutate({ rating: v || null }, { onError })} />
              {book.confirmedSource ? (
                <Badge color="teal" variant="light">
                  {CONFIRMED_LABEL[book.confirmedSource]}
                </Badge>
              ) : (
                <Tooltip label="Not confirmed yet: this metadata is removed if all of the book's files are removed">
                  <Badge color="gray" variant="light">
                    {book.metadataSource ? SOURCE_LABEL[book.metadataSource] : "Unconfirmed"}
                  </Badge>
                </Tooltip>
              )}
            </Group>

            {facts.length > 0 && (
              <Table variant="vertical" withTableBorder={false} layout="fixed" maw={560}>
                <Table.Tbody>
                  {facts.map(([k, v]) => (
                    <Table.Tr key={k}>
                      <Table.Th w={110} fw={500} c="dimmed" bg="transparent">
                        {k}
                      </Table.Th>
                      <Table.Td>{v}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}

            {book.tags.length > 0 && (
              <Group gap={6}>
                {book.tags.map((t) => (
                  <Badge key={t} component={Link} to={`/?tag=${encodeURIComponent(t)}`} variant="outline" style={{ cursor: "pointer" }}>
                    {t}
                  </Badge>
                ))}
              </Group>
            )}

            {book.description && (
              <Spoiler maxHeight={150} showLabel="Show more" hideLabel="Show less">
                <Text size="sm" style={{ whiteSpace: "pre-line" }}>
                  {book.description}
                </Text>
              </Spoiler>
            )}

            {book.notes && (
              <Paper withBorder p="sm" bg="var(--mantine-color-yellow-light)">
                <Text size="xs" fw={600} c="dimmed" mb={4}>
                  Notes
                </Text>
                <Text size="sm" style={{ whiteSpace: "pre-line" }}>
                  {book.notes}
                </Text>
              </Paper>
            )}

            <div>
              <Title order={4} mb="xs">
                Files
              </Title>
              <Stack gap="xs">
                {book.files.map((f) => (
                  <Paper key={f.relPath} withBorder p="xs">
                    <Group wrap="nowrap" gap="sm">
                      <Badge variant="light" w={56} style={{ flexShrink: 0 }}>
                        {f.format}
                      </Badge>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text size="sm" truncate title={f.filename}>
                          {f.filename}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {f.shelf ?? "Unshelved"} · {formatSize(f.size)}
                        </Text>
                      </div>
                      {isReadable(f.format) && (
                        <Tooltip label="Read">
                          <ActionIcon component={Link} to={readerUrl(book.id, f.hash)} variant="subtle" aria-label={`Read ${f.filename}`}>
                            <IconBook size={16} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                      <Tooltip label="Download">
                        <ActionIcon component="a" href={downloadUrl(book.id, f.hash)} variant="subtle" aria-label={`Download ${f.filename}`}>
                          <IconDownload size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Menu position="bottom-end" withinPortal>
                        <Menu.Target>
                          <ActionIcon variant="subtle" color="gray" aria-label={`Actions for ${f.filename}`}>
                            <IconDots size={16} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          {book.files.length > 1 && (
                            <Menu.Item leftSection={<IconUnlink size={16} />} onClick={() => detach.mutate(f)}>
                              Split into a separate book
                            </Menu.Item>
                          )}
                          <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => setDeleting(f.hash)}>
                            Delete this file…
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    </Group>
                  </Paper>
                ))}
              </Stack>
            </div>
          </Stack>
        </Grid.Col>
      </Grid>

      <EditBookModal book={book} opened={editing} onClose={() => setEditing(false)} />
      <MergeModal book={book} opened={merging} onClose={() => setMerging(false)} />
      <LookupModal book={book} opened={lookingUp} onClose={() => setLookingUp(false)} />
      <DeleteBooksModal
        opened={deleting !== undefined}
        onClose={() => setDeleting(undefined)}
        books={[book]}
        fileHash={deleting ?? undefined}
        loading={remove.isPending || removeFile.isPending}
        onConfirm={() =>
          deleting
            ? removeFile.mutate(deleting)
            : remove.mutate([book.id], {
                onSuccess: () => {
                  setDeleting(undefined);
                  navigate("/");
                },
              })
        }
      />
    </Stack>
  );
}
