import { useState } from "react";
import { Pill, TagsInput, type TagsInputProps } from "@mantine/core";
import { useFacets } from "../api/hooks.ts";

type Props = Omit<TagsInputProps, "data" | "renderPill" | "value" | "onChange" | "limit"> & {
  value: string[];
  onChange: (value: string[]) => void;
};

/** Replace one entry (or drop it when emptied, or when it now repeats another author). */
export function replaceAuthor(list: readonly string[], from: string, to: string): string[] {
  const name = to.replace(/\s+/g, " ").trim();
  const repeats = list.some((a) => a !== from && a.toLowerCase() === name.toLowerCase());
  return list.flatMap((a) => (a !== from ? [a] : name && !repeats ? [name] : []));
}

/** Text box that replaces a pill while it is being edited; Enter or leaving it saves, Escape cancels. */
function PillEditor({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const [draft, setDraft] = useState(initial);
  // Keep the surrounding pills box from taking focus back (it focuses its own field on mouse down).
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <input
      autoFocus
      aria-label={`Edit author ${initial}`}
      value={draft}
      size={Math.max(draft.length + 1, 6)}
      spellCheck={false}
      autoCapitalize="words"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onMouseDown={stop}
      onClick={stop}
      onBlur={() => onDone(draft)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault(); // don't submit the surrounding form
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onDone(null);
        }
      }}
      style={{
        font: "inherit",
        fontSize: "var(--pill-fz, inherit)",
        color: "inherit",
        background: "var(--mantine-color-body)",
        border: "1px solid var(--mantine-primary-color-filled)",
        borderRadius: "var(--mantine-radius-xl)",
        padding: "0 0.6em",
        height: "var(--pill-height, 1.6em)",
        outline: "none",
        maxWidth: "100%",
      }}
    />
  );
}

/**
 * Authors as pills: click a pill to edit its text (so the browser's own tools, like Safari's
 * Transformations › Capitalize, work on it), and new entries autocomplete from the library's authors.
 */
export function AuthorsInput({ value, onChange, ...props }: Props) {
  const facets = useFacets();
  const [editing, setEditing] = useState<string | null>(null);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <TagsInput
      {...props}
      value={value}
      onChange={onChange}
      data={(facets.data?.authors ?? []).map((a) => a.name)}
      limit={20}
      renderPill={({ value: name, onRemove, disabled }) =>
        name === editing && !disabled ? (
          <PillEditor
            initial={name}
            onDone={(next) => {
              setEditing(null);
              if (next !== null && next !== name) onChange(replaceAuthor(value, name, next));
            }}
          />
        ) : (
          <Pill withRemoveButton={!disabled} onRemove={onRemove} disabled={disabled}>
            <span
              role="button"
              tabIndex={disabled ? -1 : 0}
              aria-label={`Edit author ${name}`}
              title="Click to edit"
              style={{ cursor: disabled ? undefined : "text" }}
              onMouseDown={stop}
              onClick={(e) => {
                stop(e);
                if (!disabled && name) setEditing(name);
              }}
              onKeyDown={(e) => {
                if (!disabled && name && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  e.stopPropagation();
                  setEditing(name);
                }
              }}
            >
              {name}
            </span>
          </Pill>
        )
      }
    />
  );
}
