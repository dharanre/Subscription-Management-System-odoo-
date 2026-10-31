import { z } from 'zod';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const unauthorized = (message = 'Please sign in to continue.') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that.') =>
  new HttpError(403, 'forbidden', message);
export const notFound = (what = 'Record') => new HttpError(404, 'not_found', `${what} was not found.`);
export const conflict = (message: string, fields?: Record<string, string>) =>
  new HttpError(409, 'conflict', message, fields);

/** Validates untrusted input; throws a 422 whose `fields` map points at each offending input. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_';
    if (!(key in fields)) fields[key] = issue.message;
  }
  throw new HttpError(422, 'validation_failed', 'Please correct the highlighted fields.', fields);
}

/** Zod message helpers so missing fields read like sentences, not type errors. */
export const text = (label: string) => ({
  required_error: `${label} is required`,
  invalid_type_error: `${label} must be text`,
});

export const pagingSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function pageOf<T>(items: T[], total: number, page: number, pageSize: number): Page<T> {
  return { items, page, pageSize, total };
}

/** Escapes LIKE wildcards in user search text. Use with `ESCAPE '\\'`. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
