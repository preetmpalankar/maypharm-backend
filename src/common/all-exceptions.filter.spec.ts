import {
  ArgumentsHost,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { AllExceptionsFilter } from './all-exceptions.filter';

function createHost(headersSent = false) {
  const response = {
    headersSent,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    end: jest.fn(),
  };
  const request = {
    method: 'POST',
    originalUrl: '/admin/content',
    id: 'req-123',
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return { host, response };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('turns validation failures into a 400 with per-field messages', () => {
    const schema = z.object({
      title: z.string().min(2, 'Title must be at least 2 characters.'),
      description: z
        .string()
        .min(10, 'Summary must be at least 10 characters.'),
    });
    const result = schema.safeParse({ title: 'x', description: 'short' });
    const { host, response } = createHost();

    filter.catch(result.error, host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 400,
      message: 'Title must be at least 2 characters.',
      fieldErrors: {
        title: ['Title must be at least 2 characters.'],
        description: ['Summary must be at least 10 characters.'],
      },
      requestId: 'req-123',
    });
  });

  it('passes HttpException status and message through', () => {
    const { host, response } = createHost();

    filter.catch(
      new ConflictException('A brand with that name already exists.'),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'A brand with that name already exists.',
      }),
    );
  });

  it('keeps the message of a deliberate 5xx', () => {
    const { host, response } = createHost();

    filter.catch(
      new ServiceUnavailableException(
        'File storage is temporarily unavailable.',
      ),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'File storage is temporarily unavailable.',
      }),
    );
  });

  it('maps known database errors to client statuses', () => {
    const { host, response } = createHost();

    filter.catch(
      { code: '23505', message: 'duplicate key', details: null, hint: null },
      host,
    );

    expect(response.status).toHaveBeenCalledWith(409);
  });

  it('masks unexpected errors behind a generic 500', () => {
    const { host, response } = createHost();

    filter.catch(
      new Error('connection string postgres://secret@db leaked'),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(500);
    const [[body]] = response.json.mock.calls as [[{ message: string }]];
    expect(body.message).not.toContain('secret');
    expect(body.message).toMatch(/try again/);
  });

  it('only ends the connection if a stream already sent headers', () => {
    const { host, response } = createHost(true);

    filter.catch(new Error('stream broke'), host);

    expect(response.end).toHaveBeenCalled();
    expect(response.status).not.toHaveBeenCalled();
  });
});
