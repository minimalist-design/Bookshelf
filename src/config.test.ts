import { expect, test } from "bun:test";
import { config } from "@/config";

test("port defaults to 3000", () => {
  expect(config.port).toBe(3000);
});
