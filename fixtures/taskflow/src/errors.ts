export type ErrorCode = "NOT_FOUND" | "VALIDATION_ERROR" | "CONFLICT" | "INTERNAL_ERROR";

const HTTP_STATUS: Record<ErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

/** Domain error carrying an API error code. Thrown by services, rendered by the error handler. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = HTTP_STATUS[code];
    this.details = details;
  }
}

export const notFound = (message: string) => new AppError("NOT_FOUND", message);
export const conflict = (message: string) => new AppError("CONFLICT", message);
export const validationError = (message: string, details?: unknown) =>
  new AppError("VALIDATION_ERROR", message, details);

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export function toErrorBody(err: AppError): ErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details === undefined ? {} : { details: err.details }),
    },
  };
}
