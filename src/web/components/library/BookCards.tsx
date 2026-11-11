import { Badge, Card, Checkbox, Group, Progress, Rating, SimpleGrid, Table, Text, Tooltip } from "@mantine/core";
import { IconCircleCheck } from "@tabler/icons-react";
import type { DragEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { BookSummaryDto } from "../../../shared/types.ts";
import { CoverThumb } from "../CoverThumb.tsx";
import { startBookDrag } from "./dnd.ts";

interface ViewProps {
  books: BookSummaryDto[];
  selected: Set<number>;
  onToggle: (book: BookSummaryDto) => void;
  selecting: boolean;
}

/** Dragging a selected book drags the whole selection; otherwise just that book. */
function dragStart(e: DragEvent, book: BookSummaryDto, selected: Set<number>) {
  const ids = selected.has(book.id) ? [...selected] : [book.id];
  startBookDrag(e, ids, ids.length === 1 ? book.title : `${ids.length} books`);
}

export function FormatBadges({ book }: { book: BookSummaryDto }) {
  return (
    <Group gap={4}>
      {[...new Set(book.files.map((f) => f.format))].map((f) => (
        <Badge key={f} size="xs" variant="light" radius="sm">
          {f}
        </Badge>
      ))}
    </Group>
  );
}

export function ConfirmedMark({ book }: { book: BookSummaryDto }) {
  if (!book.confirmedSource) return null;
  const label = { openlibrary: "Confirmed from Open Library", doi: "Confirmed from DOI metadata", manual: "Edited manually" }[book.confirmedSource];
  return (
    <Tooltip label={`${label} — kept even if the files are removed`}>
      <IconCircleCheck size={16} color="var(--mantine-color-teal-6)" style={{ flexShrink: 0 }} aria-label={label} />
    </Tooltip>
  );
}

export function BookGrid({ books, selected, onToggle, selecting }: ViewProps) {
  const navigate = useNavigate();
  return (
    <SimpleGrid cols={{ base: 2, xs: 3, sm: 4, md: 5, lg: 6, xl: 8 }} spacing="md" verticalSpacing="lg">
      {books.map((b) => {
        const isSelected = selected.has(b.id);
        return (
          <Card
            key={b.id}
            padding={6}
            radius="md"
            withBorder
            style={{
              cursor: "pointer",
              outline: isSelected ? "2px solid var(--mantine-primary-color-filled)" : undefined,
              position: "relative",
            }}
            onClick={(e) => (selecting || e.ctrlKey || e.metaKey ? onToggle(b) : navigate(`/books/${b.id}`))}
            draggable
            onDragStart={(e) => dragStart(e, b, selected)}
          >
            <Checkbox
              checked={isSelected}
              onChange={() => onToggle(b)}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Select ${b.title}`}
              style={{ position: "absolute", top: 10, left: 10, zIndex: 1, opacity: selecting || isSelected ? 1 : 0.55 }}
            />
            <CoverThumb bookId={b.id} hasCover={b.hasCover} width="100%" />
            {b.progress !== null && b.progress > 0 && (
              <Tooltip label={`${Math.round(b.progress * 100)}% read`}>
                <Progress value={b.progress * 100} size={4} radius={0} mt={-4} color={b.progress >= 0.99 ? "teal" : undefined} aria-label="Reading progress" />
              </Tooltip>
            )}
            <Group gap={4} mt={6} wrap="nowrap" align="flex-start">
              <Text size="sm" fw={600} lineClamp={2} style={{ flex: 1 }} title={b.title}>
                {b.title}
              </Text>
              <ConfirmedMark book={b} />
            </Group>
            <Text size="xs" c="dimmed" lineClamp={1} title={b.authors.join(", ")}>
              {b.authors.join(", ") || "Unknown author"}
            </Text>
            {b.series && (
              <Text size="xs" c="dimmed" lineClamp={1}>
                {b.series}
                {b.seriesIndex != null ? ` #${b.seriesIndex}` : ""}
              </Text>
            )}
            <Group justify="space-between" mt={4} gap={4}>
              <FormatBadges book={b} />
              {b.rating ? <Rating value={b.rating} readOnly size="xs" /> : null}
            </Group>
          </Card>
        );
      })}
    </SimpleGrid>
  );
}

export function BookList({ books, selected, onToggle }: ViewProps) {
  const allSelected = books.length > 0 && books.every((b) => selected.has(b.id));
  return (
    <Table.ScrollContainer minWidth={760}>
      <Table highlightOnHover verticalSpacing={6}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={36}>
              <Checkbox
                checked={allSelected}
                indeterminate={!allSelected && books.some((b) => selected.has(b.id))}
                onChange={() => books.forEach((b) => (allSelected ? selected.has(b.id) : !selected.has(b.id)) && onToggle(b))}
                aria-label="Select all on this page"
              />
            </Table.Th>
            <Table.Th w={44} />
            <Table.Th>Title</Table.Th>
            <Table.Th>Authors</Table.Th>
            <Table.Th>Series</Table.Th>
            <Table.Th>Year</Table.Th>
            <Table.Th>Formats</Table.Th>
            <Table.Th>Shelf</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {books.map((b) => (
            <Table.Tr
              key={b.id}
              bg={selected.has(b.id) ? "var(--mantine-primary-color-light)" : undefined}
              draggable
              onDragStart={(e) => dragStart(e, b, selected)}
            >
              <Table.Td>
                <Checkbox checked={selected.has(b.id)} onChange={() => onToggle(b)} aria-label={`Select ${b.title}`} />
              </Table.Td>
              <Table.Td>
                <CoverThumb bookId={b.id} hasCover={b.hasCover} width={32} />
              </Table.Td>
              <Table.Td>
                <Group gap={6} wrap="nowrap">
                  <Text component={Link} to={`/books/${b.id}`} size="sm" fw={500} lineClamp={2} style={{ textDecoration: "none", color: "inherit" }}>
                    {b.title}
                  </Text>
                  <ConfirmedMark book={b} />
                </Group>
                {(b.isbn13 || b.doi) && (
                  <Text size="xs" c="dimmed" ff="monospace">
                    {b.isbn13 ?? b.doi}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                <Text size="sm" lineClamp={2}>
                  {b.authors.join(", ")}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">
                  {b.series}
                  {b.series && b.seriesIndex != null ? ` #${b.seriesIndex}` : ""}
                </Text>
              </Table.Td>
              <Table.Td>{b.year}</Table.Td>
              <Table.Td>
                <FormatBadges book={b} />
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {b.shelves.map((s) => s ?? "Unshelved").join(", ")}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
