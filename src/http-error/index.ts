export type HttpErrorOptions = {
  /** The underlying error this one was raised from. */
  cause?: unknown;
  /** Extra payload describing the failure (validation issues, resource id, ...). */
  details?: unknown;
  /** Headers that belong with the response, e.g. `Retry-After` or `Allow`. */
  headers?: Record<string, string>;
};

export class HttpError extends Error {
  readonly status: number;
  readonly details: unknown;
  readonly headers: Record<string, string> | undefined;

  constructor(status: number, message = "Http Error", options: HttpErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HttpError";
    this.status = status;
    this.details = options.details;
    this.headers = options.headers;
  }

  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  get isServerError(): boolean {
    return this.status >= 500 && this.status < 600;
  }

  toJSON(): { name: string; status: number; message: string; details?: unknown } {
    const json: { name: string; status: number; message: string; details?: unknown } = {
      name: this.name,
      status: this.status,
      message: this.message,
    };
    if (this.details !== undefined) json.details = this.details;
    return json;
  }

  static isHttpError(value: unknown): value is HttpError {
    return value instanceof HttpError;
  }
}

/* -------------------------------------------------------------------------- */
/*                                4xx — client                                */
/* -------------------------------------------------------------------------- */

export class BadRequestError extends HttpError {
  static readonly status = 400;

  constructor(message = "Bad Request", options: HttpErrorOptions = {}) {
    super(400, message, options);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends HttpError {
  static readonly status = 401;

  constructor(message = "Unauthorized", options: HttpErrorOptions = {}) {
    super(401, message, options);
    this.name = "UnauthorizedError";
  }
}

export class PaymentRequiredError extends HttpError {
  static readonly status = 402;

  constructor(message = "Payment Required", options: HttpErrorOptions = {}) {
    super(402, message, options);
    this.name = "PaymentRequiredError";
  }
}

export class ForbiddenError extends HttpError {
  static readonly status = 403;

  constructor(message = "Forbidden", options: HttpErrorOptions = {}) {
    super(403, message, options);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends HttpError {
  static readonly status = 404;

  constructor(message = "Not Found", options: HttpErrorOptions = {}) {
    super(404, message, options);
    this.name = "NotFoundError";
  }
}

export class MethodNotAllowedError extends HttpError {
  static readonly status = 405;

  constructor(message = "Method Not Allowed", options: HttpErrorOptions = {}) {
    super(405, message, options);
    this.name = "MethodNotAllowedError";
  }
}

export class NotAcceptableError extends HttpError {
  static readonly status = 406;

  constructor(message = "Not Acceptable", options: HttpErrorOptions = {}) {
    super(406, message, options);
    this.name = "NotAcceptableError";
  }
}

export class RequestTimeoutError extends HttpError {
  static readonly status = 408;

  constructor(message = "Request Timeout", options: HttpErrorOptions = {}) {
    super(408, message, options);
    this.name = "RequestTimeoutError";
  }
}

export class ConflictError extends HttpError {
  static readonly status = 409;

  constructor(message = "Conflict", options: HttpErrorOptions = {}) {
    super(409, message, options);
    this.name = "ConflictError";
  }
}

export class GoneError extends HttpError {
  static readonly status = 410;

  constructor(message = "Gone", options: HttpErrorOptions = {}) {
    super(410, message, options);
    this.name = "GoneError";
  }
}

export class PreconditionFailedError extends HttpError {
  static readonly status = 412;

  constructor(message = "Precondition Failed", options: HttpErrorOptions = {}) {
    super(412, message, options);
    this.name = "PreconditionFailedError";
  }
}

export class PayloadTooLargeError extends HttpError {
  static readonly status = 413;

  constructor(message = "Payload Too Large", options: HttpErrorOptions = {}) {
    super(413, message, options);
    this.name = "PayloadTooLargeError";
  }
}

export class UnsupportedMediaTypeError extends HttpError {
  static readonly status = 415;

  constructor(message = "Unsupported Media Type", options: HttpErrorOptions = {}) {
    super(415, message, options);
    this.name = "UnsupportedMediaTypeError";
  }
}

export class UnprocessableEntityError extends HttpError {
  static readonly status = 422;

  constructor(message = "Unprocessable Entity", options: HttpErrorOptions = {}) {
    super(422, message, options);
    this.name = "UnprocessableEntityError";
  }
}

export class TooManyRequestsError extends HttpError {
  static readonly status = 429;

  constructor(message = "Too Many Requests", options: HttpErrorOptions = {}) {
    super(429, message, options);
    this.name = "TooManyRequestsError";
  }
}

/* -------------------------------------------------------------------------- */
/*                                5xx — server                                */
/* -------------------------------------------------------------------------- */

export class InternalServerError extends HttpError {
  static readonly status = 500;

  constructor(message = "Internal Server Error", options: HttpErrorOptions = {}) {
    super(500, message, options);
    this.name = "InternalServerError";
  }
}

export class NotImplementedError extends HttpError {
  static readonly status = 501;

  constructor(message = "Not Implemented", options: HttpErrorOptions = {}) {
    super(501, message, options);
    this.name = "NotImplementedError";
  }
}

export class BadGatewayError extends HttpError {
  static readonly status = 502;

  constructor(message = "Bad Gateway", options: HttpErrorOptions = {}) {
    super(502, message, options);
    this.name = "BadGatewayError";
  }
}

export class ServiceUnavailableError extends HttpError {
  static readonly status = 503;

  constructor(message = "Service Unavailable", options: HttpErrorOptions = {}) {
    super(503, message, options);
    this.name = "ServiceUnavailableError";
  }
}

export class GatewayTimeoutError extends HttpError {
  static readonly status = 504;

  constructor(message = "Gateway Timeout", options: HttpErrorOptions = {}) {
    super(504, message, options);
    this.name = "GatewayTimeoutError";
  }
}

type HttpErrorConstructor = new (message?: string, options?: HttpErrorOptions) => HttpError;

const httpErrorsByStatus = new Map<number, HttpErrorConstructor>([
  [400, BadRequestError],
  [401, UnauthorizedError],
  [402, PaymentRequiredError],
  [403, ForbiddenError],
  [404, NotFoundError],
  [405, MethodNotAllowedError],
  [406, NotAcceptableError],
  [408, RequestTimeoutError],
  [409, ConflictError],
  [410, GoneError],
  [412, PreconditionFailedError],
  [413, PayloadTooLargeError],
  [415, UnsupportedMediaTypeError],
  [422, UnprocessableEntityError],
  [429, TooManyRequestsError],
  [500, InternalServerError],
  [501, NotImplementedError],
  [502, BadGatewayError],
  [503, ServiceUnavailableError],
  [504, GatewayTimeoutError],
]);

/**
 * Builds the error matching a status code, e.g. turning a failed `fetch`
 * response into a throwable. Unmapped statuses fall back to `HttpError`.
 */
export function createHttpError(
  status: number,
  message?: string,
  options: HttpErrorOptions = {}
): HttpError {
  const ErrorClass = httpErrorsByStatus.get(status);
  if (ErrorClass) return new ErrorClass(message, options);
  return new HttpError(status, message, options);
}
