import { describe, expect, it } from "vitest";
import {
  BadGatewayError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  GatewayTimeoutError,
  GoneError,
  HttpError,
  InternalServerError,
  MethodNotAllowedError,
  NotAcceptableError,
  NotFoundError,
  NotImplementedError,
  PayloadTooLargeError,
  PaymentRequiredError,
  PreconditionFailedError,
  RequestTimeoutError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  UnprocessableEntityError,
  UnsupportedMediaTypeError,
  createHttpError,
} from "./index";

const cases = [
  [BadRequestError, 400, "Bad Request"],
  [UnauthorizedError, 401, "Unauthorized"],
  [PaymentRequiredError, 402, "Payment Required"],
  [ForbiddenError, 403, "Forbidden"],
  [NotFoundError, 404, "Not Found"],
  [MethodNotAllowedError, 405, "Method Not Allowed"],
  [NotAcceptableError, 406, "Not Acceptable"],
  [RequestTimeoutError, 408, "Request Timeout"],
  [ConflictError, 409, "Conflict"],
  [GoneError, 410, "Gone"],
  [PreconditionFailedError, 412, "Precondition Failed"],
  [PayloadTooLargeError, 413, "Payload Too Large"],
  [UnsupportedMediaTypeError, 415, "Unsupported Media Type"],
  [UnprocessableEntityError, 422, "Unprocessable Entity"],
  [TooManyRequestsError, 429, "Too Many Requests"],
  [InternalServerError, 500, "Internal Server Error"],
  [NotImplementedError, 501, "Not Implemented"],
  [BadGatewayError, 502, "Bad Gateway"],
  [ServiceUnavailableError, 503, "Service Unavailable"],
  [GatewayTimeoutError, 504, "Gateway Timeout"],
] as const;

describe("HttpError", () => {
  describe("base class", () => {
    it("keeps the status and message it was built with", () => {
      const error = new HttpError(418, "I'm a teapot");
      expect(error.status).toBe(418);
      expect(error.message).toBe("I'm a teapot");
    });

    it("falls back to a generic message", () => {
      expect(new HttpError(418).message).toBe("Http Error");
    });

    it("is an Error with a usable stack", () => {
      const error = new HttpError(500);
      expect(error).toBeInstanceOf(Error);
      expect(error.stack).toContain("HttpError");
    });

    it("stores details and headers", () => {
      const error = new HttpError(429, "Slow down", {
        details: { limit: 100 },
        headers: { "Retry-After": "60" },
      });
      expect(error.details).toEqual({ limit: 100 });
      expect(error.headers).toEqual({ "Retry-After": "60" });
    });

    it("leaves details and headers undefined when not given", () => {
      const error = new HttpError(500);
      expect(error.details).toBeUndefined();
      expect(error.headers).toBeUndefined();
    });

    it("keeps the cause", () => {
      const cause = new Error("socket hang up");
      expect(new HttpError(502, "Bad Gateway", { cause }).cause).toBe(cause);
    });

    it("does not set a cause when none is given", () => {
      expect("cause" in new HttpError(500)).toBe(false);
    });
  });

  describe("isClientError / isServerError", () => {
    it("flags 4xx as a client error", () => {
      const error = new NotFoundError();
      expect(error.isClientError).toBe(true);
      expect(error.isServerError).toBe(false);
    });

    it("flags 5xx as a server error", () => {
      const error = new InternalServerError();
      expect(error.isClientError).toBe(false);
      expect(error.isServerError).toBe(true);
    });

    it("flags neither for a non-error status", () => {
      const error = new HttpError(200);
      expect(error.isClientError).toBe(false);
      expect(error.isServerError).toBe(false);
    });
  });

  describe("toJSON", () => {
    it("serializes name, status and message", () => {
      expect(new NotFoundError("User not found").toJSON()).toEqual({
        name: "NotFoundError",
        status: 404,
        message: "User not found",
      });
    });

    it("includes details when present", () => {
      const error = new UnprocessableEntityError("Invalid body", {
        details: [{ field: "email" }],
      });
      expect(error.toJSON()).toEqual({
        name: "UnprocessableEntityError",
        status: 422,
        message: "Invalid body",
        details: [{ field: "email" }],
      });
    });

    it("omits details when absent", () => {
      expect(Object.keys(new NotFoundError().toJSON())).toEqual(["name", "status", "message"]);
    });

    it("is used by JSON.stringify", () => {
      expect(JSON.parse(JSON.stringify(new ForbiddenError()))).toEqual({
        name: "ForbiddenError",
        status: 403,
        message: "Forbidden",
      });
    });
  });

  describe("isHttpError", () => {
    it("returns true for an HttpError", () => {
      expect(HttpError.isHttpError(new HttpError(500))).toBe(true);
    });

    it("returns true for a subclass", () => {
      expect(HttpError.isHttpError(new NotFoundError())).toBe(true);
    });

    it("returns false for a plain Error", () => {
      expect(HttpError.isHttpError(new Error("boom"))).toBe(false);
    });

    it("returns false for non-errors", () => {
      expect(HttpError.isHttpError({ status: 404 })).toBe(false);
      expect(HttpError.isHttpError(null)).toBe(false);
      expect(HttpError.isHttpError(undefined)).toBe(false);
    });
  });

  describe.each(cases)("%o", (ErrorClass, status, statusText) => {
    it(`defaults to status ${status} and "${statusText}"`, () => {
      const error = new ErrorClass();
      expect(error.status).toBe(status);
      expect(error.message).toBe(statusText);
    });

    it("exposes the status as a static", () => {
      expect(ErrorClass.status).toBe(status);
    });

    it("names itself after the class", () => {
      expect(new ErrorClass().name).toBe(ErrorClass.name);
    });

    it("accepts a custom message and options", () => {
      const cause = new Error("root");
      const error = new ErrorClass("custom", { cause, details: "extra" });
      expect(error.message).toBe("custom");
      expect(error.cause).toBe(cause);
      expect(error.details).toBe("extra");
      expect(error.status).toBe(status);
    });

    it("is catchable as an HttpError and as an Error", () => {
      const error = new ErrorClass();
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ErrorClass);
    });
  });
});

describe("createHttpError", () => {
  it.each(cases)("builds a %o for its status", (ErrorClass, status) => {
    expect(createHttpError(status)).toBeInstanceOf(ErrorClass);
  });

  it("uses the default message of the matched class", () => {
    expect(createHttpError(404).message).toBe("Not Found");
  });

  it("passes the message and options through", () => {
    const error = createHttpError(409, "Email taken", { details: { field: "email" } });
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toBe("Email taken");
    expect(error.details).toEqual({ field: "email" });
  });

  it("falls back to HttpError for an unmapped status", () => {
    const error = createHttpError(418, "I'm a teapot");
    expect(error.constructor).toBe(HttpError);
    expect(error.status).toBe(418);
    expect(error.message).toBe("I'm a teapot");
  });
});
