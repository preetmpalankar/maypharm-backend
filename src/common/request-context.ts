import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const logger = new Logger('HTTP');
const quietPaths = new Set(['/', '/health', '/health/ready']);
const requestIdPattern = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Tags every request with an id (reusing a well-formed `x-request-id` from the
 * web tier so one id follows a request end to end) and logs one line when the
 * response finishes. Health probes are skipped to keep logs readable.
 */
export function requestContext(
  request: Request & { id?: string },
  response: Response,
  next: NextFunction,
) {
  const incoming = request.header('x-request-id');
  const id =
    incoming && requestIdPattern.test(incoming) ? incoming : randomUUID();
  const startedAt = process.hrtime.bigint();

  request.id = id;
  response.setHeader('x-request-id', id);

  response.on('finish', () => {
    if (quietPaths.has(request.path)) {
      return;
    }

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const line = `${request.method} ${request.path} ${response.statusCode} ${durationMs.toFixed(0)}ms rid=${id}`;

    if (response.statusCode >= 500) {
      logger.error(line);
    } else if (response.statusCode >= 400) {
      logger.warn(line);
    } else {
      logger.log(line);
    }
  });

  next();
}
