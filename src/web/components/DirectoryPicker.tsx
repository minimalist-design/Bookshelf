import { useState } from "react";
import { Alert, Button, Group, Loader, NavLink, ScrollArea, Stack, Text, TextInput } from "@mantine/core";
import { IconArrowUp, IconFolder } from "@tabler/icons-react";
import { useBrowse } from "../api/hooks.ts";

interface Props {
  initialPath?: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: (path: string) => void;
}

/** Browse directories on the server and pick one. */
export function DirectoryPicker({ initialPath, confirmLabel, busy, onConfirm }: Props) {
  const [path, setPath] = useState<string | undefined>(initialPath);
  const [typed, setTyped] = useState(initialPath ?? "");
  const browse = useBrowse(path);
  const current = browse.data?.path;

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

      {browse.isError && (
        <Alert color="red" title="Cannot open directory">
          {browse.error.message}
        </Alert>
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
          {current ?? ""}
        </Text>
        <Button disabled={!current} loading={busy} onClick={() => current && onConfirm(current)}>
          {confirmLabel}
        </Button>
      </Group>
    </Stack>
  );
}
