/**
 * The env file (secrets, default `~/.secrets/bookshelf.env`) against its template `.env.example`. Pure functions on
 * the files' text, used by `make install` through `scripts/env-file.ts`. Values are copied, never inspected.
 */

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

const lines = (text: string): string[] => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/** The variable a line assigns, or null for comments, blank lines and anything else. */
const nameOf = (line: string): string | null => ASSIGNMENT.exec(line)?.[1] ?? null;

/** Names of the variables a file assigns, in order and without repeats. */
export function envNames(text: string): string[] {
  return [...new Set(lines(text).map(nameOf).filter((n): n is string => n !== null))];
}

/** Names of the variables a file gives a non-empty value (whatever the value is). */
export function setEnvNames(text: string): string[] {
  const set = lines(text).filter((line) => line.slice(line.indexOf("=") + 1).trim() !== "");
  return envNames(set.join("\n"));
}

/** Template variables the env file doesn't assign at all (an empty assignment counts as present). */
export function missingEnvNames(template: string, existing: string): string[] {
  const present = new Set(envNames(existing));
  return envNames(template).filter((name) => !present.has(name));
}

/** A template variable's block: the comment lines directly above its assignment, then the assignment. */
function templateBlock(templateLines: string[], name: string): string[] {
  const at = templateLines.findIndex((line) => nameOf(line) === name);
  const start = templateLines
    .slice(0, at)
    .reduceRight((first, line, i) => (first === i + 1 && line.trimStart().startsWith("#") ? i : first), at);
  return templateLines.slice(start, at + 1);
}

/**
 * Update: the env file as it is, followed by the block of each template variable it lacks (its comment and an empty
 * assignment), each after a blank line. Unchanged when nothing is missing.
 */
export function appendMissing(template: string, existing: string): string {
  const missing = missingEnvNames(template, existing);
  if (missing.length === 0) return existing;
  const templateLines = lines(template);
  const blocks = missing.map((name) => templateBlock(templateLines, name).join("\n")).join("\n\n");
  const base = existing === "" || existing.endsWith("\n") ? existing : existing + "\n";
  const gap = base === "" || base.endsWith("\n\n") ? "" : "\n";
  return `${base}${gap}${blocks}\n`;
}

/**
 * Replace: the template, with each variable the env file assigns keeping that file's line (the last one, which is
 * the one that wins). Variables no longer in the template and any other lines are dropped; no copy is kept.
 */
export function replaceKeepingValues(template: string, existing: string): string {
  const kept = new Map(lines(existing).flatMap((line) => (nameOf(line) ? [[nameOf(line)!, line] as const] : [])));
  const out = lines(template).map((line) => {
    const name = nameOf(line);
    return name !== null && kept.has(name) ? kept.get(name)! : line;
  });
  return out.length === 0 ? "" : out.join("\n") + "\n";
}
