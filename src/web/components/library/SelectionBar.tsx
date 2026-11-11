import { useState } from "react";
import { Affix, Button, Group, Menu, Paper, Text, Transition } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconChevronUp, IconCloudSearch, IconFileTypography, IconTrash, IconX } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import type { BookSummaryDto } from "../../../shared/types.ts";
import { api } from "../../api/client.ts";
import { useInvalidateBooks } from "../../api/hooks.ts";
import { DeleteBooksModal } from "../book/DeleteBooksModal.tsx";
import { MoveToSubmenu } from "./MoveToMenu.tsx";
import { useBookActions } from "./useBookActions.ts";

interface Props {
  selection: Map<number, BookSummaryDto>;
  onClear: () => void;
}

/** Floating bar with bulk actions for the selected books. */
export function SelectionBar({ selection, onClear }: Props) {
  const invalidate = useInvalidateBooks();
  const { move, remove } = useBookActions();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ids = [...selection.keys()];
  const books = [...selection.values()];

  const navigate = useNavigate();
  const lookup = useMutation({
    mutationFn: () => api.enqueueLookups(ids),
    onSuccess: (st) => {
      notifications.show({
        title: `Looking up ${ids.length} book${ids.length === 1 ? "" : "s"}`,
        message: `Results appear in the review queue (${st.pending} waiting). Nothing changes until you apply them.`,
      });
      onClear();
      navigate("/review");
    },
    onError: (e) => notifications.show({ color: "red", message: e.message }),
  });
  const normalize = useMutation({
    mutationFn: () => api.normalizeFilenames(ids),
    onSuccess: (r) => {
      invalidate();
      notifications.show({
        color: r.errors.length ? "yellow" : "teal",
        title: r.renamed.length ? `Renamed ${r.renamed.length} file${r.renamed.length === 1 ? "" : "s"}` : "Filenames already normalized",
        message: r.errors.length ? `${r.errors.length} could not be renamed: ${r.errors[0]}` : undefined,
      });
    },
    onError: (e) => notifications.show({ color: "red", message: e.message }),
  });

  return (
    <>
      <Affix position={{ bottom: 20, left: 0, right: 0 }} zIndex={150} style={{ pointerEvents: "none" }}>
        <Transition transition="slide-up" mounted={selection.size > 0}>
          {(styles) => (
            <Group justify="center" style={{ ...styles, pointerEvents: "none" }}>
              <Paper shadow="lg" withBorder p="xs" radius="md" style={{ pointerEvents: "auto" }}>
                <Group gap="xs">
                  <Text size="sm" fw={500} px="xs">
                    {selection.size} selected
                  </Text>
                  <Menu position="top" withinPortal>
                    <Menu.Target>
                      <Button size="xs" variant="light" rightSection={<IconChevronUp size={14} />} loading={move.isPending || normalize.isPending}>
                        Actions
                      </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item leftSection={<IconCloudSearch size={16} />} onClick={() => lookup.mutate()}>
                        Look up metadata
                      </Menu.Item>
                      <MoveToSubmenu onPick={(shelf) => move.mutate({ ids, shelf }, { onSuccess: onClear })} />
                      <Menu.Item leftSection={<IconFileTypography size={16} />} onClick={() => normalize.mutate()}>
                        Normalize filenames
                      </Menu.Item>
                      <Menu.Divider />
                      <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => setConfirmDelete(true)}>
                        Delete from disk…
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                  <Button size="xs" variant="subtle" color="gray" leftSection={<IconX size={14} />} onClick={onClear}>
                    Clear
                  </Button>
                </Group>
              </Paper>
            </Group>
          )}
        </Transition>
      </Affix>
      <DeleteBooksModal
        opened={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        books={books}
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(ids, {
            onSuccess: () => {
              setConfirmDelete(false);
              onClear();
            },
          })
        }
      />
    </>
  );
}
