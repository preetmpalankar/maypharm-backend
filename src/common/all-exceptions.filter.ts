import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';

type ErrorBody = {
  statusCode: number;
  message: string;
  /** Machine-readable reason for clients that must react, e.g. 'upload_invalid'. */
  code?: string;
  fieldErrors?: Record<string, string[]>;
  requestId?: string;
};

type PostgrestLikeError = {
  code: string;
  message: string;
  details?: string | null;
  hint?: string | null;
};

const genericServerMessage =
  'Something went wrong on our side. Please try again in a moment.';

function isPostgrestError(value: unknown): value is PostgrestLikeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PostgrestLikeError).code === 'string' &&
    typeof (value as PostgrestLikeError).message === 'string' &&
    'details' in value
  );
}

/**
 * Express middleware (body-parser) raises http-errors objects rather than
 * HttpExceptions: `{ status, type, expose }`. They are client errors.
 */
function fromHttpError(value: unknown): ErrorBody | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const error = value as {
    status?: unknown;
    statusCode?: unknown;
    type?: unknown;
  };
  const status = Number(error.status ?? error.statusCode);

  if (!Number.isInteger(status) || status < 400 || status >= 500) {
    return null;
  }

  switch (error.type) {
    case 'entity.too.large':
      return { statusCode: status, message: 'Request is too large.' };
    case 'entity.parse.failed':
      return { statusCode: status, message: 'Request body is not valid JSON.' };
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return { statusCode: status, message: 'Unsupported request encoding.' };
    default:
      return {
        statusCode: status,
        message: 'The request could not be processed.',
      };
  }
}

function fromZod(error: ZodError): ErrorBody {
  const fieldErrors: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || 'form';
    (fieldErrors[key] ??= []).push(issue.message);
  }

  return {
    statusCode: HttpStatus.BAD_REQUEST,
    message: error.issues[0]?.message ?? 'Some details are invalid.',
    fieldErrors,
  };
}

function fromHttpException(exception: HttpException): ErrorBody {
  const statusCode = exception.getStatus();
  const response = exception.getResponse();

  if (typeof response === 'string') {
    return { statusCode, message: response };
  }

  const body = response as {
    message?: string | string[];
    code?: string;
    fieldErrors?: Record<string, string[]>;
  };
  const message = Array.isArray(body.message)
    ? body.message.join(' ')
    : (body.message ?? exception.message);

  return {
    statusCode,
    message,
    code: body.code,
    fieldErrors: body.fieldErrors,
  };
}

function fromPostgrest(error: PostgrestLikeError): ErrorBody | null {
  switch (error.code) {
    case '23505':
      return {
        statusCode: HttpStatus.CONFLICT,
        message: 'A record with these details already exists.',
      };
    case '23503':
      return {
        statusCode: HttpStatus.CONFLICT,
        message: 'This record references something that no longer exists.',
      };
    case '22P02':
    case '22023':
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Some details are in an invalid format.',
      };
    case 'PGRST116':
      return { statusCode: HttpStatus.NOT_FOUND, message: 'Record not found.' };
    default:
      return null;
  }
}

/**
 * Every error leaves the API as `{ statusCode, message, fieldErrors?, requestId }`.
 * Client mistakes get a specific, human message; anything unexpected is logged
 * with the request id and answered with a generic 500 so internals never leak.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request & { id?: string }>();

    let body: ErrorBody | null = null;

    if (exception instanceof ZodError) {
      body = fromZod(exception);
    } else if (exception instanceof HttpException) {
      body = fromHttpException(exception);
    } else if (isPostgrestError(exception)) {
      body = fromPostgrest(exception);
    } else {
      body = fromHttpError(exception);
    }

    if (!body || body.statusCode >= 500) {
      this.logger.error(
        `${request.method} ${request.originalUrl} failed (requestId=${request.id ?? 'n/a'})`,
        exception instanceof Error
          ? exception.stack
          : JSON.stringify(exception),
      );
    }

    // Deliberate HttpExceptions keep their message even at 5xx (e.g. a 503
    // naming the dependency that is down). Anything unrecognised is masked.
    if (
      !body ||
      (body.statusCode >= 500 && !(exception instanceof HttpException))
    ) {
      body = {
        statusCode: body?.statusCode ?? HttpStatus.INTERNAL_SERVER_ERROR,
        message: genericServerMessage,
      };
    }

    body.requestId = request.id;

    // A stream that fails part-way has already sent its status line; the only
    // safe thing left is to end the connection.
    if (response.headersSent) {
      response.end();
      return;
    }

    response.status(body.statusCode).json(body);
  }
}
