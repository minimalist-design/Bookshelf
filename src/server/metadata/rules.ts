/**
 * Predefined rules that reorganize metadata some publishers put in the wrong fields, e.g. Delphi
 * Classics' "Parts Edition 3 of 12" tag (really a series and its number) and their website as
 * the description. Applied to imported files, to lookup candidates and, from Maintenance, to
 * books already in the library whose metadata isn't confirmed.
 *
 * To add a rule, add an entry to `METADATA_RULES`: every condition in `when` must hold, then each
 * action runs. Patterns are matched case-insensitively by convention (give them the `i` flag).
 */
import type { BookMetadata } from "./types.ts";

/** The fields rules read and change; `CandidateMetadata` has the same ones. */
export type RuleFields = Pick<BookMetadata, "publisher" | "tags" | "description" | "series" | "seriesIndex">;

export interface MetadataRule {
  name: string;
  /** All given conditions must hold: the publisher matches, some tag matches. */
  when: { publisher?: RegExp; tag?: RegExp };
  /** The first tag matching `pattern` sets the series to `series`, numbered by capture group 1; removed when `dropTag`. */
  seriesFromTag?: { pattern: RegExp; series: string; dropTag: boolean };
  /** Text removed from the description (whitespace collapsed; nothing meaningful left: no description). */
  stripFromDescription?: RegExp[];
}

export const METADATA_RULES: readonly MetadataRule[] = [
  {
    name: "Delphi Classics parts editions",
    when: { publisher: /\bdelphi classics\b/i },
    seriesFromTag: { pattern: /^parts edition\s+(\d+(?:\.\d+)?)\s+of\s+\d+/i, series: "Parts Edition", dropTag: true },
    stripFromDescription: [/(?:https?:\/\/)?(?:www\.)?delphiclassics\.com\S*/gi],
  },
];

const matchesWhen = (m: RuleFields, when: MetadataRule["when"]): boolean =>
  (!when.publisher || (!!m.publisher && when.publisher.test(m.publisher))) && (!when.tag || m.tags.some((t) => when.tag!.test(t)));

function seriesFromTag<M extends RuleFields>(m: M, action: NonNullable<MetadataRule["seriesFromTag"]>): M {
  const found = m.tags.map((tag) => ({ tag, match: action.pattern.exec(tag) })).find((t) => t.match);
  if (!found) return m;
  const index = Number(found.match![1]);
  const tags = action.dropTag ? m.tags.filter((t) => t !== found.tag) : m.tags;
  const same = m.series === action.series && m.seriesIndex === index && tags.length === m.tags.length;
  return same ? m : { ...m, series: action.series, seriesIndex: Number.isFinite(index) ? index : null, tags };
}

function stripDescription<M extends RuleFields>(m: M, patterns: RegExp[]): M {
  if (!m.description) return m;
  const stripped = patterns.reduce((text, p) => text.replace(p, " "), m.description);
  if (stripped === m.description) return m;
  const cleaned = stripped
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Nothing left but punctuation or the publisher's name ("Delphi Classics – "): there was only the link.
  const core = cleaned.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
  return { ...m, description: core && core !== m.publisher?.toLowerCase() ? cleaned : null };
}

const applyRule = <M extends RuleFields>(m: M, rule: MetadataRule): M => {
  if (!matchesWhen(m, rule.when)) return m;
  const withSeries = rule.seriesFromTag ? seriesFromTag(m, rule.seriesFromTag) : m;
  return rule.stripFromDescription ? stripDescription(withSeries, rule.stripFromDescription) : withSeries;
};

/** The metadata with every matching rule applied; the same object when no rule changed anything. */
export const applyRules = <M extends RuleFields>(m: M, rules: readonly MetadataRule[] = METADATA_RULES): M =>
  rules.reduce(applyRule, m);
