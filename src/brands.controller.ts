import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { brandLibraries, brandLibraryKeys } from './brand-libraries';
import { getMeta, getRange, paginationSchema } from './pagination';
import { SupabaseService } from './supabase.service';

const brandColumns =
  'id,name,slug,category,description,logo_bucket,logo_path,sort_order,updated_at';
const contentColumns =
  'id,title,content_type,category,product_name,description,status,storage_bucket,storage_path,metadata,updated_at';

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9-]+$/, 'Invalid brand slug.');

const brandListQuerySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(80).optional(),
  category: z.string().trim().min(1).max(120).optional(),
});

const libraryQuerySchema = paginationSchema.extend({
  q: z.string().trim().min(2).max(80).optional(),
});

const librarySchema = z.enum(brandLibraryKeys);

type BrandRow = {
  id: string;
  name: string;
  slug: string;
  category: string;
  description: string;
  logo_bucket: string;
  logo_path: string | null;
  sort_order: number;
  updated_at: string;
};

type CountRow = {
  brand_id: string;
  product_count: number;
  clinical_count: number;
  media_count: number;
  total_count: number;
};

const emptyCounts = { product: 0, clinical: 0, media: 0, total: 0 };

// PostgREST treats %, _ and , as operators inside ilike/or filters.
function escapeFilter(value: string) {
  return value.replace(/[%_,()]/g, '');
}

@Controller('brands')
export class BrandsController {
  constructor(private readonly supabase: SupabaseService) {}

  private async getCountsByBrand(brandIds: string[]) {
    const counts = new Map<string, typeof emptyCounts>();

    if (brandIds.length === 0) {
      return counts;
    }

    const { data, error } = await this.supabase.admin
      .from('brand_library_counts')
      .select('brand_id,product_count,clinical_count,media_count,total_count')
      .in('brand_id', brandIds);

    if (error) {
      throw error;
    }

    for (const row of (data ?? []) as CountRow[]) {
      counts.set(row.brand_id, {
        product: Number(row.product_count ?? 0),
        clinical: Number(row.clinical_count ?? 0),
        media: Number(row.media_count ?? 0),
        total: Number(row.total_count ?? 0),
      });
    }

    return counts;
  }

  private async getBrandBySlug(slug: string) {
    const brandSlug = slugSchema.parse(slug);
    const { data, error } = await this.supabase.admin
      .from('brands')
      .select(brandColumns)
      .eq('slug', brandSlug)
      .eq('status', 'active')
      .maybeSingle<BrandRow>();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new NotFoundException('Brand not found.');
    }

    return data;
  }

  @Get()
  async listBrands(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, string>,
  ) {
    await this.supabase.getUserFromBearer(authorization);

    const params = brandListQuerySchema.parse(query);
    const { from, to } = getRange(params.page, params.pageSize);

    let request = this.supabase.admin
      .from('brands')
      .select(brandColumns, { count: 'exact' })
      .eq('status', 'active')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .range(from, to);

    if (params.q) {
      const safeQuery = escapeFilter(params.q);
      request = request.or(
        `name.ilike.%${safeQuery}%,category.ilike.%${safeQuery}%`,
      );
    }

    if (params.category) {
      request = request.ilike('category', escapeFilter(params.category));
    }

    const { data, error, count } = await request;

    if (error) {
      throw error;
    }

    const brands = (data ?? []) as BrandRow[];
    const counts = await this.getCountsByBrand(brands.map((brand) => brand.id));

    return {
      data: brands.map((brand) => ({
        ...brand,
        counts: counts.get(brand.id) ?? emptyCounts,
      })),
      meta: getMeta(params.page, params.pageSize, count ?? 0),
    };
  }

  @Get('categories')
  async listCategories(
    @Headers('authorization') authorization: string | undefined,
  ) {
    await this.supabase.getUserFromBearer(authorization);

    const { data, error } = await this.supabase.admin
      .from('brands')
      .select('category')
      .eq('status', 'active')
      .order('category', { ascending: true });

    if (error) {
      throw error;
    }

    const categories = new Map<string, string>();

    for (const row of (data ?? []) as { category: string }[]) {
      const label = row.category?.trim();

      if (label && !categories.has(label.toLowerCase())) {
        categories.set(label.toLowerCase(), label);
      }
    }

    return { data: [...categories.values()] };
  }

  @Get(':slug')
  async getBrand(
    @Headers('authorization') authorization: string | undefined,
    @Param('slug') slug: string,
  ) {
    await this.supabase.getUserFromBearer(authorization);

    const brand = await this.getBrandBySlug(slug);
    const counts = await this.getCountsByBrand([brand.id]);

    return {
      data: {
        ...brand,
        counts: counts.get(brand.id) ?? emptyCounts,
      },
    };
  }

  @Get(':slug/library/:library')
  async listBrandLibrary(
    @Headers('authorization') authorization: string | undefined,
    @Param('slug') slug: string,
    @Param('library') library: string,
    @Query() query: Record<string, string>,
  ) {
    await this.supabase.getUserFromBearer(authorization);

    const libraryKey = librarySchema.parse(library);
    const brand = await this.getBrandBySlug(slug);
    const params = libraryQuerySchema.parse(query);
    const { from, to } = getRange(params.page, params.pageSize);

    let request = this.supabase.admin
      .from('content_items')
      .select(contentColumns, { count: 'exact' })
      .eq('brand_id', brand.id)
      .eq('status', 'approved')
      .in('content_type', [...brandLibraries[libraryKey].contentTypes])
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);

    if (params.q) {
      const safeQuery = escapeFilter(params.q);
      request = request.or(
        `title.ilike.%${safeQuery}%,description.ilike.%${safeQuery}%,category.ilike.%${safeQuery}%`,
      );
    }

    const { data, error, count } = await request;

    if (error) {
      throw error;
    }

    return {
      brand,
      library: { key: libraryKey, ...brandLibraries[libraryKey] },
      data: data ?? [],
      meta: getMeta(params.page, params.pageSize, count ?? 0),
    };
  }

  @Get(':slug/logo')
  async streamBrandLogo(
    @Headers('authorization') authorization: string | undefined,
    @Param('slug') slug: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.supabase.getUserFromBearer(authorization);

    const brand = await this.getBrandBySlug(slug);

    if (!brand.logo_path) {
      throw new NotFoundException('Brand logo not available.');
    }

    const { data, error } = await this.supabase.admin.storage
      .from(brand.logo_bucket)
      .download(brand.logo_path);

    if (error || !data) {
      throw new NotFoundException('Brand logo not available.');
    }

    response.set({
      'Cache-Control': 'private, max-age=300',
      'Content-Type': data.type || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    });

    return new StreamableFile(Buffer.from(await data.arrayBuffer()));
  }
}
