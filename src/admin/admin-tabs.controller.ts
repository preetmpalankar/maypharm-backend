import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { escapeFilter, parseId } from '../common/validation';
import { getMeta, getRange } from '../pagination';
import { SupabaseService } from '../supabase.service';
import { recordListQuerySchema, tabInputSchema } from './schemas';

const tabColumns =
  'id,name,slug,description,status,sort_order,created_at,updated_at';

function duplicateName(error: { code?: string }) {
  return error.code === '23505'
    ? new ConflictException('A tab with that name already exists.')
    : null;
}

/**
 * Custom tabs: libraries that appear under every brand in the MayPharm app,
 * after Product, Clinical Evidence and Media. Content is placed in one from
 * the upload form.
 */
@Controller('admin/tabs')
export class AdminTabsController {
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
    const params = recordListQuerySchema.parse(query);
    const { from, to } = getRange(params.page, params.pageSize);

    let request = this.supabase.admin
      .from('content_tabs')
      .select(tabColumns, { count: 'exact' })
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .range(from, to);

    if (params.status) {
      request = request.eq('status', params.status);
    }

    if (params.q) {
      const term = escapeFilter(params.q);

      if (term) {
        request = request.ilike('name', `%${term}%`);
      }
    }

    const { data, error, count } = await request;

    if (error) {
      throw error;
    }

    const tabs = (data ?? []) as { id: string }[];
    const items = await this.itemCounts(tabs.map((tab) => tab.id));

    return {
      data: tabs.map((tab) => ({ ...tab, item_count: items.get(tab.id) ?? 0 })),
      meta: getMeta(params.page, params.pageSize, count ?? 0),
    };
  }

  /** Every tab, unpaginated, for pickers. */
  @Get('options')
  async options(@Headers('authorization') authorization: string | undefined) {
    await this.auth.requireAdmin(authorization);
    const { data, error } = await this.supabase.admin
      .from('content_tabs')
      .select('id,name,status')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .limit(2000);

    if (error) {
      throw error;
    }

    return { data: data ?? [] };
  }

  @Get(':id')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    await this.auth.requireAdmin(authorization);
    const { data, error } = await this.supabase.admin
      .from('content_tabs')
      .select(tabColumns)
      .eq('id', parseId(id))
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new NotFoundException('Tab not found.');
    }

    return { data };
  }

  @Post()
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const actor = await this.auth.requireAdmin(authorization);
    const payload = tabInputSchema.parse(body);

    const { data, error } = await this.supabase.admin
      .from('content_tabs')
      .insert({
        name: payload.name,
        description: payload.description,
        status: payload.status,
        sort_order: payload.sortOrder,
        created_by: actor.id,
        updated_by: actor.id,
      })
      .select(tabColumns)
      .single<{ id: string }>();

    if (error) {
      throw duplicateName(error) ?? error;
    }

    await this.audit.record({
      actorId: actor.id,
      action: 'tab.created',
      entityType: 'content_tabs',
      entityId: data.id,
      metadata: payload,
    });

    return { data, message: `Tab “${payload.name}” created.` };
  }

  @Patch(':id')
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.auth.requireAdmin(authorization);
    const tabId = parseId(id);
    const payload = tabInputSchema.parse(body);

    const { data: existing, error: existingError } = await this.supabase.admin
      .from('content_tabs')
      .select('name')
      .eq('id', tabId)
      .maybeSingle<{ name: string }>();

    if (existingError) {
      throw existingError;
    }

    if (!existing) {
      throw new NotFoundException('Tab not found.');
    }

    const { data, error } = await this.supabase.admin
      .from('content_tabs')
      .update({
        name: payload.name,
        description: payload.description,
        status: payload.status,
        sort_order: payload.sortOrder,
        updated_by: actor.id,
      })
      .eq('id', tabId)
      .select(tabColumns)
      .single<{ id: string }>();

    if (error) {
      throw duplicateName(error) ?? error;
    }

    await this.audit.record({
      actorId: actor.id,
      action: 'tab.updated',
      entityType: 'content_tabs',
      entityId: data.id,
      metadata: { ...payload, previousName: existing.name },
    });

    return { data, message: `Tab “${payload.name}” updated.` };
  }

  /** How many content items each tab holds (any status). */
  private async itemCounts(tabIds: string[]) {
    const counts = new Map<string, number>();
    if (tabIds.length === 0) return counts;

    const { data, error } = await this.supabase.admin
      .from('content_items')
      .select('tab_id')
      .in('tab_id', tabIds);
    if (error) throw error;

    for (const row of (data ?? []) as { tab_id: string }[]) {
      counts.set(row.tab_id, (counts.get(row.tab_id) ?? 0) + 1);
    }
    return counts;
  }
}
