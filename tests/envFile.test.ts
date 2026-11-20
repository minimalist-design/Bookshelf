import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_ENV_NAMES } from "../src/server/config.ts";
import { appendMissing, envNames, missingEnvNames, replaceKeepingValues, setEnvNames } from "../src/server/envFile.ts";

const root = join(import.meta.dir, "..");
const EXAMPLE = readFileSync(join(root, ".env.example"), "utf8");

const TEMPLATE = `# Header comment

# The A key
# (second line)
A_KEY=

B_KEY=

# The C key
C_KEY=
`;

describe("env template", () => {
  test(".env.example lists exactly the secrets Bookshelf reads, all empty", () => {
    expect(envNames(EXAMPLE).toSorted()).toEqual([...SECRET_ENV_NAMES].toSorted());
    expect(EXAMPLE.split("\n").filter((l) => /^[A-Z_]+=./.test(l))).toEqual([]);
  });
});

describe("envNames / missingEnvNames", () => {
  test("reads assignments, with or without export, and ignores comments", () => {
    expect(envNames("# X=1\nA=1\n  export B = 2\n\nnot a line\nA=3")).toEqual(["A", "B"]);
  });

  test("setEnvNames only names variables with a value", () => {
    expect(setEnvNames("A=1\nB=\nC=  \n# D=1\nE='x'")).toEqual(["A", "E"]);
  });

  test("an empty assignment counts as present", () => {
    expect(missingEnvNames(TEMPLATE, "A_KEY=\nC_KEY=secret\n")).toEqual(["B_KEY"]);
  });
});

describe("appendMissing", () => {
  test("appends each missing variable with the comment above it and leaves the rest as it was", () => {
    const existing = "# mine\nB_KEY=b-secret\nOTHER=x\n";
    expect(appendMissing(TEMPLATE, existing)).toBe(
      "# mine\nB_KEY=b-secret\nOTHER=x\n\n# The A key\n# (second line)\nA_KEY=\n\n# The C key\nC_KEY=\n",
    );
  });

  test("changes nothing when every variable is there", () => {
    const existing = "C_KEY=c\nA_KEY=a\nB_KEY=\n";
    expect(appendMissing(TEMPLATE, existing)).toBe(existing);
  });

  test("handles a file without a final newline, one ending in a blank line, and an empty one", () => {
    expect(appendMissing("A=\n", "B=1")).toBe("B=1\n\nA=\n");
    expect(appendMissing("A=\n", "B=1\n\n")).toBe("B=1\n\nA=\n");
    expect(appendMissing("# a\nA=\n", "")).toBe("# a\nA=\n");
  });
});

describe("replaceKeepingValues", () => {
  test("starts from the template, keeps set values, drops what the template no longer has", () => {
    const existing = "# old note\nA_KEY=a-secret\nGONE=old\nC_KEY=first\nC_KEY='second'\n";
    expect(replaceKeepingValues(TEMPLATE, existing)).toBe(
      "# Header comment\n\n# The A key\n# (second line)\nA_KEY=a-secret\n\nB_KEY=\n\n# The C key\nC_KEY='second'\n",
    );
  });
});

describe("scripts/env-file.ts", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bookshelf-env-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const template = join(tmp, "template.env");
  writeFileSync(template, TEMPLATE);
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["bun", join(root, "scripts", "env-file.ts"), ...args], { cwd: root });
    expect(r.exitCode).toBe(0);
    return r.stdout.toString();
  };

  test("status, update and replace print names only and leave the file at mode 600", () => {
    const file = join(tmp, "app.env");
    writeFileSync(file, "B_KEY=very-secret-value\n", { mode: 0o644 });

    expect(run("status", template, file)).toContain("lacks A_KEY, C_KEY");
    const updated = run("update", template, file);
    expect(updated).toContain("added A_KEY, C_KEY");
    expect(readFileSync(file, "utf8")).toStartWith("B_KEY=very-secret-value\n\n# The A key");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(run("status", template, file)).toContain("has every variable");
    expect(run("update", template, file)).toContain("nothing to add");

    const replaced = run("replace", template, file);
    expect(replaced).toContain("(kept the values of B_KEY)");
    expect(readFileSync(file, "utf8")).toBe(TEMPLATE.replace("B_KEY=", "B_KEY=very-secret-value"));
    expect(statSync(file).mode & 0o777).toBe(0o600);

    for (const out of [updated, replaced]) expect(out).not.toContain("very-secret-value");
  });
});
