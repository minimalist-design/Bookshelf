import { useState, type ReactNode } from "react";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Center,
  CloseButton,
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
import { useFileDialog } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconArrowLeft,
  IconCloudSearch,
  IconBook,
  IconChevronDown,
  IconDownload,
  IconDots,
  IconEdit,
  IconFileTypePdf,
  IconFileTypography,
  IconGitMerge,
  IconPhotoUp,
  IconPhotoX,
  IconTrash,
  IconUnlink,
  IconUpload,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { formatEdition } from "../../shared/edition.ts";
import type { BookDetailDto, BookFileDto } from "../../shared/types.ts";
import { api } from "../api/client.ts";
import { useBook, useInvalidateBooks, useUpdateBook } from "../api/hooks.ts";
import { EditBookModal } from "../components/book/EditBookModal.tsx";
import { MergeModal } from "../components/book/MergeModal.tsx";
import { LookupModal } from "../components/lookup/LookupModal.tsx";
import { downloadUrl, isReadable, READABLE, readerUrl } from "../components/reader/fileUrls.ts";
import { CoverThumb } from "../components/CoverThumb.tsx";
import { CoverPickerModal } from "../components/book/CoverPickerModal.tsx";
import { PdfPagePickerModal } from "../components/book/PdfPagePickerModal.tsx";
import { DeleteBooksModal } from "../components/book/DeleteBooksModal.tsx";
import { ConfirmedMark } from "../components/library/BookCards.tsx";
import { MoveToSubmenu } from "../components/library/MoveToMenu.tsx";
import { useBookActions } from "../components/library/useBookActions.ts";
import { returnState as toReturnState, returnUrl } from "../components/library/returnTo.ts";

const CONFIRMED_LABEL = { isbndb: "Confirmed · ISBNdb", openlibrary: "Confirmed · Open Library", doi: "Confirmed · DOI", manual: "Confirmed · edited" } as const;
const SOURCE_LABEL = { embedded: "From the file's metadata", filename: "From the filename", mixed: "From file metadata and filename" } as const;

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function BookDetail() {
  return <BookPage id={Number(useParams().id)} />;
}

/**
 * A book's page. With `onClose` it's shown in an overlay on top of another page (the review
 * queue): no Back button, and deleting the book closes the overlay instead of leaving the page.
 */
export function BookPage({ id, onClose }: { id: number; onClose?: () => void }) {
  const book = useBook(Number.isFinite(id) ? id : null);

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
        {!onClose && (
          <Button variant="default" component={Link} to="/" leftSection={<IconArrowLeft size={16} />}>
            Back
          </Button>
        )}
      </Stack>
    );
  }
  return <BookView book={book.data} onClose={onClose} />;
}

function BookView({ book, onClose }: { book: BookDetailDto; onClose?: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  // Router state set by the link that opened this book, carried through the reader. In an
  // overlay, the page underneath is where Back should lead.
  const returnState = onClose ? toReturnState(location) : location.state;
  /** Leave a book that no longer exists: close the overlay, or go to the library. */
  const leave = () => (onClose ? onClose() : navigate("/"));
  const invalidate = useInvalidateBooks();
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [pickingCover, setPickingCover] = useState(false);
  const [pickingPage, setPickingPage] = useState(false);
  const hasPdf = book.files.some((f) => f.format === "pdf");
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
      if (r.keptMetadata.length || r.removedMetadata.length) leave();
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
  const coverFile = useFileDialog({
    multiple: false,
    accept: "image/*",
    resetOnOpen: true,
    onChange: (files) => files?.[0] && setCover.mutate(files[0]),
  });
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
  if (book.edition) facts.push(["Edition", formatEdition(book.edition)]);
  if (book.publisher) facts.push(["Publisher", book.publisher]);
  if (book.publishedDate) facts.push(["Published", book.publishedDate]);
  if (book.language) facts.push(["Language", book.language]);
  if (book.pages) facts.push(["Pages", String(book.pages)]);

  return (
    <Stack maw={1100}>
      <Group justify="space-between">
        {onClose ? (
          <Anchor component={Link} to={`/books/${book.id}`} state={returnState} size="sm">
            Open page
          </Anchor>
        ) : (
          <Button variant="subtle" component={Link} to={returnUrl(returnState)} leftSection={<IconArrowLeft size={16} />} px={4}>
            Back
          </Button>
        )}
        <Group gap="xs">
          {readFile && (
            <Button component={Link} to={readerUrl(book.id, readFile.hash)} state={returnState} color="teal" leftSection={<IconBook size={16} />}>
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
          {onClose && <CloseButton size="lg" onClick={onClose} aria-label="Close" ml="xs" />}
        </Group>
      </Group>

      <Grid gap="xl">
        <Grid.Col span={{ base: 12, sm: 4, md: 3 }}>
          <Stack gap="xs" maw={280}>
            <CoverThumb bookId={book.id} hasCover={book.hasCover} width="100%" size="full" version={book.updatedAt} />
            <Group gap="xs" justify="center">
              <Menu position="bottom" withinPortal>
                <Menu.Target>
                  <Button
                    size="xs"
                    variant="subtle"
                    leftSection={<IconPhotoUp size={14} />}
                    rightSection={<IconChevronDown size={12} />}
                    loading={setCover.isPending}
                  >
                    {book.hasCover ? "Replace cover" : "Add cover"}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item leftSection={<IconUpload size={16} />} onClick={coverFile.open}>
                    Upload an image…
                  </Menu.Item>
                  <Menu.Item leftSection={<IconCloudSearch size={16} />} onClick={() => setPickingCover(true)}>
                    Choose from Open Library…
                  </Menu.Item>
                  {hasPdf && (
                    <Menu.Item leftSection={<IconFileTypePdf size={16} />} onClick={() => setPickingPage(true)}>
                      Use a page from the PDF…
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
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
                          <ActionIcon component={Link} to={readerUrl(book.id, f.hash)} state={returnState} variant="subtle" aria-label={`Read ${f.filename}`}>
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
      <CoverPickerModal book={book} opened={pickingCover} onClose={() => setPickingCover(false)} />
      {hasPdf && <PdfPagePickerModal book={book} opened={pickingPage} onClose={() => setPickingPage(false)} />}
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
                  leave();
                },
              })
        }
      />
    </Stack>
  );
}
