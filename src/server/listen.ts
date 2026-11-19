/**
 * Picks the server's port. A configured port is used as it is; with none (`"port": 0`) the first free port in
 * 20000–20999 is taken, by binding it rather than checking first, so two services starting together can't both
 * get the same one. The caller then saves it in the config, so it never changes after that.
 */

export const PORT_RANGE = { first: 20000, last: 20999 } as const;

export class PortError extends Error {}

export interface Listening<T> {
  server: T;
  port: number;
  /** True when the port was just picked from the range (and should be saved in the config). */
  assigned: boolean;
}

function inUse(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "EADDRINUSE";
}

/** Starts the server with `start(port)` on the configured port, or on the first free one in `range` when it's null. */
export function listen<T>(
  configured: number | null,
  start: (port: number) => T,
  configName: string,
  range: { first: number; last: number } = PORT_RANGE,
): Listening<T> {
  if (configured !== null) {
    try {
      return { server: start(configured), port: configured, assigned: false };
    } catch (err) {
      if (!inUse(err)) throw err;
      throw new PortError(
        `port ${configured} (set in ${configName}) is in use by another program; stop it, or change "port" there`,
      );
    }
  }
  for (let port = range.first; port <= range.last; port++) {
    try {
      return { server: start(port), port, assigned: true };
    } catch (err) {
      if (!inUse(err)) throw err;
    }
  }
  throw new PortError(`every port from ${range.first} to ${range.last} is in use; set "port" in ${configName} by hand`);
}
