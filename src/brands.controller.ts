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
import { AuthService, type Principal } from './auth/auth.service';
import { BrandAccessService } from './auth/brand-access.service';
import { brandLibraries, brandLibraryKeys } from './brand-libraries';
import { escapeFilter } from './common/validation';
import { getMeta, getRange, paginationSchema } from './pagination';
import { AssetStorageService } from './storage/asset-storage.service';
import { SupabaseService } from './supabase.service';

const brandColumns =
  'id,name,slug,category,description,logo_bucket,logo_path,sort_order,updated_at';
const contentColumns =
  'id,title,content_type,category,product_name,brand_id,description,status,storage_bucket,storage_path,file_name,file_size,mime_type,metadata,updated_at';

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

@Controller('brands')
export class BrandsController {
  constructor(
    private readonly auth: AuthService,
    private readonly supabase: SupabaseService,
    private readonly storage: AssetStorageService,
    private readonly access: BrandAccessService,
  ) {}

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

  /** An active brand this person may see; anything else is a 404. */
  private async getBrandBySlug(slug: string, viewer: Principal) {
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

    if (!data || (await this.access.hiddenBrandIds(viewer)).includes(data.id)) {
      throw new NotFoundException('Brand not found.');
    }

    return data;
  }

  @Get()
  async listBrands(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, string>,
  ) {
    const viewer = await this.auth.requireMember(authorization);

    const params = brandListQuerySchema.parse(query);
    const { from, to } = getRange(params.page, params.pageSize);
    const hidden = await this.access.hiddenBrandIds(viewer);

    let request = this.supabase.admin
      .from('brands')
      .select(brandColumns, { count: 'exact' })
      .eq('status', 'active')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .range(from, to);

    const brandTerm = params.q ? escapeFilter(params.q) : '';

    if (brandTerm) {
      request = request.or(
        `name.ilike.%${brandTerm}%,category.ilike.%${brandTerm}%`,
      );
    }

    const categoryTerm = params.category ? escapeFilter(params.category) : '';

    if (categoryTerm) {
      request = request.ilike('category', categoryTerm);
    }

    // Restricted brands this person hasn't been given are not listed at all.
    if (hidden.length) {
      request = request.not('id', 'in', `(${hidden.join(',')})`);
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
    const viewer = await this.auth.requireMember(authorization);

    const hidden = await this.access.hiddenBrandIds(viewer);
    let request = this.supabase.admin
      .from('brands')
      .select('category')
      .eq('status', 'active')
      .order('category', { ascending: true });

    if (hidden.length) {
      request = request.not('id', 'in', `(${hidden.join(',')})`);
    }

    const { data, error } = await request;

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
    const viewer = await this.auth.requireMember(authorization);

    const brand = await this.getBrandBySlug(slug, viewer);
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
    const viewer = await this.auth.requireMember(authorization);

    const libraryKey = librarySchema.parse(library);
    const brand = await this.getBrandBySlug(slug, viewer);
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

    const libraryTerm = params.q ? escapeFilter(params.q) : '';

    if (libraryTerm) {
      request = request.or(
        `title.ilike.%${libraryTerm}%,description.ilike.%${libraryTerm}%,category.ilike.%${libraryTerm}%`,
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
    @Res() response: Response,
  ) {
    const viewer = await this.auth.requireMember(authorization);

    const brand = await this.getBrandBySlug(slug, viewer);

    if (!brand.logo_path) {
      throw new NotFoundException('Brand logo not available.');
    }

    await this.storage.pipeTo(response, {
      bucket: brand.logo_bucket,
      path: brand.logo_path,
      fileName: brand.logo_path.split('/').pop() ?? `${brand.slug}-logo`,
      disposition: 'inline',
      cacheControl: 'private, max-age=300',
    });
  }
}
