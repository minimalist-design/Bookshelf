import { Alert, Button, Group, List, Modal, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import type { BookSummaryDto } from "../../../shared/types.ts";

interface Props {
  opened: boolean;
  onClose: () => void;
  books: BookSummaryDto[];
  loading?: boolean;
  onConfirm: () => void;
  /** When set, only this one file of `books[0]` is deleted. */
  fileHash?: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Explicit confirmation for permanent deletion, stating what happens to the metadata. */
export function DeleteBooksModal({ opened, onClose, books, loading, onConfirm, fileHash }: Props) {
  const single = books.length === 1 ? books[0]! : null;
  const file = fileHash ? single?.files.find((f) => f.hash === fileHash) : undefined;
  const lastFile = !!file && single!.files.length === 1;
  const fileCount = file ? 1 : books.reduce((n, b) => n + b.files.length, 0);
  const confirmed = books.filter((b) => b.confirmedSource).length;
  const unconfirmed = books.length - confirmed;
  const affectsMetadata = !file || lastFile;

  return (
    <Modal opened={opened} onClose={onClose} title={file ? "Delete file" : books.length === 1 ? "Delete book" : `Delete ${books.length} books`}>
      <Stack>
        <Alert color="red" variant="light" icon={<IconAlertTriangle />}>
          {file ? (
            <>
              <Text size="sm">
                <b>{file.filename}</b> will be permanently deleted from disk.
              </Text>
              {!lastFile && (
                <Text size="sm" mt={4}>
                  “{single!.title}” keeps its other {plural(single!.files.length - 1, "file")}.
                </Text>
              )}
            </>
          ) : (
            <Text size="sm">
              {plural(fileCount, "file")} will be permanently deleted from disk
              {single ? (
                <>
                  {" "}
                  (“{single.title}”{single.files.length > 1 ? `, ${single.files.map((f) => f.format.toUpperCase()).join(" + ")}` : ""})
                </>
              ) : (
                ""
              )}
              . This cannot be undone.
            </Text>
          )}
        </Alert>
        {affectsMetadata && (
          <List size="sm" spacing={4}>
            {confirmed > 0 && (
              <List.Item>
                Confirmed metadata is kept for {single ? "this book" : plural(confirmed, "book")}: if the file comes back, it is
                recognized again.
              </List.Item>
            )}
            {unconfirmed > 0 && (
              <List.Item>
                Metadata read from the file{single ? "" : "s"} or filename{single ? "" : "s"} is removed
                {single ? "" : ` for ${plural(unconfirmed, "book")}`}.
              </List.Item>
            )}
          </List>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button color="red" loading={loading} onClick={onConfirm} data-autofocus>
            Delete {plural(fileCount, "file")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
