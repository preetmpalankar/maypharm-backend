import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { loadConfig } from './config';

const startedAt = new Date().toISOString();

@SkipThrottle()
@Controller()
export class AppController {
  /** Liveness: the process is up and serving. Used by Railway's healthcheck. */
  @Get(['/', 'health'])
  health() {
    return {
      status: 'ok',
      service: 'maypharm-api',
      startedAt,
      timestamp: new Date().toISOString(),
    };
  }

  /** Readiness: Supabase Auth and Storage are reachable from this instance. */
  @Get('health/ready')
  async ready() {
    const config = loadConfig();
    const headers = { apikey: config.SUPABASE_SERVICE_ROLE_KEY };
    const check = async (path: string) => {
      try {
        const response = await fetch(`${config.SUPABASE_URL}${path}`, {
          headers,
          signal: AbortSignal.timeout(3000),
        });
        return response.status < 500;
      } catch {
        return false;
      }
    };

    const [auth, storage] = await Promise.all([
      check('/auth/v1/health'),
      check('/storage/v1/version'),
    ]);

    if (!auth || !storage) {
      throw new ServiceUnavailableException(
        `Dependencies unavailable: ${[!auth && 'auth', !storage && 'storage'].filter(Boolean).join(', ')}.`,
      );
    }

    return { status: 'ready', checks: { auth, storage } };
  }
}
