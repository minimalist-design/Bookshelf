import { useState } from "react";
import { Alert, Button, Group, Loader, NavLink, Popover, ScrollArea, Stack, Text, TextInput } from "@mantine/core";
import { IconArrowUp, IconFolder, IconFolderPlus } from "@tabler/icons-react";
import { ApiRequestError } from "../api/client.ts";
import { useBrowse, useMakeDirectory } from "../api/hooks.ts";

interface Props {
  initialPath?: string;
  confirmLabel: string;
  busy?: boolean;
  /** Allow confirming a typed path that does not exist yet (the caller creates it). */
  createMissing?: boolean;
  onConfirm: (path: string) => void;
}

/** Browse directories on the server and pick one. */
export function DirectoryPicker({ initialPath, confirmLabel, busy, createMissing, onConfirm }: Props) {
  const [path, setPath] = useState<string | undefined>(initialPath);
  const [typed, setTyped] = useState(initialPath ?? "");
  const browse = useBrowse(path);
  const missing = browse.error instanceof ApiRequestError && browse.error.status === 404;
  const willCreate = !!createMissing && missing && !!path;
  const current = browse.data?.path;
  const selected = willCreate ? path : current;

  const go = (p: string) => {
    setPath(p);
    setTyped(p);
  };

  return (
    <Stack gap="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) setPath(typed.trim());
        }}
      >
        <Group gap="xs" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
            placeholder="/path/to/library"
            aria-label="Directory path"
          />
          <Button type="submit" variant="default">
            Go
          </Button>
        </Group>
      </form>

      {willCreate ? (
        <Alert color="blue" title="New directory">
          This directory doesn't exist yet. It will be created.
        </Alert>
      ) : (
        browse.isError && (
          <Alert color="red" title="Cannot open directory">
            {browse.error.message}
          </Alert>
        )
      )}

      <ScrollArea h={320} type="auto" style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 8 }}>
        {browse.isLoading && (
          <Group justify="center" p="md">
            <Loader size="sm" />
          </Group>
        )}
        {browse.data?.parent && (
          <NavLink label=".." leftSection={<IconArrowUp size={16} />} onClick={() => go(browse.data.parent!)} />
        )}
        {browse.data?.dirs.map((d) => (
          <NavLink key={d.path} label={d.name} leftSection={<IconFolder size={16} />} onClick={() => go(d.path)} />
        ))}
        {browse.data && browse.data.dirs.length === 0 && (
          <Text c="dimmed" size="sm" p="md">
            No subdirectories
          </Text>
        )}
      </ScrollArea>

      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" c="dimmed" truncate="start" style={{ minWidth: 0 }}>
          {selected ?? ""}
        </Text>
        <Group gap="xs" wrap="nowrap">
          <NewFolderButton parent={willCreate ? undefined : current} onCreated={go} />
          <Button disabled={!selected} loading={busy} onClick={() => selected && onConfirm(selected)}>
            {confirmLabel}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

/** Create a folder inside `parent`, then open it. */
function NewFolderButton({ parent, onCreated }: { parent: string | undefined; onCreated: (path: string) => void }) {
  const [opened, setOpened] = useState(false);
  const [name, setName] = useState("");
  const mkdir = useMakeDirectory();

  const close = () => {
    setOpened(false);
    setName("");
    mkdir.reset();
  };

  return (
    <Popover opened={opened} onChange={(o) => (o ? setOpened(true) : close())} position="top-end" withArrow trapFocus>
      <Popover.Target>
        <Button
          variant="default"
          leftSection={<IconFolderPlus size={16} />}
          disabled={!parent}
          onClick={() => (opened ? close() : setOpened(true))}
        >
          New folder
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!parent || !name.trim()) return;
            mkdir.mutate(
              { parent, name: name.trim() },
              {
                onSuccess: ({ path }) => {
                  close();
                  onCreated(path);
                },
              },
            );
          }}
        >
          <Stack gap="xs" w={260}>
            <TextInput
              label="Folder name"
              value={name}
              onChange={(e) => {
                setName(e.currentTarget.value);
                if (mkdir.isError) mkdir.reset();
              }}
              error={mkdir.error?.message}
              data-autofocus
            />
            <Group justify="flex-end" gap="xs">
              <Button variant="default" size="xs" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" size="xs" loading={mkdir.isPending} disabled={!name.trim()}>
                Create
              </Button>
            </Group>
          </Stack>
        </form>
      </Popover.Dropdown>
    </Popover>
  );
}
