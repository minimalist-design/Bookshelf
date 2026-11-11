import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api/client.ts";
import { useInvalidateBooks } from "../../api/hooks.ts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Shared move/delete mutations with consistent notifications. */
export function useBookActions() {
  const invalidate = useInvalidateBooks();
  const onError = (e: Error) => notifications.show({ color: "red", title: "Something went wrong", message: e.message });

  const move = useMutation({
    mutationFn: ({ ids, shelf }: { ids: number[]; shelf: string | null }) => api.moveBooks(ids, shelf),
    onSuccess: (r, { shelf }) => {
      invalidate();
      notifications.show({
        color: r.errors.length ? "yellow" : "teal",
        title: r.moved.length ? `Moved ${plural(r.moved.length, "file")} to ${shelf ?? "Unshelved"}` : `Already on ${shelf ?? "Unshelved"}`,
        message: r.errors.length ? `${plural(r.errors.length, "file")} could not be moved: ${r.errors[0]}` : undefined,
      });
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (ids: number[]) => api.deleteBooks(ids),
    onSuccess: (r) => {
      invalidate();
      notifications.show({
        color: r.errors.length ? "yellow" : "teal",
        title: `Deleted ${plural(r.deletedFiles.length, "file")}`,
        message: [
          r.keptMetadata.length ? `Confirmed metadata kept for ${plural(r.keptMetadata.length, "book")}.` : "",
          r.errors.length ? `${plural(r.errors.length, "file")} could not be deleted: ${r.errors[0]}` : "",
        ]
          .filter(Boolean)
          .join(" ") || undefined,
      });
    },
    onError,
  });

  return { move, remove };
}
