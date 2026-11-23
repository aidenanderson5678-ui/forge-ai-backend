'use strict';

/** An error that is safe to show to API clients. */
class AppError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code Stable machine-readable error code
   * @param {string} message Human-readable message (safe to expose)
   * @param {{ details?: unknown, headers?: Record<string,string> }} [options]
   */
  constructor(status, code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers || {};
  }
}

/** Thrown when the HTTP client disconnected, so no response should be written. */
class ClientAbortedError extends Error {
  constructor() {
    super('The client closed the connection before the response was ready.');
    this.name = 'ClientAbortedError';
  }
}

module.exports = { AppError, ClientAbortedError };
