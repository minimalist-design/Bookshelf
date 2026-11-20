/** Small list helpers built on the language's own collection methods. */

/** The first item for each key, in the order of first appearance. */
export function uniqueBy<T, K>(list: Iterable<T>, key: (item: T) => K): T[] {
  return [...Map.groupBy(list, key).values()].map((group) => group[0]!);
}

/** Case-insensitive dedupe that keeps the first spelling and the order. */
export function uniqueCaseless(list: Iterable<string>): string[] {
  return uniqueBy(list, (s) => s.toLowerCase());
}

/** How often each value occurs, in the order of first appearance. */
export function countBy(values: Iterable<string>): { name: string; count: number }[] {
  return [...Map.groupBy(values, (v) => v)].map(([name, group]) => ({ name, count: group.length }));
}

/** `list` cut into consecutive pieces of at most `size` items. */
export function chunk<T>(list: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
}
