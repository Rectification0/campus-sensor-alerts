export interface FieldError {
  path: string;
  message: string;
}

/** An error with an HTTP status, rendered by the app error handler (specs §8). */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly errors?: FieldError[],
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function badRequest(errors: FieldError[]): HttpError {
  return new HttpError(400, errors.map((e) => `${e.path} ${e.message}`).join('; '), errors);
}

export function notFound(what: string): HttpError {
  return new HttpError(404, `${what} not found`);
}

/** 503 + Retry-After: nothing from the request was stored, so the client may retry (FR-3.3). */
export function serviceUnavailable(message: string, retryAfterSeconds = 1): HttpError {
  return new HttpError(503, message, undefined, { 'retry-after': String(retryAfterSeconds) });
}
