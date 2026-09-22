import { Controller, Get, Headers, Query } from '@nestjs/common';
import { z } from 'zod';
import { getMeta, getRange, paginationSchema } from './pagination';
import { SupabaseService } from './supabase.service';

const categoryColumns = 'id,name,slug,description,sort_order,updated_at';

const listQuerySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(80).optional(),
});

@Controller('categories')
export class CategoriesController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get()
  async listCategories(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, string>,
  ) {
    await this.supabase.getUserFromBearer(authorization);

    const params = listQuerySchema.parse(query);
    const { from, to } = getRange(params.page, params.pageSize);

    let request = this.supabase.admin
      .from('categories')
      .select(categoryColumns, { count: 'exact' })
      .eq('status', 'active')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .range(from, to);

    if (params.q) {
      request = request.ilike('name', `%${params.q.replace(/[%_,()]/g, '')}%`);
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
}
