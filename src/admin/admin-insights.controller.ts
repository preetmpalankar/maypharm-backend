import { Controller, Get, Headers, Query } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth.service';
import { getMeta, getRange } from '../pagination';
import { SupabaseService } from '../supabase.service';
import { auditListQuerySchema, contentStatuses, contentTypes } from './schemas';

function headCount(client: SupabaseClient, table: string) {
  return client.from(table).select('id', { count: 'exact', head: true });
}

type HeadQuery = ReturnType<typeof headCount>;

type AuditRow = {
  id: number;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

@Controller('admin')
export class AdminInsightsController {
  constructor(
    private readonly auth: AuthService,
    private readonly supabase: SupabaseService,
  ) {}

  /** Real totals across the whole dataset, not just the page on screen. */
  @Get('stats')
  async stats(@Headers('authorization') authorization: string | undefined) {
    await this.auth.requireAdmin(authorization);

    const count = async (
      table: string,
      filter?: (query: HeadQuery) => HeadQuery,
    ) => {
      const base = headCount(this.supabase.admin, table);
      const { count: total, error } = await (filter ? filter(base) : base);

      if (error) {
        throw error;
      }

      return total ?? 0;
    };

    const [
      users,
      activeUsers,
      brands,
      activeBrands,
      categories,
      content,
      withFile,
      ...rest
    ] = await Promise.all([
      count('admin_profiles'),
      count('admin_profiles', (query) => query.eq('status', 'active')),
      count('brands'),
      count('brands', (query) => query.eq('status', 'active')),
      count('categories', (query) => query.eq('status', 'active')),
      count('content_items'),
      count('content_items', (query) => query.not('storage_path', 'is', null)),
      ...contentStatuses.map((status) =>
        count('content_items', (query) => query.eq('status', status)),
      ),
      ...contentTypes.map((type) =>
        count('content_items', (query) => query.eq('content_type', type)),
      ),
    ]);

    const byStatus = Object.fromEntries(
      contentStatuses.map((status, index) => [status, rest[index] ?? 0]),
    );
    const byType = Object.fromEntries(
      contentTypes.map((type, index) => [
        type,
        rest[contentStatuses.length + index] ?? 0,
      ]),
    );

    return {
      data: {
        users: { total: users, active: activeUsers },
        brands: { total: brands, active: activeBrands },
        categories: { active: categories },
        content: { total: content, withFile, byStatus, byType },
      },
    };
  }

  @Get('audit-events')
  async auditEvents(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, string>,
  ) {
    await this.auth.requireAdmin(authorization);
    const params = auditListQuerySchema.parse(query);
    const { from, to } = getRange(params.page, params.pageSize);

    let request = this.supabase.admin
      .from('audit_events')
      .select('id,actor_id,action,entity_type,entity_id,metadata,created_at', {
        count: 'exact',
      })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);

    if (params.entityType) {
      request = request.eq('entity_type', params.entityType);
    }

    if (params.action) {
      request = request.eq('action', params.action);
    }

    const { data, error, count } = await request.returns<AuditRow[]>();

    if (error) {
      throw error;
    }

    const events = data ?? [];
    const actorIds = [
      ...new Set(events.map((event) => event.actor_id).filter(Boolean)),
    ] as string[];
    const actors = new Map<string, { email: string; full_name: string }>();

    if (actorIds.length > 0) {
      const { data: profiles, error: profileError } = await this.supabase.admin
        .from('admin_profiles')
        .select('id,email,full_name')
        .in('id', actorIds)
        .returns<{ id: string; email: string; full_name: string }[]>();

      if (profileError) {
        throw profileError;
      }

      for (const profile of profiles ?? []) {
        actors.set(profile.id, {
          email: profile.email,
          full_name: profile.full_name,
        });
      }
    }

    return {
      data: events.map((event) => ({
        ...event,
        actor: event.actor_id ? (actors.get(event.actor_id) ?? null) : null,
      })),
      meta: getMeta(params.page, params.pageSize, count ?? 0),
    };
  }
}
