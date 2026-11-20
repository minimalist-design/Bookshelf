import { Fragment, useState } from "react";
import { Anchor, Group, Loader, Text, type MantineSize } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import type { CleanupField } from "../../../shared/types.ts";
import { api } from "../../api/client.ts";
import { returnState } from "../library/returnTo.ts";

/** A book's title linking to its page, whose Back button returns here. */
export function BookLink({ id, title, authors, size }: { id: number; title: string; authors?: readonly string[]; size?: MantineSize }) {
  const location = useLocation();
  return (
    <Anchor component={Link} to={`/books/${id}`} state={returnState(location)} size={size} title={authors?.length ? `${title} by ${authors.join(", ")}` : title}>
      {title}
    </Anchor>
  );
}

/** At first; the rest behind "show all". */
const SHOWN = 12;

/** The books on disk that use a name (an author, tag, series or publisher), loaded when shown. */
export function BooksWithName({ field, name, size = "sm" }: { field: CleanupField; name: string; size?: MantineSize }) {
  const books = useQuery({ queryKey: ["cleanup", "books", field, name], queryFn: () => api.booksWithName(field, name), retry: false });
  const [all, setAll] = useState(false);
  if (books.isLoading)
    return (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size={size} c="dimmed">
          Loading books…
        </Text>
      </Group>
    );
  if (books.isError)
    return (
      <Text size={size} c="red">
        {books.error.message}
      </Text>
    );
  const list = books.data ?? [];
  if (!list.length)
    return (
      <Text size={size} c="dimmed">
        No books on disk.
      </Text>
    );
  const shown = all ? list : list.slice(0, SHOWN);
  return (
    <Text size={size} component="div">
      {shown.map((b, i) => (
        <Fragment key={b.id}>
          {i > 0 && <Text span c="dimmed">{" · "}</Text>}
          <BookLink id={b.id} title={b.title} authors={field === "authors" ? undefined : b.authors} size={size} />
        </Fragment>
      ))}
      {list.length > shown.length && (
        <>
          <Text span c="dimmed">{" · "}</Text>
          <Anchor component="button" type="button" size={size} onClick={() => setAll(true)}>
            show all {list.length}
          </Anchor>
        </>
      )}
    </Text>
  );
}
