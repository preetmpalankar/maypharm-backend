import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'node:crypto';

/**
 * Rate limits per signed-in account rather than per IP. Every browser request
 * reaches the API through the web server, so an IP-based limit would throttle
 * all users together; the bearer token identifies the actual caller.
 */
@Injectable()
export class AccountThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(request: Record<string, any>): Promise<string> {
    const { headers, ip } = request as {
      headers?: Record<string, unknown>;
      ip?: string;
    };
    const authorization = headers?.authorization;

    if (
      typeof authorization === 'string' &&
      authorization.startsWith('Bearer ')
    ) {
      const digest = createHash('sha256').update(authorization).digest('hex');
      return Promise.resolve(`token:${digest.slice(0, 32)}`);
    }

    return Promise.resolve(`ip:${ip ?? 'unknown'}`);
  }
}
