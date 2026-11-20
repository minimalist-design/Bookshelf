import type { Database } from "bun:sqlite";
import { foldKey } from "../../cleanup/similarity.ts";
import { uniqueCaseless } from "../../collections.ts";
import type { AliasDto, CleanupField } from "../../../shared/types.ts";

/** The fields of book metadata (or a lookup candidate) that aliases rewrite. */
interface Aliasable {
  readonly authors: readonly string[];
  readonly tags: readonly string[];
  readonly series: string | null;
  readonly publisher: string | null;
}

type Lookup = ReadonlyMap<CleanupField, ReadonlyMap<string, string>>;

export interface Aliases {
  list(): AliasDto[];
  /** Remember `variants` as spellings of `canonical`; aliases that pointed at a variant move on to it. */
  add(field: CleanupField, variants: readonly string[], canonical: string): void;
  remove(field: CleanupField, variant: string): boolean;
  /** `m` with aliased names replaced by their main name (same object when nothing changes). */
  apply<T extends Aliasable>(m: T): T;
}

/**
 * Remembered spelling variants (from merging names in Settings). A name is replaced when its folded
 * form matches a variant, or a main name itself, so new case variants of a known spelling map too.
 * The lookup is read once and kept until the aliases change.
 */
export function createAliases(db: Database): Aliases {
  let lookup: Lookup | null = null;
  const current = (): Lookup => (lookup ??= loadLookup(db));

  return {
    list: () =>
      db.query("SELECT field, name AS variant, canonical FROM aliases ORDER BY field, canonical COLLATE NOCASE, name COLLATE NOCASE").all() as AliasDto[],

    add(field, variants, canonical) {
      const own = foldKey(canonical);
      db.transaction(() => {
        const repoint = db.query("UPDATE aliases SET canonical = ? WHERE field = ? AND canonical = ?");
        const upsert = db.query(
          `INSERT INTO aliases (field, variant, name, canonical) VALUES (?, ?, ?, ?)
           ON CONFLICT(field, variant) DO UPDATE SET name = excluded.name, canonical = excluded.canonical`,
        );
        // A case-only variant ("JANE AUSTEN") is stored under the main name's own folded form: any case of it maps here.
        for (const v of variants.filter((x) => x !== canonical)) {
          repoint.run(canonical, field, v);
          upsert.run(field, foldKey(v), v, canonical);
        }
        // The main name is never an alias of another name.
        db.query("DELETE FROM aliases WHERE field = ? AND variant = ? AND canonical <> ?").run(field, own, canonical);
      })();
      lookup = null;
    },

    remove(field, variant) {
      const changed = db.query("DELETE FROM aliases WHERE field = ? AND (name = ? OR variant = ?)").run(field, variant, foldKey(variant)).changes > 0;
      lookup = null;
      return changed;
    },

    apply: (m) => applyAliases(current(), m),
  };
}

function loadLookup(db: Database): Lookup {
  const rows = db.query("SELECT field, variant, canonical FROM aliases").all() as AliasRow[];
  return lookupFrom(rows);
}

interface AliasRow {
  field: CleanupField;
  variant: string;
  canonical: string;
}

/** Per field: folded variant (and folded main name) → main name. */
export function lookupFrom(rows: readonly AliasRow[]): Lookup {
  return new Map(
    [...Map.groupBy(rows, (r) => r.field)].map(([field, list]) => [
      field,
      new Map([...list.map((r) => [foldKey(r.canonical), r.canonical] as const), ...list.map((r) => [r.variant, r.canonical] as const)]),
    ]),
  );
}

/** `m` with aliased names replaced by their main name (same object when nothing changes). */
export function applyAliases<T extends Aliasable>(lookup: Lookup, m: T): T {
  if (!lookup.size) return m;
  const one = (field: CleanupField, v: string | null) => (v === null ? v : (lookup.get(field)?.get(foldKey(v)) ?? v));
  const many = (field: CleanupField, list: readonly string[]) => uniqueCaseless(list.map((v) => one(field, v)!));
  const next = {
    ...m,
    authors: many("authors", m.authors),
    tags: many("tags", m.tags),
    series: one("series", m.series),
    publisher: one("publishers", m.publisher),
  };
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  return same(next.authors, m.authors) && same(next.tags, m.tags) && next.series === m.series && next.publisher === m.publisher ? m : next;
}
