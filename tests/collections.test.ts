import { expect, test } from "bun:test";
import { countBy, uniqueBy, uniqueCaseless } from "../src/server/collections.ts";

test("uniqueBy keeps the first item per key, in order", () => {
  expect(uniqueBy([3, 1, 4, 1, 5, 9, 2, 6], (n) => n % 3)).toEqual([3, 1, 5]);
  expect(uniqueBy([], (n: number) => n)).toEqual([]);
});

test("uniqueCaseless keeps the first spelling", () => {
  expect(uniqueCaseless(["Fantasy", "fantasy", "SF", "FANTASY", "sf"])).toEqual(["Fantasy", "SF"]);
});

test("countBy counts in order of first appearance", () => {
  expect(countBy(["b", "a", "b", "c", "b"])).toEqual([
    { name: "b", count: 3 },
    { name: "a", count: 1 },
    { name: "c", count: 1 },
  ]);
});
