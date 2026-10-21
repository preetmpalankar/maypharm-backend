import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { User } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase.service';

export type AppRole = 'admin' | 'medical' | 'marketing' | 'sales' | 'viewer';
export type ProfileStatus = 'invited' | 'active' | 'suspended';

export type Principal = {
  id: string;
  email: string;
  fullName: string;
  role: AppRole;
  status: ProfileStatus;
};

type CacheEntry = {
  principal: Principal | null;
  user: User;
  expiresAt: number;
};

// Short enough that suspending someone takes effect almost immediately (and
// the admin endpoints evict on change anyway), long enough that a video's
// burst of range requests does not hit Supabase Auth once per chunk.
const cacheTtlMs = 30_000;
const maxCacheEntries = 2_000;

/**
 * Resolves a bearer token to a MayPharm principal.
 *
 * A valid Supabase session is not enough on its own: public sign-up is open
 * on the project, so every read route also requires an *active* profile, and
 * admin routes additionally require the admin role.
 */
@Injectable()
export class AuthService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly supabase: SupabaseService) {}

  /** Any active MayPharm account (field users and admins). */
  async requireMember(authorization?: string): Promise<Principal> {
    const principal = await this.resolve(authorization);

    if (!principal || principal.status !== 'active') {
      throw new ForbiddenException(
        'This account does not have access to MayPharm content.',
      );
    }

    return principal;
  }

  /** Admin role. Invited admins are allowed so a fresh install can bootstrap. */
  async requireAdmin(authorization?: string): Promise<Principal> {
    const principal = await this.resolve(authorization);

    if (
      !principal ||
      principal.role !== 'admin' ||
      principal.status === 'suspended'
    ) {
      throw new ForbiddenException('Administrator access required.');
    }

    return principal;
  }

  /** Drops cached sessions for a user after their role or status changes. */
  evictUser(userId: string) {
    for (const [key, entry] of this.cache) {
      if (entry.user.id === userId) {
        this.cache.delete(key);
      }
    }
  }

  private async resolve(authorization?: string): Promise<Principal | null> {
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : '';

    if (!token) {
      throw new UnauthorizedException('Sign in to continue.');
    }

    const key = createHash('sha256').update(token).digest('hex');
    const cached = this.cache.get(key);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.principal;
    }

    const { data, error } = await this.supabase.admin.auth.getUser(token);

    if (error || !data.user) {
      // AuthApiError carries an HTTP status; network failures carry none, or 0
      // (AuthRetryableFetchError). Only a definite rejection reads as signed out.
      const status = (error as { status?: number } | null)?.status;

      if (error && (!status || status >= 500)) {
        throw new ServiceUnavailableException(
          'Authentication service is temporarily unavailable.',
        );
      }

      throw new UnauthorizedException(
        'Your session has expired. Please sign in again.',
      );
    }

    const { data: profile, error: profileError } = await this.supabase.admin
      .from('admin_profiles')
      .select('id,email,full_name,role,status')
      .eq('id', data.user.id)
      .maybeSingle<{
        id: string;
        email: string;
        full_name: string;
        role: AppRole;
        status: ProfileStatus;
      }>();

    if (profileError) {
      throw profileError;
    }

    const principal: Principal | null = profile
      ? {
          id: profile.id,
          email: profile.email,
          fullName: profile.full_name,
          role: profile.role,
          status: profile.status,
        }
      : null;

    this.remember(key, {
      principal,
      user: data.user,
      expiresAt: Date.now() + cacheTtlMs,
    });

    return principal;
  }

  private remember(key: string, entry: CacheEntry) {
    if (this.cache.size >= maxCacheEntries) {
      const now = Date.now();

      for (const [cachedKey, cachedEntry] of this.cache) {
        if (cachedEntry.expiresAt <= now) {
          this.cache.delete(cachedKey);
        }
      }

      if (this.cache.size >= maxCacheEntries) {
        // Maps iterate in insertion order: the first key is the oldest.
        for (const oldestKey of this.cache.keys()) {
          this.cache.delete(oldestKey);
          break;
        }
      }
    }

    this.cache.set(key, entry);
  }
}
