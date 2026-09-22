import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { getMeta, getRange, paginationSchema } from './pagination';
import { SupabaseService } from './supabase.service';

const createUserSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(2).max(120),
  role: z.enum(['admin', 'medical', 'marketing', 'sales', 'viewer']),
  territory: z.string().max(120).optional(),
});

const contentIdSchema = z.string().uuid();
const brandIdSchema = z.string().uuid();
const categoryIdSchema = z.string().uuid();

const categorySchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(600).default(''),
  status: z.enum(['active', 'archived']).default('active'),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});

const brandSchema = z.object({
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(120),
  description: z.string().trim().max(600).default(''),
  status: z.enum(['active', 'archived']).default('active'),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});

const contentSchema = z
  .object({
    title: z.string().min(2).max(180),
    contentType: z.enum([
      'product',
      'clinical',
      'academy',
      'media',
      'field_asset',
      'regulatory',
    ]),
    category: z.string().min(2).max(120),
    productName: z.string().max(160).optional(),
    brandId: z.string().uuid().optional(),
    status: z.enum(['draft', 'review', 'approved', 'archived']),
    description: z.string().min(10).max(2000),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .superRefine((payload, context) => {
    if (
      payload.contentType === 'clinical' &&
      !payload.brandId &&
      !payload.productName?.trim()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['brandId'],
        message: 'Clinical evidence must be tagged to a brand.',
      });
    }
  });

type UploadedAsset = {
  buffer: Buffer;
  size: number;
  mimetype: string;
  originalname: string;
};

const assetBucket = 'maypharm-admin-assets';
const maxUploadBytes = 50 * 1024 * 1024;
const maxLogoBytes = 2 * 1024 * 1024;
const allowedLogoMimeTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);
const allowedMimeTypes = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'video/mp4',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

function getStoragePath(
  contentType: string,
  title: string,
  originalName: string,
) {
  const extension = originalName.split('.').pop()?.toLowerCase() ?? 'bin';
  const safeName = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);

  return `${contentType}/${crypto.randomUUID()}-${safeName}.${extension}`;
}

function getLogoStoragePath(name: string, originalName: string) {
  const extension = originalName.split('.').pop()?.toLowerCase() ?? 'png';
  const safeName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);

  return `brands/${crypto.randomUUID()}-${safeName}.${extension}`;
}

function collectMetadata(body: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(body)
      .filter(([key, value]) => key.startsWith('metadata.') && value?.trim())
      .map(([key, value]) => [key.replace('metadata.', ''), value.trim()]),
  );
}

@Controller('admin')
export class AdminController {
  constructor(private readonly supabase: SupabaseService) {}

  private async requireAdmin(authorization?: string) {
    const user = await this.supabase.getUserFromBearer(authorization);
    await this.supabase.requireAdmin(user.id);
    return user;
  }

  private async getBrandOrFail(brandId: string) {
    const { data, error } = await this.supabase.admin
      .from('brands')
      .select('id,name')
      .eq('id', brandId)
      .maybeSingle<{ id: string; name: string }>();

    if (error) {
      throw new BadRequestException(error.message);
    }

    if (!data) {
      throw new BadRequestException('Selected brand no longer exists.');
    }

    return data;
  }

  private async uploadBrandLogo(name: string, logo: UploadedAsset) {
    if (logo.size > maxLogoBytes) {
      throw new BadRequestException('Logo must be 2 MB or smaller.');
    }

    if (!allowedLogoMimeTypes.has(logo.mimetype)) {
      throw new BadRequestException(
        'Unsupported logo type. Upload a PNG, JPG, or WEBP image.',
      );
    }

    const logoPath = getLogoStoragePath(name, logo.originalname);
    const { error } = await this.supabase.admin.storage
      .from(assetBucket)
      .upload(logoPath, logo.buffer, {
        contentType: logo.mimetype,
        upsert: false,
      });

    if (error) {
      throw new BadRequestException(error.message);
    }

    return logoPath;
  }

  @Get('content')
  async listContent(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, string>,
  ) {
    await this.requireAdmin(authorization);
    const params = paginationSchema.parse(query);
    const { from, to } = getRange(params.page, params.pageSize);
    const { data, error, count } = await this.supabase.admin
      .from('content_items')
      .select(
        'id,title,content_type,category,status,product_name,brand_id,storage_path,metadata,updated_at',
        { count: 'exact' },
      )
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);

    if (error) {
      throw error;
    }

    return {
      data: data ?? [],
      meta: getMeta(params.page, params.pageSize, count ?? 0),
    };
  }

  @Get('content/:id')
  async getContent(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    await this.requireAdmin(authorization);
    const contentId = contentIdSchema.parse(id);
    const { data, error } = await this.supabase.admin
      .from('content_items')
      .select(
        'id,title,content_type,category,status,product_name,brand_id,description,storage_path,metadata,updated_at',
      )
      .eq('id', contentId)
      .single();

    if (error) {
      throw new BadRequestException(error.message);
    }

    return { data };
  }

  @Get('users')
  async listUsers(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, string>,
  ) {
    await this.requireAdmin(authorization);
    const params = paginationSchema.parse(query);
    const { from, to } = getRange(params.page, params.pageSize);
    const { data, error, count } = await this.supabase.admin
      .from('admin_profiles')
      .select('id,full_name,email,role,status,territory,created_at', {
        count: 'exact',
      })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) {
      throw error;
    }

    return {
      data: data ?? [],
      meta: getMeta(params.page, params.pageSize, count ?? 0),
    };
  }

  @Get('audit-events')
  async listAuditEvents(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, string>,
  ) {
    await this.requireAdmin(authorization);
    const params = paginationSchema.parse(query);
    const { from, to } = getRange(params.page, params.pageSize);
    const { data, error, count } = await this.supabase.admin
      .from('audit_events')
      .select('id,actor_id,action,entity_type,entity_id,metadata,created_at', {
        count: 'exact',
      })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) {
      throw error;
    }

    return {
      data: data ?? [],
      meta: getMeta(params.page, params.pageSize, count ?? 0),
    };
  }

  @Post('users')
  async createUser(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const actor = await this.requireAdmin(authorization);
    const payload = createUserSchema.parse(body);
    const { data, error } = await this.supabase.admin.auth.admin.createUser({
      email: payload.email,
      email_confirm: true,
      user_metadata: {
        full_name: payload.fullName,
        role: payload.role,
        territory: payload.territory ?? null,
      },
    });

    if (error) {
      throw error;
    }

    const { error: profileError } = await this.supabase.admin
      .from('admin_profiles')
      .upsert({
        id: data.user.id,
        email: payload.email,
        full_name: payload.fullName,
        role: payload.role,
        territory: payload.territory ?? null,
        status: 'invited',
        created_by: actor.id,
      });

    if (profileError) {
      throw profileError;
    }

    await this.supabase.admin.from('audit_events').insert({
      actor_id: actor.id,
      action: 'user.created',
      entity_type: 'admin_profiles',
      entity_id: data.user.id,
      metadata: payload,
    });

    return { id: data.user.id, email: data.user.email };
  }

  @Post('content')
  @UseInterceptors(
    FileInterceptor('asset', {
      limits: { fileSize: maxUploadBytes, files: 1 },
    }),
  )
  async createContent(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: Record<string, string>,
    @UploadedFile() asset?: UploadedAsset,
  ) {
    const actor = await this.requireAdmin(authorization);
    const payload = contentSchema.parse({
      title: body.title,
      contentType: body.contentType,
      category: body.category,
      productName: body.productName || undefined,
      brandId: body.brandId || undefined,
      status: body.status,
      description: body.description,
      metadata: collectMetadata(body),
    });

    const brand = payload.brandId
      ? await this.getBrandOrFail(payload.brandId)
      : null;

    let storagePath: string | null = null;

    if (asset) {
      if (asset.size > maxUploadBytes) {
        throw new BadRequestException(
          'File is larger than the 50 MB upload limit.',
        );
      }

      if (!allowedMimeTypes.has(asset.mimetype)) {
        throw new BadRequestException(
          'Unsupported file type. Upload PDF, PNG, JPG, MP4, CSV, or XLSX files.',
        );
      }

      storagePath = getStoragePath(
        payload.contentType,
        payload.title,
        asset.originalname,
      );

      const { error: uploadError } = await this.supabase.admin.storage
        .from(assetBucket)
        .upload(storagePath, asset.buffer, {
          contentType: asset.mimetype,
          upsert: false,
        });

      if (uploadError) {
        throw new BadRequestException(uploadError.message);
      }
    }

    const { data, error } = await this.supabase.admin
      .from('content_items')
      .insert({
        title: payload.title,
        content_type: payload.contentType,
        category: payload.category,
        product_name: payload.productName ?? brand?.name ?? null,
        brand_id: brand?.id ?? null,
        status: payload.status,
        description: payload.description,
        metadata: payload.metadata,
        storage_bucket: assetBucket,
        storage_path: storagePath,
        created_by: actor.id,
        updated_by: actor.id,
      })
      .select(
        'id,title,content_type,category,status,product_name,brand_id,storage_path,metadata,updated_at',
      )
      .single();

    if (error) {
      throw new BadRequestException(error.message);
    }

    await this.supabase.admin.from('audit_events').insert({
      actor_id: actor.id,
      action: 'content.created',
      entity_type: 'content_items',
      entity_id: data.id,
      metadata: {
        ...payload,
        fileName: asset?.originalname ?? null,
        fileSize: asset?.size ?? null,
        mimeType: asset?.mimetype ?? null,
        storagePath,
      },
    });

    return {
      data,
      message: storagePath
        ? 'Content record and private asset uploaded successfully.'
        : 'Content record saved without an asset.',
    };
  }

  @Patch('content/:id')
  @UseInterceptors(
    FileInterceptor('asset', {
      limits: { fileSize: maxUploadBytes, files: 1 },
    }),
  )
  async updateContent(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: Record<string, string>,
    @UploadedFile() asset?: UploadedAsset,
  ) {
    const actor = await this.requireAdmin(authorization);
    const contentId = contentIdSchema.parse(id);
    const payload = contentSchema.parse({
      title: body.title,
      contentType: body.contentType,
      category: body.category,
      productName: body.productName || undefined,
      brandId: body.brandId || undefined,
      status: body.status,
      description: body.description,
      metadata: collectMetadata(body),
    });

    const brand = payload.brandId
      ? await this.getBrandOrFail(payload.brandId)
      : null;

    const { data: existing, error: existingError } = await this.supabase.admin
      .from('content_items')
      .select('storage_path')
      .eq('id', contentId)
      .single();

    if (existingError) {
      throw new BadRequestException(existingError.message);
    }

    const previousStoragePath = existing.storage_path as string | null;
    let storagePath = previousStoragePath;

    if (asset) {
      if (asset.size > maxUploadBytes) {
        throw new BadRequestException(
          'File is larger than the 50 MB upload limit.',
        );
      }

      if (!allowedMimeTypes.has(asset.mimetype)) {
        throw new BadRequestException(
          'Unsupported file type. Upload PDF, PNG, JPG, MP4, CSV, or XLSX files.',
        );
      }

      storagePath = getStoragePath(
        payload.contentType,
        payload.title,
        asset.originalname,
      );

      const { error: uploadError } = await this.supabase.admin.storage
        .from(assetBucket)
        .upload(storagePath, asset.buffer, {
          contentType: asset.mimetype,
          upsert: false,
        });

      if (uploadError) {
        throw new BadRequestException(uploadError.message);
      }
    }

    const { data, error } = await this.supabase.admin
      .from('content_items')
      .update({
        title: payload.title,
        content_type: payload.contentType,
        category: payload.category,
        product_name: payload.productName ?? brand?.name ?? null,
        brand_id: brand?.id ?? null,
        status: payload.status,
        description: payload.description,
        metadata: payload.metadata,
        storage_path: storagePath,
        updated_by: actor.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contentId)
      .select(
        'id,title,content_type,category,status,product_name,brand_id,storage_path,metadata,updated_at',
      )
      .single();

    if (error) {
      throw new BadRequestException(error.message);
    }

    await this.supabase.admin.from('audit_events').insert({
      actor_id: actor.id,
      action: 'content.updated',
      entity_type: 'content_items',
      entity_id: data.id,
      metadata: {
        ...payload,
        fileReplaced: Boolean(asset),
        fileName: asset?.originalname ?? null,
        fileSize: asset?.size ?? null,
        mimeType: asset?.mimetype ?? null,
        previousStoragePath,
        storagePath,
      },
    });

    return {
      data,
      message: asset
        ? 'Content record updated and asset replaced successfully.'
        : 'Content record updated successfully.',
    };
  }

  @Get('brands')
  async listBrands(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, string>,
  ) {
    await this.requireAdmin(authorization);
    const params = paginationSchema.parse(query);
    const { from, to } = getRange(params.page, params.pageSize);
    const { data, error, count } = await this.supabase.admin
      .from('brands')
      .select(
        'id,name,slug,category,description,logo_path,status,sort_order,updated_at',
        { count: 'exact' },
      )
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .range(from, to);

    if (error) {
      throw error;
    }

    return {
      data: data ?? [],
      meta: getMeta(params.page, params.pageSize, count ?? 0),
    };
  }

  @Get('brands/:id')
  async getBrand(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    await this.requireAdmin(authorization);
    const brandId = brandIdSchema.parse(id);
    const { data, error } = await this.supabase.admin
      .from('brands')
      .select(
        'id,name,slug,category,description,logo_path,status,sort_order,updated_at',
      )
      .eq('id', brandId)
      .maybeSingle();

    if (error) {
      throw new BadRequestException(error.message);
    }

    if (!data) {
      throw new BadRequestException('Brand not found.');
    }

    return { data };
  }

  @Post('brands')
  @UseInterceptors(
    FileInterceptor('logo', {
      limits: { fileSize: maxLogoBytes, files: 1 },
    }),
  )
  async createBrand(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: Record<string, string>,
    @UploadedFile() logo?: UploadedAsset,
  ) {
    const actor = await this.requireAdmin(authorization);
    const payload = brandSchema.parse({
      name: body.name,
      category: body.category,
      description: body.description ?? '',
      status: body.status || 'active',
      sortOrder: body.sortOrder || 0,
    });

    const logoPath = logo
      ? await this.uploadBrandLogo(payload.name, logo)
      : null;

    const { data, error } = await this.supabase.admin
      .from('brands')
      .insert({
        name: payload.name,
        category: payload.category,
        description: payload.description,
        status: payload.status,
        sort_order: payload.sortOrder,
        logo_bucket: assetBucket,
        logo_path: logoPath,
        created_by: actor.id,
        updated_by: actor.id,
      })
      .select(
        'id,name,slug,category,description,logo_path,status,sort_order,updated_at',
      )
      .single();

    if (error) {
      throw new BadRequestException(
        error.code === '23505'
          ? 'A brand with that name already exists.'
          : error.message,
      );
    }

    await this.supabase.admin.from('audit_events').insert({
      actor_id: actor.id,
      action: 'brand.created',
      entity_type: 'brands',
      entity_id: data.id,
      metadata: { ...payload, logoPath },
    });

    return { data, message: `Brand ${payload.name} created.` };
  }

  @Patch('brands/:id')
  @UseInterceptors(
    FileInterceptor('logo', {
      limits: { fileSize: maxLogoBytes, files: 1 },
    }),
  )
  async updateBrand(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: Record<string, string>,
    @UploadedFile() logo?: UploadedAsset,
  ) {
    const actor = await this.requireAdmin(authorization);
    const brandId = brandIdSchema.parse(id);
    const payload = brandSchema.parse({
      name: body.name,
      category: body.category,
      description: body.description ?? '',
      status: body.status || 'active',
      sortOrder: body.sortOrder || 0,
    });

    const { data: existing, error: existingError } = await this.supabase.admin
      .from('brands')
      .select('logo_path')
      .eq('id', brandId)
      .maybeSingle<{ logo_path: string | null }>();

    if (existingError) {
      throw new BadRequestException(existingError.message);
    }

    if (!existing) {
      throw new BadRequestException('Brand not found.');
    }

    const logoPath = logo
      ? await this.uploadBrandLogo(payload.name, logo)
      : existing.logo_path;

    const { data, error } = await this.supabase.admin
      .from('brands')
      .update({
        name: payload.name,
        category: payload.category,
        description: payload.description,
        status: payload.status,
        sort_order: payload.sortOrder,
        logo_path: logoPath,
        updated_by: actor.id,
      })
      .eq('id', brandId)
      .select(
        'id,name,slug,category,description,logo_path,status,sort_order,updated_at',
      )
      .single();

    if (error) {
      throw new BadRequestException(
        error.code === '23505'
          ? 'A brand with that name already exists.'
          : error.message,
      );
    }

    await this.supabase.admin.from('audit_events').insert({
      actor_id: actor.id,
      action: 'brand.updated',
      entity_type: 'brands',
      entity_id: data.id,
      metadata: { ...payload, logoReplaced: Boolean(logo), logoPath },
    });

    return { data, message: `Brand ${payload.name} updated.` };
  }

  @Get('categories')
  async listCategories(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, string>,
  ) {
    await this.requireAdmin(authorization);
    const params = paginationSchema.parse(query);
    const { from, to } = getRange(params.page, params.pageSize);
    const { data, error, count } = await this.supabase.admin
      .from('categories')
      .select('id,name,slug,description,status,sort_order,updated_at', {
        count: 'exact',
      })
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .range(from, to);

    if (error) {
      throw error;
    }

    return {
      data: data ?? [],
      meta: getMeta(params.page, params.pageSize, count ?? 0),
    };
  }

  @Get('categories/:id')
  async getCategory(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    await this.requireAdmin(authorization);
    const categoryId = categoryIdSchema.parse(id);
    const { data, error } = await this.supabase.admin
      .from('categories')
      .select('id,name,slug,description,status,sort_order,updated_at')
      .eq('id', categoryId)
      .maybeSingle();

    if (error) {
      throw new BadRequestException(error.message);
    }

    if (!data) {
      throw new BadRequestException('Category not found.');
    }

    return { data };
  }

  @Post('categories')
  async createCategory(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: Record<string, string>,
  ) {
    const actor = await this.requireAdmin(authorization);
    const payload = categorySchema.parse({
      name: body.name,
      description: body.description ?? '',
      status: body.status || 'active',
      sortOrder: body.sortOrder || 0,
    });

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
      .select('id,name,slug,description,status,sort_order,updated_at')
      .single();

    if (error) {
      throw new BadRequestException(
        error.code === '23505'
          ? 'A category with that name already exists.'
          : error.message,
      );
    }

    await this.supabase.admin.from('audit_events').insert({
      actor_id: actor.id,
      action: 'category.created',
      entity_type: 'categories',
      entity_id: data.id,
      metadata: payload,
    });

    return { data, message: `Category ${payload.name} created.` };
  }

  @Patch('categories/:id')
  async updateCategory(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: Record<string, string>,
  ) {
    const actor = await this.requireAdmin(authorization);
    const categoryId = categoryIdSchema.parse(id);
    const payload = categorySchema.parse({
      name: body.name,
      description: body.description ?? '',
      status: body.status || 'active',
      sortOrder: body.sortOrder || 0,
    });

    const { data: existing, error: existingError } = await this.supabase.admin
      .from('categories')
      .select('name')
      .eq('id', categoryId)
      .maybeSingle<{ name: string }>();

    if (existingError) {
      throw new BadRequestException(existingError.message);
    }

    if (!existing) {
      throw new BadRequestException('Category not found.');
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
      .select('id,name,slug,description,status,sort_order,updated_at')
      .single();

    if (error) {
      throw new BadRequestException(
        error.code === '23505'
          ? 'A category with that name already exists.'
          : error.message,
      );
    }

    // Categories are stored denormalised on content and brands, so a rename
    // has to carry across or those rows would point at a name that is gone.
    if (existing.name !== payload.name) {
      await this.supabase.admin
        .from('content_items')
        .update({ category: payload.name })
        .eq('category', existing.name);

      await this.supabase.admin
        .from('brands')
        .update({ category: payload.name })
        .eq('category', existing.name);
    }

    await this.supabase.admin.from('audit_events').insert({
      actor_id: actor.id,
      action: 'category.updated',
      entity_type: 'categories',
      entity_id: data.id,
      metadata: { ...payload, previousName: existing.name },
    });

    return { data, message: `Category ${payload.name} updated.` };
  }
}
