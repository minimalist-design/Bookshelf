export interface RunResult {
  stdout: Uint8Array;
  exitCode: number | null;
}

/** Run a command with a timeout; never throws for non-zero exits (check exitCode). */
export async function run(cmd: string[], timeoutMs = 30_000, maxBytes = 64 * 1024 * 1024): Promise<RunResult> {
  const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: timeoutMs });
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of proc.stdout) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      proc.kill();
      break;
    }
    chunks.push(chunk);
  }
  const exitCode = await proc.exited;
  const stdout = new Uint8Array(total > maxBytes ? 0 : total);
  if (total <= maxBytes) {
    let o = 0;
    for (const c of chunks) {
      stdout.set(c, o);
      o += c.byteLength;
    }
  }
  return { stdout, exitCode };
}

export async function runText(cmd: string[], timeoutMs = 30_000): Promise<string | null> {
  const r = await run(cmd, timeoutMs, 16 * 1024 * 1024);
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout) : null;
}
