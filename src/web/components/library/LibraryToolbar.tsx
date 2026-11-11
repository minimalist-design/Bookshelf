import { useEffect, useState } from "react";
import {
  ActionIcon,
  Button,
  Group,
  Indicator,
  Pill,
  Popover,
  Rating,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconFilter, IconLayoutGrid, IconList, IconSearch, IconSortAscending, IconSortDescending } from "@tabler/icons-react";
import type { LibraryQuery, LibrarySort, MissingFilter } from "../../../shared/types.ts";
import { useFacets } from "../../api/hooks.ts";

export type ViewMode = "grid" | "list";

interface Props {
  query: LibraryQuery;
  update: (patch: Record<string, string | number | boolean | undefined | null>) => void;
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
}

const SORT_OPTIONS: { value: LibrarySort; label: string }[] = [
  { value: "title", label: "Title" },
  { value: "author", label: "Author" },
  { value: "added", label: "Date added" },
  { value: "year", label: "Year" },
  { value: "series", label: "Series" },
  { value: "rating", label: "Rating" },
];

const MISSING_LABELS: Record<MissingFilter, string> = {
  id: "No ISBN/DOI",
  author: "No author",
  cover: "No cover",
  description: "No description",
};

export function LibraryToolbar({ query, update, view, onViewChange }: Props) {
  const [search, setSearch] = useState(query.q ?? "");
  const [debounced] = useDebouncedValue(search, 250);
  useEffect(() => {
    if ((debounced || undefined) !== query.q) update({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  useEffect(() => setSearch(query.q ?? ""), [query.q]);

  const chips: { key: string; label: string }[] = [];
  if (query.format) chips.push({ key: "format", label: `Format: ${query.format.toUpperCase()}` });
  if (query.tag) chips.push({ key: "tag", label: `Tag: ${query.tag}` });
  if (query.series) chips.push({ key: "series", label: `Series: ${query.series}` });
  if (query.author) chips.push({ key: "author", label: `Author: ${query.author}` });
  if (query.confirmed !== undefined) chips.push({ key: "confirmed", label: query.confirmed ? "Confirmed" : "Unconfirmed" });
  if (query.missing) chips.push({ key: "missing", label: MISSING_LABELS[query.missing] });
  if (query.minRating) chips.push({ key: "minRating", label: `Rating ≥ ${query.minRating}` });

  return (
    <Stack gap="xs">
      <Group gap="xs" wrap="wrap">
        <TextInput
          placeholder="Search title, author, ISBN, tags…"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          style={{ flex: "1 1 240px" }}
          aria-label="Search"
        />
        <Group gap={4} wrap="nowrap">
          <Select
            w={140}
            value={query.sort ?? "title"}
            onChange={(v) => v && update({ sort: v === "title" ? undefined : v })}
            data={SORT_OPTIONS}
            allowDeselect={false}
            aria-label="Sort by"
          />
          <Tooltip label={query.order === "desc" ? "Descending" : "Ascending"}>
            <ActionIcon
              variant="default"
              size="lg"
              onClick={() => update({ order: query.order === "desc" ? undefined : "desc" })}
              aria-label="Toggle sort order"
            >
              {query.order === "desc" ? <IconSortDescending size={18} /> : <IconSortAscending size={18} />}
            </ActionIcon>
          </Tooltip>
        </Group>
        <FilterPopover query={query} update={update} active={chips.length} />
        <SegmentedControl
          value={view}
          onChange={(v) => onViewChange(v as ViewMode)}
          data={[
            { value: "grid", label: <IconLayoutGrid size={16} aria-label="Grid view" /> },
            { value: "list", label: <IconList size={16} aria-label="List view" /> },
          ]}
        />
      </Group>
      {chips.length > 0 && (
        <Group gap={6}>
          {chips.map((c) => (
            <Pill key={c.key} withRemoveButton onRemove={() => update({ [c.key]: undefined })}>
              {c.label}
            </Pill>
          ))}
          {chips.length > 1 && (
            <Button
              variant="subtle"
              size="compact-xs"
              onClick={() => update(Object.fromEntries(chips.map((c) => [c.key, undefined])))}
            >
              Clear all
            </Button>
          )}
        </Group>
      )}
    </Stack>
  );
}

function FilterPopover({ query, update, active }: Pick<Props, "query" | "update"> & { active: number }) {
  const facets = useFacets();
  const opts = (list: { name: string; count: number }[] | undefined) =>
    (list ?? []).map((f) => ({ value: f.name, label: `${f.name} (${f.count})` }));
  return (
    <Popover width={300} position="bottom-end" shadow="md" trapFocus>
      <Popover.Target>
        <Indicator label={active} size={16} disabled={!active}>
          <Button variant="default" leftSection={<IconFilter size={16} />}>
            Filters
          </Button>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="sm">
          <Select
            label="Format"
            clearable
            data={(facets.data?.formats ?? []).map((f) => ({ value: f.name, label: `${f.name.toUpperCase()} (${f.count})` }))}
            value={query.format ?? null}
            onChange={(v) => update({ format: v })}
            comboboxProps={{ withinPortal: false }}
          />
          <Select label="Tag" clearable searchable data={opts(facets.data?.tags)} value={query.tag ?? null} onChange={(v) => update({ tag: v })} comboboxProps={{ withinPortal: false }} />
          <Select label="Series" clearable searchable data={opts(facets.data?.series)} value={query.series ?? null} onChange={(v) => update({ series: v })} comboboxProps={{ withinPortal: false }} />
          <Select label="Author" clearable searchable data={opts(facets.data?.authors)} value={query.author ?? null} onChange={(v) => update({ author: v })} comboboxProps={{ withinPortal: false }} />
          <Select
            label="Metadata"
            clearable
            data={[
              { value: "true", label: "Confirmed (external source or edited)" },
              { value: "false", label: "Unconfirmed (from file/filename)" },
            ]}
            value={query.confirmed === undefined ? null : String(query.confirmed)}
            onChange={(v) => update({ confirmed: v })}
            comboboxProps={{ withinPortal: false }}
          />
          <Select
            label="Missing"
            clearable
            data={Object.entries(MISSING_LABELS).map(([value, label]) => ({ value, label }))}
            value={query.missing ?? null}
            onChange={(v) => update({ missing: v })}
            comboboxProps={{ withinPortal: false }}
          />
          <div>
            <Text size="sm" fw={500} mb={4}>
              Minimum rating
            </Text>
            <Group gap="xs">
              <Rating value={query.minRating ?? 0} onChange={(v) => update({ minRating: v || undefined })} />
              {query.minRating ? (
                <Button size="compact-xs" variant="subtle" onClick={() => update({ minRating: undefined })}>
                  Any
                </Button>
              ) : null}
            </Group>
          </div>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
