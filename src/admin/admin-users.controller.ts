import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuditService } from '../audit/audit.service';
import { AuthService, type Principal } from '../auth/auth.service';
import { escapeFilter, parseId } from '../common/validation';
import { getMeta, getRange } from '../pagination';
import { SupabaseService } from '../supabase.service';
import {
  createUserSchema,
  resetPasswordSchema,
  updateUserSchema,
  userListQuerySchema,
} from './schemas';

const profileColumns =
  'id,email,full_name,role,status,territory,created_at,updated_at';

// Supabase Auth has no "revoke every session for user X"; a long ban stops
// their refresh token working, and the API's active-profile check blocks any
// access token they still hold.
const suspendedBanDuration = '876000h';

type ProfileRow = {
  id: string;
  email: string;
  full_name: string;
  role: string;
  status: string;
  territory: string | null;
};

type AuthErrorLike = { code?: string; message: string; status?: number };

function toFriendlyAuthError(error: AuthErrorLike) {
  if (
    error.code === 'email_exists' ||
    /already (been )?registered|already exists/i.test(error.message)
  ) {
    return new ConflictException(
      'An account with this email address already exists.',
    );
  }

  if (error.code === 'weak_password') {
    return new BadRequestException(
      'That password is too weak. Use a longer password with a mix of letters, numbers and symbols.',
    );
  }

  if (error.status && error.status < 500) {
    return new BadRequestException(error.message);
  }

  return null;
}

@Controller('admin/users')
export class AdminUsersController {
  private readonly logger = new Logger('AdminUsers');

  constructor(
    private readonly auth: AuthService,
    private readonly supabase: SupabaseService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, string>,
  ) {
    await this.auth.requireAdmin(authorization);
    const params = userListQuerySchema.parse(query);
    const { from, to } = getRange(params.page, params.pageSize);

    let request = this.supabase.admin
      .from('admin_profiles')
      .select(profileColumns, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (params.role) {
      request = request.eq('role', params.role);
    }

    if (params.status) {
      request = request.eq('status', params.status);
    }

    if (params.q) {
      const term = escapeFilter(params.q);

      if (term) {
        request = request.or(
          `full_name.ilike.%${term}%,email.ilike.%${term}%,territory.ilike.%${term}%`,
        );
      }
    }

    const { data, error, count } = await request;

    if (error) {
      throw error;
    }

    return {
      data: data ?? [],
      meta: getMeta(params.page, params.pageSize, count ?? 0),
    };
  }

  @Get(':id')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    await this.auth.requireAdmin(authorization);
    const userId = parseId(id);
    const profile = await this.getProfile(userId);
    const { data: authUser } =
      await this.supabase.admin.auth.admin.getUserById(userId);

    return {
      data: {
        ...profile,
        last_sign_in_at: authUser?.user?.last_sign_in_at ?? null,
        email_confirmed_at: authUser?.user?.email_confirmed_at ?? null,
      },
    };
  }

  @Post()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const actor = await this.auth.requireAdmin(authorization);
    const payload = createUserSchema.parse(body);

    const { data, error } = await this.supabase.admin.auth.admin.createUser({
      email: payload.email,
      password: payload.password,
      email_confirm: true,
      user_metadata: {
        full_name: payload.fullName,
        role: payload.role,
        territory: payload.territory,
      },
    });

    if (error || !data.user) {
      throw (
        (error && toFriendlyAuthError(error)) ??
        error ??
        new Error('User was not created.')
      );
    }

    const { data: profile, error: profileError } = await this.supabase.admin
      .from('admin_profiles')
      .upsert({
        id: data.user.id,
        email: payload.email,
        full_name: payload.fullName,
        role: payload.role,
        territory: payload.territory,
        status: 'active',
        created_by: actor.id,
      })
      .select(profileColumns)
      .single();

    if (profileError) {
      // Without a profile the login can never be used, and the orphaned auth
      // user would make every retry fail with "email already exists".
      const { error: rollbackError } =
        await this.supabase.admin.auth.admin.deleteUser(data.user.id);

      if (rollbackError) {
        this.logger.error(
          `Could not roll back auth user ${data.user.id} after profile failure: ${rollbackError.message}`,
        );
      }

      throw profileError;
    }

    await this.audit.record({
      actorId: actor.id,
      action: 'user.created',
      entityType: 'admin_profiles',
      entityId: data.user.id,
      metadata: {
        email: payload.email,
        fullName: payload.fullName,
        role: payload.role,
        territory: payload.territory,
      },
    });

    return { data: profile, message: `Account created for ${payload.email}.` };
  }

  @Patch(':id')
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.auth.requireAdmin(authorization);
    const userId = parseId(id);
    const payload = updateUserSchema.parse(body);
    const existing = await this.getProfile(userId);

    await this.guardAdminContinuity(actor, existing, payload);

    const { data, error } = await this.supabase.admin
      .from('admin_profiles')
      .update({
        ...(payload.fullName !== undefined
          ? { full_name: payload.fullName }
          : {}),
        ...(payload.role !== undefined ? { role: payload.role } : {}),
        ...(payload.status !== undefined ? { status: payload.status } : {}),
        ...(payload.territory !== undefined
          ? { territory: payload.territory }
          : {}),
      })
      .eq('id', userId)
      .select(profileColumns)
      .single();

    if (error) {
      throw error;
    }

    if (payload.status !== undefined && payload.status !== existing.status) {
      const { error: banError } =
        await this.supabase.admin.auth.admin.updateUserById(userId, {
          ban_duration:
            payload.status === 'suspended' ? suspendedBanDuration : 'none',
        });

      if (banError) {
        this.logger.error(
          `Could not update sign-in ban for ${userId}: ${banError.message}`,
        );
      }
    }

    this.auth.evictUser(userId);

    await this.audit.record({
      actorId: actor.id,
      action: 'user.updated',
      entityType: 'admin_profiles',
      entityId: userId,
      metadata: {
        email: existing.email,
        changes: payload,
        previous: { role: existing.role, status: existing.status },
      },
    });

    return { data, message: `Updated ${existing.email}.` };
  }

  @Post(':id/password')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async resetPassword(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.auth.requireAdmin(authorization);
    const userId = parseId(id);
    const payload = resetPasswordSchema.parse(body);
    const existing = await this.getProfile(userId);

    const { error } = await this.supabase.admin.auth.admin.updateUserById(
      userId,
      {
        password: payload.password,
      },
    );

    if (error) {
      throw toFriendlyAuthError(error) ?? error;
    }

    await this.audit.record({
      actorId: actor.id,
      action: 'user.password_reset',
      entityType: 'admin_profiles',
      entityId: userId,
      metadata: { email: existing.email },
    });

    return {
      message: `Password updated for ${existing.email}. Share it with them securely.`,
    };
  }

  /** Stops an admin locking themselves, or everyone, out of the portal. */
  private async guardAdminContinuity(
    actor: Principal,
    existing: ProfileRow,
    payload: { role?: string; status?: string },
  ) {
    const losesAdmin =
      existing.role === 'admin' &&
      existing.status !== 'suspended' &&
      ((payload.role !== undefined && payload.role !== 'admin') ||
        payload.status === 'suspended');

    if (!losesAdmin) {
      return;
    }

    if (existing.id === actor.id) {
      throw new BadRequestException(
        'You cannot remove your own administrator access. Ask another admin to do it.',
      );
    }

    const { count, error } = await this.supabase.admin
      .from('admin_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
      .neq('status', 'suspended')
      .neq('id', existing.id);

    if (error) {
      throw error;
    }

    if (!count) {
      throw new BadRequestException(
        'At least one active administrator must remain.',
      );
    }
  }

  private async getProfile(userId: string) {
    const { data, error } = await this.supabase.admin
      .from('admin_profiles')
      .select(profileColumns)
      .eq('id', userId)
      .maybeSingle<ProfileRow>();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new NotFoundException('User not found.');
    }

    return data;
  }
}
