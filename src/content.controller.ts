import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Res,
  StreamableFile,
  Query,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { paginationSchema, getMeta, getRange } from './pagination';
import { SupabaseService } from './supabase.service';

const contentTypes = [
  'product',
  'clinical',
  'academy',
  'media',
  'field_asset',
  'regulatory',
] as const;

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

@Controller('content')
export class ContentController {
  constructor(private readonly supabase: SupabaseService) {}

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
    await this.supabase.getUserFromBearer(authorization);

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
      .select(
        'id,title,content_type,category,product_name,brand_id,description,status,storage_bucket,storage_path,metadata,updated_at',
        {
          count: 'exact',
        },
      )
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
      const safeQuery = params.q.replace(/[%_,]/g, '');
      request = request.or(
        `title.ilike.%${safeQuery}%,description.ilike.%${safeQuery}%,category.ilike.%${safeQuery}%,product_name.ilike.%${safeQuery}%`,
      );
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
  async getApprovedContent(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    await this.supabase.getUserFromBearer(authorization);

    const { data, error } = await this.supabase.admin
      .from('content_items')
      .select(
        'id,title,content_type,category,product_name,brand_id,description,status,storage_bucket,storage_path,metadata,updated_at',
      )
      .eq('id', id)
      .eq('status', 'approved')
      .single();

    if (error || !data) {
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
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = await this.supabase.getUserFromBearer(authorization);
    const { data: item, error } = await this.supabase.admin
      .from('content_items')
      .select('id,title,status,storage_bucket,storage_path')
      .eq('id', id)
      .single<{
        id: string;
        title: string;
        status: string;
        storage_bucket: string;
        storage_path: string | null;
      }>();

    if (error || !item?.storage_path || item.status !== 'approved') {
      throw new NotFoundException('Asset not available.');
    }

    const { data: signedAsset, error: signedUrlError } =
      await this.supabase.admin.storage
        .from(item.storage_bucket)
        .createSignedUrl(item.storage_path, 60);

    if (signedUrlError || !signedAsset?.signedUrl) {
      throw new NotFoundException('Asset not available.');
    }

    const upstream = await fetch(signedAsset.signedUrl, {
      headers: range ? { Range: range } : undefined,
    });

    if (!upstream.ok || !upstream.body) {
      throw new NotFoundException('Asset not available.');
    }

    await this.supabase.admin.from('audit_events').insert({
      actor_id: user.id,
      action: 'asset.viewed',
      entity_type: 'content_items',
      entity_id: item.id,
      metadata: {
        title: item.title,
        storagePath: item.storage_path,
      },
    });

    const filename = getAssetFilename(item.title, item.storage_path);
    const contentDisposition =
      download === '1'
        ? `attachment; filename="${filename}"`
        : `inline; filename="${filename}"`;
    const headers: Record<string, string> = {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      'Content-Type':
        upstream.headers.get('content-type') ?? 'application/octet-stream',
      'Content-Disposition': contentDisposition,
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Accept-Ranges': upstream.headers.get('accept-ranges') ?? 'bytes',
    };

    for (const header of ['content-length', 'content-range']) {
      const value = upstream.headers.get(header);

      if (value) {
        headers[header.replace(/\b\w/g, (match) => match.toUpperCase())] =
          value;
      }
    }

    response.status(upstream.status);
    response.set(headers);

    return new StreamableFile(Buffer.from(await upstream.arrayBuffer()));
  }
}

function getAssetFilename(title: string, storagePath: string) {
  const extension = storagePath.split('.').pop()?.toLowerCase();
  const safeTitle =
    title
      .trim()
      .replace(/[^a-z0-9.-]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || 'maypharm-asset';

  if (!extension || safeTitle.toLowerCase().endsWith(`.${extension}`)) {
    return safeTitle;
  }

  return `${safeTitle}.${extension}`;
}
