import { useState, type ReactNode } from "react";
import { ActionIcon, Alert, Badge, Button, Code, Group, List, Loader, Menu, Modal, NavLink, ScrollArea, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconBooks, IconDots, IconEdit, IconFolder, IconFolderPlus, IconInbox, IconListCheck, IconTrash } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import type { ShelfDeleteConflict, ShelfDto } from "../../shared/types.ts";
import { api, ApiRequestError } from "../api/client.ts";
import { useInvalidateBooks, useLibraryStatus, useLookupStatus, useShelves } from "../api/hooks.ts";
import { isBookDrag, readBookDrag } from "./library/dnd.ts";
import { useBookActions } from "./library/useBookActions.ts";

type Dialog = { kind: "create" } | { kind: "rename"; shelf: string } | { kind: "delete"; shelf: ShelfDto } | null;

const shelfUrl = (name: string | null) => (name === null ? "/?shelf=" : `/?shelf=${encodeURIComponent(name)}`);

/** Sidebar: All books, Unshelved and the shelves (each a drop target for dragged books). */
export function ShelfNav({ onNavigate }: { onNavigate?: () => void }) {
  const shelves = useShelves();
  const status = useLibraryStatus();
  const [params] = useSearchParams();
  const pathname = useLocation().pathname;
  const onLibrary = pathname === "/";
  const lookup = useLookupStatus();
  const current = params.has("shelf") ? params.get("shelf") : undefined;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);
  const { move } = useBookActions();

  const dropProps = (shelf: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!isBookDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(shelf);
    },
    onDragLeave: () => setDropTarget(undefined),
    onDrop: (e: React.DragEvent) => {
      if (!isBookDrag(e)) return;
      e.preventDefault();
      setDropTarget(undefined);
      const ids = readBookDrag(e);
      if (ids.length) move.mutate({ ids, shelf });
    },
  });

  const item = (key: string, label: string, to: string, active: boolean, icon: ReactNode, count?: number, extra?: ReactNode, drop?: string | null) => (
    <NavLink
      key={key}
      component={Link}
      to={to}
      label={label}
      leftSection={icon}
      active={onLibrary && active}
      onClick={onNavigate}
      {...(drop !== undefined ? dropProps(drop) : {})}
      style={drop !== undefined && dropTarget === drop ? { outline: "2px dashed var(--mantine-primary-color-filled)", outlineOffset: -2 } : undefined}
      rightSection={
        <Group gap={2} wrap="nowrap">
          {count !== undefined && (
            <Badge size="sm" variant="light" color="gray">
              {count}
            </Badge>
          )}
          {extra}
        </Group>
      }
    />
  );

  const unshelved = shelves.data?.find((s) => s.name === null);
  return (
    <>
      {item("all", "All books", "/", current === undefined, <IconBooks size={18} />, status.data?.bookCount)}
      {item("unshelved", "Unshelved", shelfUrl(null), current === "", <IconInbox size={18} />, unshelved?.bookCount, null, null)}
      {(lookup.data?.reviewCount || lookup.data?.running) ? (
        <NavLink
          component={Link}
          to="/review"
          label="Review queue"
          leftSection={<IconListCheck size={18} />}
          active={pathname === "/review"}
          onClick={onNavigate}
          rightSection={
            <Group gap={4} wrap="nowrap">
              {lookup.data.running && <Loader size={12} />}
              <Badge size="sm" variant="filled" color="orange">
                {lookup.data.reviewCount}
              </Badge>
            </Group>
          }
        />
      ) : null}
      <Group justify="space-between" px="sm" pt="md" pb={4}>
        <Text size="xs" fw={600} c="dimmed" tt="uppercase">
          Bookshelves
        </Text>
        <Tooltip label="New bookshelf">
          <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => setDialog({ kind: "create" })} aria-label="New bookshelf">
            <IconFolderPlus size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
      {shelves.data
        ?.filter((s) => s.name !== null)
        .map((s) =>
          item(
            `shelf-${s.name}`,
            s.name!,
            shelfUrl(s.name),
            current === s.name,
            <IconFolder size={18} />,
            s.bookCount,
            <Menu position="right-start" withinPortal>
              <Menu.Target>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  aria-label={`Actions for ${s.name}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  <IconDots size={14} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
                <Menu.Item leftSection={<IconEdit size={16} />} onClick={() => setDialog({ kind: "rename", shelf: s.name! })}>
                  Rename…
                </Menu.Item>
                <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => setDialog({ kind: "delete", shelf: s })}>
                  Delete…
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>,
            s.name,
          ),
        )}
      {shelves.data && shelves.data.length === 1 && (
        <Text size="xs" c="dimmed" px="sm">
          No bookshelves yet. Folders inside the library directory appear here.
        </Text>
      )}

      <ShelfNameModal dialog={dialog} current={current} onClose={() => setDialog(null)} />
      <DeleteShelfModal dialog={dialog} current={current} onClose={() => setDialog(null)} />
    </>
  );
}

function ShelfNameModal({ dialog, current, onClose }: { dialog: Dialog; current: string | null | undefined; onClose: () => void }) {
  const opened = dialog?.kind === "create" || dialog?.kind === "rename";
  const original = dialog?.kind === "rename" ? dialog.shelf : "";
  const [name, setName] = useState("");
  const invalidate = useInvalidateBooks();
  const navigate = useNavigate();
  const save = useMutation({
    mutationFn: () => (dialog?.kind === "rename" ? api.renameShelf(original, name) : api.createShelf(name)),
    onSuccess: (shelf) => {
      invalidate();
      if (dialog?.kind === "create" || current === original) navigate(shelfUrl(shelf.name));
      onClose();
    },
  });
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={dialog?.kind === "rename" ? `Rename “${original}”` : "New bookshelf"}
      onEnterTransitionEnd={() => {
        setName(original);
        save.reset();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <Stack>
          <TextInput
            label="Name"
            description="Creates/renames the folder inside the library directory"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            data-autofocus
            error={save.isError ? save.error.message : undefined}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || name.trim() === original} loading={save.isPending}>
              {dialog?.kind === "rename" ? "Rename" : "Create"}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function DeleteShelfModal({ dialog, current, onClose }: { dialog: Dialog; current: string | null | undefined; onClose: () => void }) {
  const shelf = dialog?.kind === "delete" ? dialog.shelf : null;
  const invalidate = useInvalidateBooks();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => api.deleteShelf(shelf!.name!),
    onSuccess: (r) => {
      invalidate();
      notifications.show({
        color: "teal",
        title: `Deleted “${shelf!.name}”`,
        message: r.moved.length ? `${r.moved.length} file(s) moved to Unshelved` : undefined,
      });
      if (current === shelf!.name) navigate(shelfUrl(null));
      onClose();
    },
  });
  const conflict = remove.error instanceof ApiRequestError && remove.error.status === 409 ? (remove.error.details as ShelfDeleteConflict | undefined) : undefined;

  return (
    <Modal opened={!!shelf} onClose={onClose} title={`Delete “${shelf?.name ?? ""}”`} onEnterTransitionEnd={() => remove.reset()}>
      <Stack>
        <Text size="sm">
          The folder is removed. Books are never deleted:{" "}
          {shelf?.bookCount ? (
            <b>
              {shelf.bookCount} book{shelf.bookCount === 1 ? "" : "s"} will move to Unshelved
            </b>
          ) : (
            "the shelf is empty"
          )}
          .
        </Text>
        {conflict ? (
          <Alert color="yellow" title="This folder contains other files">
            <Text size="sm" mb="xs">
              Nothing was changed. Move or delete these first:
            </Text>
            <ScrollArea.Autosize mah={160}>
              <List size="xs">
                {conflict.files.map((f) => (
                  <List.Item key={f}>
                    <Code>{f}</Code>
                  </List.Item>
                ))}
              </List>
            </ScrollArea.Autosize>
            {conflict.total > conflict.files.length && (
              <Text size="xs" mt={4}>
                …and {conflict.total - conflict.files.length} more
              </Text>
            )}
          </Alert>
        ) : remove.isError ? (
          <Alert color="red">{remove.error.message}</Alert>
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button color="red" loading={remove.isPending} onClick={() => remove.mutate()} disabled={!!conflict}>
            Delete shelf
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
