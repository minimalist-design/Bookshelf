import { useEffect, useState } from "react";
import {
  Alert,
  Autocomplete,
  Button,
  Grid,
  Group,
  Modal,
  NumberInput,
  Rating,
  Stack,
  TagsInput,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconInfoCircle } from "@tabler/icons-react";
import type { BookDetailDto, BookUpdate } from "../../../shared/types.ts";
import { useFacets, useUpdateBook } from "../../api/hooks.ts";

type FormState = {
  title: string;
  subtitle: string;
  authors: string[];
  isbn13: string;
  doi: string;
  publisher: string;
  publishedDate: string;
  language: string;
  pages: number | string;
  series: string;
  seriesIndex: number | string;
  tags: string[];
  rating: number;
  description: string;
  notes: string;
};

function fromBook(b: BookDetailDto): FormState {
  return {
    title: b.title,
    subtitle: b.subtitle ?? "",
    authors: b.authors,
    isbn13: b.isbn13 ?? "",
    doi: b.doi ?? "",
    publisher: b.publisher ?? "",
    publishedDate: b.publishedDate ?? "",
    language: b.language ?? "",
    pages: b.pages ?? "",
    series: b.series ?? "",
    seriesIndex: b.seriesIndex ?? "",
    tags: b.tags,
    rating: b.rating ?? 0,
    description: b.description ?? "",
    notes: b.notes ?? "",
  };
}

/** Only send fields that actually changed. */
function diff(book: BookDetailDto, f: FormState): BookUpdate {
  const out: BookUpdate = {};
  const text = (v: string) => (v.trim() === "" ? null : v.trim());
  const num = (v: number | string) => (v === "" || v === null ? null : Number(v));
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (f.title.trim() !== book.title) out.title = f.title.trim();
  if (text(f.subtitle) !== book.subtitle) out.subtitle = text(f.subtitle);
  if (!same(f.authors, book.authors)) out.authors = f.authors;
  if (text(f.isbn13) !== book.isbn13) out.isbn13 = text(f.isbn13);
  if (text(f.doi) !== book.doi) out.doi = text(f.doi);
  if (text(f.publisher) !== book.publisher) out.publisher = text(f.publisher);
  if (text(f.publishedDate) !== book.publishedDate) out.publishedDate = text(f.publishedDate);
  if (text(f.language) !== book.language) out.language = text(f.language);
  if (num(f.pages) !== book.pages) out.pages = num(f.pages);
  if (text(f.series) !== book.series) out.series = text(f.series);
  if (num(f.seriesIndex) !== book.seriesIndex) out.seriesIndex = num(f.seriesIndex);
  if (!same(f.tags, book.tags)) out.tags = f.tags;
  if ((f.rating || null) !== book.rating) out.rating = f.rating || null;
  if (text(f.description) !== book.description) out.description = text(f.description);
  if (text(f.notes) !== book.notes) out.notes = text(f.notes);
  return out;
}

export function EditBookModal({ book, opened, onClose }: { book: BookDetailDto; opened: boolean; onClose: () => void }) {
  const [f, setF] = useState<FormState>(() => fromBook(book));
  const facets = useFacets();
  const save = useUpdateBook(book.id);
  useEffect(() => {
    if (opened) {
      setF(fromBook(book));
      save.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const changes = diff(book, f);
  const changed = Object.keys(changes).length > 0;
  const renames = ["title", "authors", "isbn13", "doi"].some((k) => k in changes);
  const names = (list?: { name: string }[]) => (list ?? []).map((x) => x.name);

  const submit = () =>
    save.mutate(changes, {
      onSuccess: (r) => {
        notifications.show({
          color: r.errors.length ? "yellow" : "teal",
          title: "Saved",
          message: r.errors.length
            ? `Some files could not be renamed: ${r.errors.join("; ")}`
            : r.renamed.length
              ? `Renamed ${r.renamed.length} file${r.renamed.length === 1 ? "" : "s"}`
              : undefined,
        });
        onClose();
      },
    });

  return (
    <Modal opened={opened} onClose={onClose} title="Edit book" size="xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) submit();
        }}
      >
        <Stack>
          {!book.confirmedSource && (
            <Alert variant="light" icon={<IconInfoCircle />} p="xs">
              <Text size="sm">Saving marks this metadata as confirmed: it is kept even if the book's files are removed.</Text>
            </Alert>
          )}
          <Grid>
            <Grid.Col span={{ base: 12, sm: 8 }}>
              <TextInput label="Title" required value={f.title} onChange={(e) => set("title", e.currentTarget.value)} data-autofocus />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 4 }}>
              <TextInput label="Subtitle" value={f.subtitle} onChange={(e) => set("subtitle", e.currentTarget.value)} />
            </Grid.Col>
            <Grid.Col span={12}>
              <TagsInput
                label="Authors"
                description='One author per entry ("Last, First" is converted). Press Enter after each.'
                data={names(facets.data?.authors)}
                value={f.authors}
                onChange={(v) => set("authors", v)}
                splitChars={[";"]}
                clearable
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <TextInput label="ISBN" description="ISBN-10 is converted to ISBN-13" value={f.isbn13} onChange={(e) => set("isbn13", e.currentTarget.value)} ff="monospace" />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <TextInput label="DOI" description="10.xxxx/… or a doi.org link" value={f.doi} onChange={(e) => set("doi", e.currentTarget.value)} ff="monospace" />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 5 }}>
              <Autocomplete label="Publisher" data={names(facets.data?.publishers)} value={f.publisher} onChange={(v) => set("publisher", v)} />
            </Grid.Col>
            <Grid.Col span={{ base: 6, sm: 3 }}>
              <TextInput label="Published" placeholder="YYYY-MM-DD" value={f.publishedDate} onChange={(e) => set("publishedDate", e.currentTarget.value)} />
            </Grid.Col>
            <Grid.Col span={{ base: 6, sm: 2 }}>
              <Autocomplete label="Language" placeholder="en" data={names(facets.data?.languages)} value={f.language} onChange={(v) => set("language", v)} />
            </Grid.Col>
            <Grid.Col span={{ base: 6, sm: 2 }}>
              <NumberInput label="Pages" min={1} allowDecimal={false} value={f.pages} onChange={(v) => set("pages", v)} />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 8 }}>
              <Autocomplete label="Series" data={names(facets.data?.series)} value={f.series} onChange={(v) => set("series", v)} />
            </Grid.Col>
            <Grid.Col span={{ base: 6, sm: 4 }}>
              <NumberInput label="Number in series" min={0} decimalScale={2} disabled={!f.series.trim()} value={f.seriesIndex} onChange={(v) => set("seriesIndex", v)} />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 9 }}>
              <TagsInput label="Tags" data={names(facets.data?.tags)} value={f.tags} onChange={(v) => set("tags", v)} splitChars={[",", ";"]} clearable />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 3 }}>
              <Text size="sm" fw={500} mb={6}>
                Rating
              </Text>
              <Rating value={f.rating} onChange={(v) => set("rating", v)} />
            </Grid.Col>
            <Grid.Col span={12}>
              <Textarea label="Description" autosize minRows={3} maxRows={10} value={f.description} onChange={(e) => set("description", e.currentTarget.value)} />
            </Grid.Col>
            <Grid.Col span={12}>
              <Textarea label="Notes" description="Private notes" autosize minRows={2} maxRows={8} value={f.notes} onChange={(e) => set("notes", e.currentTarget.value)} />
            </Grid.Col>
          </Grid>
          {save.isError && <Alert color="red">{save.error.message}</Alert>}
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {renames ? "The book's files will be renamed to match." : ""}
            </Text>
            <Group>
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!changed || !f.title.trim()} loading={save.isPending}>
                Save
              </Button>
            </Group>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
