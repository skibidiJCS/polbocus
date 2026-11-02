import "server-only";

/** A request the app refuses, with the HTTP status to send. */
export class ServiceError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

export class UploadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
