import {
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
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { escapeFilter, parseId } from '../common/validation';
import { getMeta, getRange } from '../pagination';
import { SupabaseService } from '../supabase.service';
import { categoryInputSchema, recordListQuerySchema } from './schemas';

const categoryColumns =
  'id,name,slug,description,status,sort_order,created_at,updated_at';

function duplicateName(error: { code?: string }) {
  return error.code === '23505'
    ? new ConflictException('A category with that name already exists.')
    : null;
}

@Controller('admin/categories')
export class AdminCategoriesController {
  private readonly logger = new Logger('AdminCategories');

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
      .from('categories')
      .select(categoryColumns, { count: 'exact' })
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

    return {
      data: data ?? [],
      meta: getMeta(params.page, params.pageSize, count ?? 0),
    };
  }

  /** Every category, unpaginated, for pickers. */
  @Get('options')
  async options(@Headers('authorization') authorization: string | undefined) {
    await this.auth.requireAdmin(authorization);
    const { data, error } = await this.supabase.admin
      .from('categories')
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
      .from('categories')
      .select(categoryColumns)
      .eq('id', parseId(id))
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new NotFoundException('Category not found.');
    }

    return { data };
  }

  @Post()
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const actor = await this.auth.requireAdmin(authorization);
    const payload = categoryInputSchema.parse(body);

    const { data, error } = await this.supabase.admin
      .from('categories')
      .insert({
        name: payload.name,
        description: payload.description,
        status: payload.status,
        sort_order: payload.sortOrder,
        created_by: actor.id,
        updated_by: actor.id,
      })
      .select(categoryColumns)
      .single<{ id: string }>();

    if (error) {
      throw duplicateName(error) ?? error;
    }

    await this.audit.record({
      actorId: actor.id,
      action: 'category.created',
      entityType: 'categories',
      entityId: data.id,
      metadata: payload,
    });

    return { data, message: `Category “${payload.name}” created.` };
  }

  @Patch(':id')
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.auth.requireAdmin(authorization);
    const categoryId = parseId(id);
    const payload = categoryInputSchema.parse(body);

    const { data: existing, error: existingError } = await this.supabase.admin
      .from('categories')
      .select('name')
      .eq('id', categoryId)
      .maybeSingle<{ name: string }>();

    if (existingError) {
      throw existingError;
    }

    if (!existing) {
      throw new NotFoundException('Category not found.');
    }

    const { data, error } = await this.supabase.admin
      .from('categories')
      .update({
        name: payload.name,
        description: payload.description,
        status: payload.status,
        sort_order: payload.sortOrder,
        updated_by: actor.id,
      })
      .eq('id', categoryId)
      .select(categoryColumns)
      .single<{ id: string }>();

    if (error) {
      throw duplicateName(error) ?? error;
    }

    // Categories are denormalised onto content and brands, so a rename has to
    // carry across or those rows would point at a name that no longer exists.
    if (existing.name !== payload.name) {
      const [contentResult, brandResult] = await Promise.all([
        this.supabase.admin
          .from('content_items')
          .update({ category: payload.name })
          .eq('category', existing.name),
        this.supabase.admin
          .from('brands')
          .update({ category: payload.name })
          .eq('category', existing.name),
      ]);

      for (const result of [contentResult, brandResult]) {
        if (result.error) {
          this.logger.error(
            `Rename of category "${existing.name}" did not fully propagate: ${result.error.message}`,
          );
        }
      }
    }

    await this.audit.record({
      actorId: actor.id,
      action: 'category.updated',
      entityType: 'categories',
      entityId: data.id,
      metadata: { ...payload, previousName: existing.name },
    });

    return { data, message: `Category “${payload.name}” updated.` };
  }
}
