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
