export class HttpError extends Error {
  constructor(message, { statusCode, body = '', url, retryAfterMs } = {}) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.body = body;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
  }
}

export class BlockFramingError extends Error {
  constructor(message, offset) {
    super(`Observer block framing failed at byte ${offset}: ${message}`);
    this.name = 'BlockFramingError';
    this.offset = offset;
  }
}

