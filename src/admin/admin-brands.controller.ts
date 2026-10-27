import {
  BadRequestException,
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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { BrandAccessService } from '../auth/brand-access.service';
import { escapeFilter, parseId } from '../common/validation';
import { getMeta, getRange } from '../pagination';
import {
  AssetStorageService,
  type VerifiedUpload,
} from '../storage/asset-storage.service';
import { SupabaseService } from '../supabase.service';
import { brandInputSchema, recordListQuerySchema } from './schemas';

const brandColumns =
  'id,name,slug,category,description,logo_bucket,logo_path,status,sort_order,access_mode,created_at,updated_at';

type BrandLogoRow = {
  id: string;
  name: string;
  logo_bucket: string;
  logo_path: string | null;
};

function duplicateName(error: { code?: string }) {
  return error.code === '23505'
    ? new ConflictException('A brand with that name already exists.')
    : null;
}

@Controller('admin/brands')
export class AdminBrandsController {
  constructor(
    private readonly auth: AuthService,
    private readonly supabase: SupabaseService,
    private readonly storage: AssetStorageService,
    private readonly access: BrandAccessService,
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
      .from('brands')
      .select(brandColumns, { count: 'exact' })
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .range(from, to);

    if (params.status) {
      request = request.eq('status', params.status);
    }

    if (params.q) {
      const term = escapeFilter(params.q);

      if (term) {
        request = request.or(`name.ilike.%${term}%,category.ilike.%${term}%`);
      }
    }

    const { data, error, count } = await request;

    if (error) {
      throw error;
    }

    const brands = (data ?? []) as { id: string }[];
    const people = await this.accessCounts(brands.map((brand) => brand.id));

    return {
      data: brands.map((brand) => ({
        ...brand,
        access_user_count: people.get(brand.id) ?? 0,
      })),
      meta: getMeta(params.page, params.pageSize, count ?? 0),
    };
  }

  /** Every brand, unpaginated, for pickers. */
  @Get('options')
  async options(@Headers('authorization') authorization: string | undefined) {
    await this.auth.requireAdmin(authorization);
    const { data, error } = await this.supabase.admin
      .from('brands')
      .select('id,name,category,status')
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
      .from('brands')
      .select(brandColumns)
      .eq('id', parseId(id))
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new NotFoundException('Brand not found.');
    }

    const { data: grants, error: grantError } = await this.supabase.admin
      .from('brand_access')
      .select('user_id')
      .eq('brand_id', (data as { id: string }).id);

    if (grantError) {
      throw grantError;
    }

    return {
      data: {
        ...data,
        access_user_ids: ((grants ?? []) as { user_id: string }[]).map(
          (grant) => grant.user_id,
        ),
      },
    };
  }

  /** Logo preview for the admin portal, including archived brands. */
  @Get(':id/logo')
  async logo(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Res() response: Response,
  ) {
    await this.auth.requireAdmin(authorization);
    const brand = await this.getBrandLogo(parseId(id));

    if (!brand.logo_path) {
      throw new NotFoundException('This brand has no logo.');
    }

    await this.storage.pipeTo(response, {
      bucket: brand.logo_bucket,
      path: brand.logo_path,
      fileName: brand.logo_path.split('/').pop() ?? 'logo',
      disposition: 'inline',
      cacheControl: 'private, max-age=60',
    });
  }

  @Post()
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const actor = await this.auth.requireAdmin(authorization);
    const payload = brandInputSchema.parse(body);
    const logo = payload.logoIntentId
      ? await this.storage.claimUpload(actor.id, payload.logoIntentId, 'logo')
      : null;

    const { data, error } = await this.supabase.admin
      .from('brands')
      .insert({
        name: payload.name,
        category: payload.category,
        description: payload.description,
        status: payload.status,
        sort_order: payload.sortOrder,
        access_mode: payload.accessMode,
        ...this.logoColumns(logo),
        created_by: actor.id,
        updated_by: actor.id,
      })
      .select(brandColumns)
      .single<{ id: string }>();

    if (error) {
      if (logo) {
        await this.storage.removeObjects(logo.bucket, [logo.path]);
      }

      throw duplicateName(error) ?? error;
    }

    const people = await this.syncAccess(
      data.id,
      payload.accessMode,
      payload.accessUserIds,
      actor.id,
    );

    await this.audit.record({
      actorId: actor.id,
      action: 'brand.created',
      entityType: 'brands',
      entityId: data.id,
      metadata: {
        name: payload.name,
        category: payload.category,
        status: payload.status,
        logo: Boolean(logo),
        accessMode: payload.accessMode,
        accessUserCount: people,
      },
    });

    return { data, message: `Brand folder “${payload.name}” created.` };
  }

  @Patch(':id')
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.auth.requireAdmin(authorization);
    const brandId = parseId(id);
    const payload = brandInputSchema.parse(body);
    const existing = await this.getBrandLogo(brandId);

    if (payload.logoIntentId && payload.removeLogo) {
      throw new BadRequestException(
        'Choose either a replacement logo or removal, not both.',
      );
    }

    const logo = payload.logoIntentId
      ? await this.storage.claimUpload(actor.id, payload.logoIntentId, 'logo')
      : null;
    const logoChange = logo
      ? this.logoColumns(logo)
      : payload.removeLogo
        ? this.logoColumns(null)
        : {};

    const { data, error } = await this.supabase.admin
      .from('brands')
      .update({
        name: payload.name,
        category: payload.category,
        description: payload.description,
        status: payload.status,
        sort_order: payload.sortOrder,
        access_mode: payload.accessMode,
        ...logoChange,
        updated_by: actor.id,
      })
      .eq('id', brandId)
      .select(brandColumns)
      .single<{ id: string }>();

    if (error) {
      if (logo) {
        await this.storage.removeObjects(logo.bucket, [logo.path]);
      }

      throw duplicateName(error) ?? error;
    }

    if ((logo || payload.removeLogo) && existing.logo_path) {
      await this.storage.removeObjects(existing.logo_bucket, [
        existing.logo_path,
      ]);
    }

    const people = await this.syncAccess(
      brandId,
      payload.accessMode,
      payload.accessUserIds,
      actor.id,
    );

    await this.audit.record({
      actorId: actor.id,
      action: 'brand.updated',
      entityType: 'brands',
      entityId: data.id,
      metadata: {
        name: payload.name,
        previousName: existing.name,
        category: payload.category,
        status: payload.status,
        logoReplaced: Boolean(logo),
        logoRemoved: payload.removeLogo && !logo,
        accessMode: payload.accessMode,
        accessUserCount: people,
      },
    });

    return { data, message: `Brand folder “${payload.name}” updated.` };
  }

  /**
   * Makes the brand's grants match the chosen people (none when it is open to
   * everyone), then drops cached access so the change applies at once.
   * Returns how many people have access.
   */
  private async syncAccess(
    brandId: string,
    mode: 'everyone' | 'restricted',
    requested: string[],
    actorId: string,
  ) {
    const db = this.supabase.admin;
    let keep: string[] = [];

    if (mode === 'restricted' && requested.length) {
      // Only real accounts; unknown ids are ignored.
      const { data, error } = await db
        .from('admin_profiles')
        .select('id')
        .in('id', [...new Set(requested)]);
      if (error) throw error;
      keep = ((data ?? []) as { id: string }[]).map((row) => row.id);
    }

    let removal = db.from('brand_access').delete().eq('brand_id', brandId);
    if (keep.length)
      removal = removal.not('user_id', 'in', `(${keep.join(',')})`);
    const { error: removeError } = await removal;
    if (removeError) throw removeError;

    if (keep.length) {
      const { error } = await db.from('brand_access').upsert(
        keep.map((userId) => ({
          brand_id: brandId,
          user_id: userId,
          granted_by: actorId,
        })),
        { onConflict: 'brand_id,user_id', ignoreDuplicates: true },
      );
      if (error) throw error;
    }

    this.access.invalidate();
    return keep.length;
  }

  private async accessCounts(brandIds: string[]) {
    const counts = new Map<string, number>();
    if (brandIds.length === 0) return counts;

    const { data, error } = await this.supabase.admin
      .from('brand_access')
      .select('brand_id')
      .in('brand_id', brandIds);
    if (error) throw error;

    for (const row of (data ?? []) as { brand_id: string }[]) {
      counts.set(row.brand_id, (counts.get(row.brand_id) ?? 0) + 1);
    }
    return counts;
  }

  private logoColumns(logo: VerifiedUpload | null) {
    return {
      logo_bucket: logo?.bucket ?? this.storage.bucket,
      logo_path: logo?.path ?? null,
    };
  }

  private async getBrandLogo(brandId: string) {
    const { data, error } = await this.supabase.admin
      .from('brands')
      .select('id,name,logo_bucket,logo_path')
      .eq('id', brandId)
      .maybeSingle<BrandLogoRow>();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new NotFoundException('Brand not found.');
    }

    return data;
  }
}
