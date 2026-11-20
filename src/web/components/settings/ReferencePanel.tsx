import { useState } from "react";
import { Alert, Button, FileButton, Group, Modal, Paper, Progress, Stack, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, uploadReference } from "../../api/client.ts";
import type { ReferenceSourceDto } from "../../../shared/types.ts";

const count = new Intl.NumberFormat();

function bytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

function Source({ s, onRemove }: { s: ReferenceSourceDto; onRemove: () => void }) {
  const c = s.counts;
  const languages = !s.languages || s.languages === "*" ? "all languages" : s.languages.split(",").join(", ");
  const built = day(s.builtAt);
  return (
    <Group justify="space-between" align="flex-start" wrap="nowrap">
      <Stack gap={2}>
        <Text fw={600}>
          {s.name}
          {s.version && (
            <Text span c="dimmed" fw={400}>
              {" "}
              · {s.version}
            </Text>
          )}
        </Text>
        <Text size="sm">
          {count.format(c.authors)} authors · {count.format(c.works)} works · {count.format(c.series)} series · {count.format(c.editions)} editions
        </Text>
        <Text size="xs" c="dimmed">
          {[languages, bytes(s.bytes), built && `built ${built}`, day(s.importedAt) && `imported ${day(s.importedAt)}`, s.license].filter(Boolean).join(" · ")}
        </Text>
      </Stack>
      <Button size="xs" variant="subtle" color="red" onClick={onRemove}>
        Remove…
      </Button>
    </Group>
  );
}

/** Settings › Reference data: imported databases of authors and books (docs/reference-data-format.md). */
export function ReferencePanel() {
  const qc = useQueryClient();
  const sources = useQuery({ queryKey: ["reference"], queryFn: api.referenceSources });
  const [path, setPath] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [removing, setRemoving] = useState<ReferenceSourceDto | null>(null);

  const imported = (s: ReferenceSourceDto) => {
    qc.invalidateQueries({ queryKey: ["reference"] });
    notifications.show({ color: "teal", message: `Imported ${s.name}: ${count.format(s.counts.authors)} authors, ${count.format(s.counts.works)} works` });
  };
  const onError = (e: Error) => notifications.show({ color: "red", title: "Not imported", message: e.message, autoClose: false });

  const upload = useMutation({
    mutationFn: (file: File) => uploadReference(file, setProgress),
    onSuccess: imported,
    onError,
    onSettled: () => setProgress(null),
  });
  const fromServer = useMutation({
    mutationFn: () => api.importReferenceFromServer(path),
    onSuccess: (s) => {
      setPath("");
      imported(s);
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (source: string) => api.removeReference(source),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reference"] });
      setRemoving(null);
    },
    onError: (e: Error) => notifications.show({ color: "red", message: e.message }),
  });
  const busy = upload.isPending || fromServer.isPending;

  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Title order={4}>Reference data</Title>
        <Text size="sm" c="dimmed">
          Databases of authors and books from other sources, one file per source. Build one with a script such as{" "}
          <code>scripts/wikidata/build.ts</code>; importing a newer file of the same source replaces the old one. The library
          database isn't changed.
        </Text>

        {sources.isError ? (
          <Alert color="red">{sources.error.message}</Alert>
        ) : sources.data?.length ? (
          sources.data.map((s) => <Source key={s.source} s={s} onRemove={() => setRemoving(s)} />)
        ) : sources.data ? (
          <Text size="sm">None imported.</Text>
        ) : null}

        <Group align="flex-end" mt="xs">
          <FileButton onChange={(f) => f && upload.mutate(f)} accept=".sqlite,.db,application/vnd.sqlite3,application/x-sqlite3">
            {(props) => (
              <Button {...props} variant="default" loading={upload.isPending} disabled={busy}>
                Upload a file…
              </Button>
            )}
          </FileButton>
          <TextInput
            style={{ flex: 1 }}
            label="Or a file on the server"
            placeholder="/path/to/wikidata.sqlite"
            value={path}
            onChange={(e) => setPath(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && path.trim() && !busy && fromServer.mutate()}
          />
          <Button variant="default" loading={fromServer.isPending} disabled={!path.trim() || busy} onClick={() => fromServer.mutate()}>
            Import
          </Button>
        </Group>
        {progress !== null && <Progress value={progress * 100} size="sm" aria-label="Upload progress" />}
        {progress === 1 && (
          <Text size="xs" c="dimmed">
            Checking the file…
          </Text>
        )}
      </Stack>

      <Modal opened={removing !== null} onClose={() => setRemoving(null)} title={`Remove ${removing?.name ?? ""} reference data`}>
        <Stack>
          <Text size="sm">Bookshelf deletes its copy of this file. Your library and the original file aren't affected.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button color="red" loading={remove.isPending} onClick={() => removing && remove.mutate(removing.source)}>
              Remove
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}
