import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { SupabaseService } from '../supabase.service';
import { AuthService } from './auth.service';

type Profile = {
  id: string;
  email: string;
  full_name: string;
  role: string;
  status: string;
} | null;

function createAuth(options: {
  user?: { id: string } | null;
  authError?: { status?: number; message: string } | null;
  profile?: Profile;
}) {
  const getUser = jest.fn().mockResolvedValue({
    data: {
      user: options.user === undefined ? { id: 'user-1' } : options.user,
    },
    error: options.authError ?? null,
  });
  const maybeSingle = jest.fn().mockResolvedValue({
    data:
      options.profile === undefined
        ? {
            id: 'user-1',
            email: 'a@maypharm.com',
            full_name: 'A',
            role: 'sales',
            status: 'active',
          }
        : options.profile,
    error: null,
  });
  const query = { select: () => query, eq: () => query, maybeSingle };
  const supabase = {
    admin: { auth: { getUser }, from: () => query },
  } as unknown as SupabaseService;

  return { auth: new AuthService(supabase), getUser };
}

describe('AuthService', () => {
  it('requires a bearer token', async () => {
    const { auth } = createAuth({});

    await expect(auth.requireMember(undefined)).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(auth.requireMember('Basic abc')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('accepts an active member', async () => {
    const { auth } = createAuth({});

    await expect(auth.requireMember('Bearer token')).resolves.toMatchObject({
      id: 'user-1',
      role: 'sales',
    });
  });

  it('rejects a valid session with no MayPharm profile (public sign-up)', async () => {
    const { auth } = createAuth({ profile: null });

    await expect(auth.requireMember('Bearer token')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects suspended and invited members from content', async () => {
    for (const status of ['suspended', 'invited']) {
      const { auth } = createAuth({
        profile: {
          id: 'user-1',
          email: 'a@x',
          full_name: 'A',
          role: 'sales',
          status,
        },
      });

      await expect(auth.requireMember('Bearer token')).rejects.toThrow(
        ForbiddenException,
      );
    }
  });

  it('only admits non-suspended admins to admin routes', async () => {
    const member = createAuth({});
    await expect(member.auth.requireAdmin('Bearer token')).rejects.toThrow(
      ForbiddenException,
    );

    const suspended = createAuth({
      profile: {
        id: 'user-1',
        email: 'a@x',
        full_name: 'A',
        role: 'admin',
        status: 'suspended',
      },
    });
    await expect(suspended.auth.requireAdmin('Bearer token')).rejects.toThrow(
      ForbiddenException,
    );

    const admin = createAuth({
      profile: {
        id: 'user-1',
        email: 'a@x',
        full_name: 'A',
        role: 'admin',
        status: 'active',
      },
    });
    await expect(
      admin.auth.requireAdmin('Bearer token'),
    ).resolves.toMatchObject({ role: 'admin' });
  });

  it('reads an expired session as signed out, but an outage as 503', async () => {
    const expired = createAuth({
      user: null,
      authError: { status: 401, message: 'jwt expired' },
    });
    await expect(expired.auth.requireMember('Bearer token')).rejects.toThrow(
      UnauthorizedException,
    );

    const outage = createAuth({
      user: null,
      authError: { message: 'fetch failed' },
    });
    await expect(outage.auth.requireMember('Bearer token')).rejects.toThrow(
      ServiceUnavailableException,
    );

    // supabase-js reports network failures as AuthRetryableFetchError, status 0.
    const retryable = createAuth({
      user: null,
      authError: { status: 0, message: 'fetch failed' },
    });
    await expect(retryable.auth.requireMember('Bearer token')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('caches a resolved session and evicts it on demand', async () => {
    const { auth, getUser } = createAuth({});

    await auth.requireMember('Bearer token');
    await auth.requireMember('Bearer token');
    expect(getUser).toHaveBeenCalledTimes(1);

    auth.evictUser('user-1');
    await auth.requireMember('Bearer token');
    expect(getUser).toHaveBeenCalledTimes(2);
  });
});
