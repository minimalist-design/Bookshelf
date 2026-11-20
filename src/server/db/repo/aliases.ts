import type { Database } from "bun:sqlite";
import { dedupeCaseless, foldKey } from "../../cleanup/similarity.ts";
import type { AliasDto, CleanupField } from "../../../shared/types.ts";

/** The fields of book metadata (or a lookup candidate) that aliases rewrite. */
interface Aliasable {
  authors: string[];
  tags: string[];
  series: string | null;
  publisher: string | null;
}

type Lookup = ReadonlyMap<CleanupField, ReadonlyMap<string, string>>;

/**
 * Remembered spelling variants (from merging names in Settings). A name is replaced when its folded
 * form matches a variant, or a main name itself, so new case variants of a known spelling map too.
 */
export class AliasesRepo {
  private lookup: Lookup | null = null;

  constructor(private readonly db: Database) {}

  list(): AliasDto[] {
    return this.db.query("SELECT field, name AS variant, canonical FROM aliases ORDER BY field, canonical COLLATE NOCASE, name COLLATE NOCASE").all() as AliasDto[];
  }

  /** Remember `variants` as spellings of `canonical`; aliases that pointed at a variant move on to it. */
  add(field: CleanupField, variants: readonly string[], canonical: string): void {
    const own = foldKey(canonical);
    this.db.transaction(() => {
      const repoint = this.db.query("UPDATE aliases SET canonical = ? WHERE field = ? AND canonical = ?");
      const upsert = this.db.query(
        `INSERT INTO aliases (field, variant, name, canonical) VALUES (?, ?, ?, ?)
         ON CONFLICT(field, variant) DO UPDATE SET name = excluded.name, canonical = excluded.canonical`,
      );
      // A case-only variant ("JANE AUSTEN") is stored under the main name's own folded form: any case of it maps here.
      for (const v of variants.filter((x) => x !== canonical)) {
        repoint.run(canonical, field, v);
        upsert.run(field, foldKey(v), v, canonical);
      }
      // The main name is never an alias of another name.
      this.db.query("DELETE FROM aliases WHERE field = ? AND variant = ? AND canonical <> ?").run(field, own, canonical);
    })();
    this.lookup = null;
  }

  remove(field: CleanupField, variant: string): boolean {
    const changed = this.db.query("DELETE FROM aliases WHERE field = ? AND (name = ? OR variant = ?)").run(field, variant, foldKey(variant)).changes > 0;
    this.lookup = null;
    return changed;
  }

  /** `m` with aliased names replaced by their main name (same object when nothing changes). */
  apply<T extends Aliasable>(m: T): T {
    const lookup = this.load();
    if (!lookup.size) return m;
    const one = (field: CleanupField, v: string | null) => (v === null ? v : (lookup.get(field)?.get(foldKey(v)) ?? v));
    const many = (field: CleanupField, list: readonly string[]) => dedupeCaseless(list.map((v) => one(field, v)!));
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

  private load(): Lookup {
    if (this.lookup) return this.lookup;
    const rows = this.db.query("SELECT field, variant, canonical FROM aliases").all() as { field: CleanupField; variant: string; canonical: string }[];
    const byField = Map.groupBy(rows, (r) => r.field);
    this.lookup = new Map(
      [...byField].map(([field, list]) => [
        field,
        new Map([...list.map((r) => [foldKey(r.canonical), r.canonical] as const), ...list.map((r) => [r.variant, r.canonical] as const)]),
      ]),
    );
    return this.lookup;
  }
}
