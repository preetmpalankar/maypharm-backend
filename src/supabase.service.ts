import {
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { createClient, SupabaseClient, User } from '@supabase/supabase-js';

type AdminProfileAccess = {
  role: string;
  status: string;
};

@Injectable()
export class SupabaseService {
  readonly admin: SupabaseClient;

  constructor() {
    const url =
      process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceRoleKey) {
      throw new InternalServerErrorException(
        'Supabase backend credentials are not configured.',
      );
    }

    this.admin = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }) as SupabaseClient;
  }

  async getUserFromBearer(authorization?: string): Promise<User> {
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : null;

    if (!token) {
      throw new UnauthorizedException('Bearer token required.');
    }

    const {
      data: { user },
      error,
    } = await this.admin.auth.getUser(token);

    if (error || !user) {
      throw new UnauthorizedException('Invalid Supabase session.');
    }

    return user;
  }

  async requireAdmin(userId: string) {
    const { data, error } = await this.admin
      .from('admin_profiles')
      .select('role,status')
      .eq('id', userId)
      .single<AdminProfileAccess>();

    if (
      error ||
      data?.role !== 'admin' ||
      !['active', 'invited'].includes(data.status)
    ) {
      throw new UnauthorizedException('Administrator access required.');
    }
  }
}
