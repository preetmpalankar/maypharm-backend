import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from './audit/audit.service';
import { AuthService } from './auth/auth.service';
import { escapeFilter, parseId } from './common/validation';
import { getMeta, getRange, paginationSchema } from './pagination';
import { assetFileName } from './storage/asset-names';
import { AssetStorageService } from './storage/asset-storage.service';
import { SupabaseService } from './supabase.service';

const contentTypes = [
  'product',
  'clinical',
  'academy',
  'media',
  'field_asset',
  'regulatory',
] as const;

const contentColumns =
  'id,title,content_type,category,product_name,brand_id,description,status,storage_bucket,storage_path,file_name,file_size,mime_type,metadata,updated_at';

const publicContentQuerySchema = paginationSchema.extend({
  type: z.enum(contentTypes).optional(),
  q: z.string().trim().min(2).max(80).optional(),
  brand: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'Invalid brand slug.')
    .optional(),
});

type AssetRow = {
  id: string;
  title: string;
  status: string;
  storage_bucket: string;
  storage_path: string | null;
  file_name: string | null;
};

@Controller('content')
export class ContentController {
  constructor(
    private readonly auth: AuthService,
    private readonly supabase: SupabaseService,
    private readonly storage: AssetStorageService,
    private readonly audit: AuditService,
  ) {}

  /** Resolves a brand slug to its id. Returns null when the slug is unknown. */
  private async getBrandIdBySlug(slug: string) {
    const { data, error } = await this.supabase.admin
      .from('brands')
      .select('id')
      .eq('slug', slug)
      .eq('status', 'active')
      .maybeSingle<{ id: string }>();

    if (error) {
      throw error;
    }

    return data?.id ?? null;
  }

  @Get()
  async listApprovedContent(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, string>,
  ) {
    await this.auth.requireMember(authorization);

    const params = publicContentQuerySchema.parse(query);
    const { from, to } = getRange(params.page, params.pageSize);

    // An unknown brand filter yields no rows rather than silently ignoring it.
    let brandId: string | null = null;

    if (params.brand) {
      brandId = await this.getBrandIdBySlug(params.brand);

      if (!brandId) {
        return {
          data: [],
          meta: getMeta(params.page, params.pageSize, 0),
        };
      }
    }

    let request = this.supabase.admin
      .from('content_items')
      .select(contentColumns, { count: 'exact' })
      .eq('status', 'approved')
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);

    if (params.type) {
      request = request.eq('content_type', params.type);
    }

    if (brandId) {
      request = request.eq('brand_id', brandId);
    }

    if (params.q) {
      const term = escapeFilter(params.q);

      if (term) {
        request = request.or(
          `title.ilike.%${term}%,description.ilike.%${term}%,category.ilike.%${term}%,product_name.ilike.%${term}%`,
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

  /** Published counts per type plus the newest items, for the home screen. */
  @Get('summary')
  async summary(@Headers('authorization') authorization: string | undefined) {
    await this.auth.requireMember(authorization);

    const counts = await Promise.all(
      contentTypes.map(async (type) => {
        const { count, error } = await this.supabase.admin
          .from('content_items')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'approved')
          .eq('content_type', type);

        if (error) {
          throw error;
        }

        return [type, count ?? 0] as const;
      }),
    );

    const { data: latest, error } = await this.supabase.admin
      .from('content_items')
      .select(contentColumns)
      .eq('status', 'approved')
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(4);

    if (error) {
      throw error;
    }

    const byType = Object.fromEntries(counts) as Record<
      (typeof contentTypes)[number],
      number
    >;

    return {
      data: {
        byType,
        total: Object.values(byType).reduce((sum, value) => sum + value, 0),
        latest: latest ?? [],
      },
    };
  }

  @Get(':id')
  async getApprovedContent(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    await this.auth.requireMember(authorization);

    const { data, error } = await this.supabase.admin
      .from('content_items')
      .select(contentColumns)
      .eq('id', parseId(id))
      .eq('status', 'approved')
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new NotFoundException('Content not available.');
    }

    return { data };
  }

  @Get(':id/asset')
  async streamApprovedAsset(
    @Headers('authorization') authorization: string | undefined,
    @Headers('range') range: string | undefined,
    @Param('id') id: string,
    @Query('download') download: string | undefined,
    @Res() response: Response,
  ) {
    const viewer = await this.auth.requireMember(authorization);
    const { data: item, error } = await this.supabase.admin
      .from('content_items')
      .select('id,title,status,storage_bucket,storage_path,file_name')
      .eq('id', parseId(id))
      .maybeSingle<AssetRow>();

    if (error) {
      throw error;
    }

    if (!item?.storage_path || item.status !== 'approved') {
      throw new NotFoundException('Asset not available.');
    }

    // A video streams as dozens of range requests: audit the first one only.
    const isFirstChunk = !range || /^bytes=0-/.test(range);

    if (isFirstChunk) {
      void this.audit.record({
        actorId: viewer.id,
        action: download === '1' ? 'asset.downloaded' : 'asset.viewed',
        entityType: 'content_items',
        entityId: item.id,
        metadata: { title: item.title },
      });
    }

    await this.storage.pipeTo(response, {
      bucket: item.storage_bucket,
      path: item.storage_path,
      range,
      fileName: assetFileName(item),
      disposition: download === '1' ? 'attachment' : 'inline',
      cacheControl: 'private, no-store, max-age=0',
    });
  }
}
