import { ValidationError } from "../library/paths.ts";

export class NotFoundError extends Error {}
export class UnavailableError extends Error {}
export class ConflictError extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(message);
  }
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

/** Wrap a handler so domain errors map to proper HTTP status codes. */
export function handle<R extends Request>(fn: (req: R) => Response | Promise<Response>) {
  return async (req: R): Promise<Response> => {
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof ValidationError) return json({ error: err.message }, { status: 400 });
      if (err instanceof NotFoundError) return json({ error: err.message }, { status: 404 });
      if (err instanceof UnavailableError) return json({ error: err.message }, { status: 503 });
      if (err instanceof ConflictError) return json({ error: err.message, details: err.details }, { status: 409 });
      console.error(err);
      return json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ValidationError("Invalid JSON body");
  }
}
