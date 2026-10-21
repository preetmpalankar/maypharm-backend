import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import { escapeFilter, parseId } from '../common/validation';
import { getMeta, getRange } from '../pagination';
import {
  AssetStorageService,
  type VerifiedUpload,
} from '../storage/asset-storage.service';
import { assetFileName } from '../storage/asset-names';
import { SupabaseService } from '../supabase.service';
import { contentInputSchema, contentListQuerySchema } from './schemas';

export const adminContentColumns =
  'id,title,content_type,category,status,product_name,brand_id,description,storage_bucket,storage_path,file_name,file_size,mime_type,metadata,created_at,updated_at,brand:brands(id,name,slug)';

type StoredFileRow = {
  id: string;
  title: string;
  storage_bucket: string;
  storage_path: string | null;
  file_name: string | null;
};

@Controller('admin/content')
export class AdminContentController {
  constructor(
    private readonly auth: AuthService,
    private readonly supabase: SupabaseService,
    private readonly storage: AssetStorageService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, string>,
  ) {
    await this.auth.requireAdmin(authorization);
    const params = contentListQuerySchema.parse(query);
    const { from, to } = getRange(params.page, params.pageSize);

    let request = this.supabase.admin
      .from('content_items')
      .select(adminContentColumns, { count: 'exact' })
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);

    if (params.status) {
      request = request.eq('status', params.status);
    }

    if (params.type) {
      request = request.eq('content_type', params.type);
    }

    if (params.brandId) {
      request = request.eq('brand_id', params.brandId);
    }

    if (params.q) {
      const term = escapeFilter(params.q);

      if (term) {
        request = request.or(
          `title.ilike.%${term}%,category.ilike.%${term}%,product_name.ilike.%${term}%,file_name.ilike.%${term}%`,
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

  @Get(':id')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    await this.auth.requireAdmin(authorization);
    const { data, error } = await this.supabase.admin
      .from('content_items')
      .select(adminContentColumns)
      .eq('id', parseId(id))
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new NotFoundException('Content record not found.');
    }

    return { data };
  }

  /** Lets admins check a file before publishing; works for every status. */
  @Get(':id/asset')
  async streamAsset(
    @Headers('authorization') authorization: string | undefined,
    @Headers('range') range: string | undefined,
    @Param('id') id: string,
    @Query('download') download: string | undefined,
    @Res() response: Response,
  ) {
    await this.auth.requireAdmin(authorization);
    const item = await this.getStoredFile(parseId(id));

    if (!item.storage_path) {
      throw new NotFoundException('This record has no file attached.');
    }

    await this.storage.pipeTo(response, {
      bucket: item.storage_bucket,
      path: item.storage_path,
      range,
      fileName: assetFileName(item),
      disposition: download === '1' ? 'attachment' : 'inline',
      cacheControl: 'private, no-store',
    });
  }

  @Post()
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const actor = await this.auth.requireAdmin(authorization);
    const payload = contentInputSchema.parse(body);
    const brand = payload.brandId ? await this.getBrand(payload.brandId) : null;
    const file = payload.uploadIntentId
      ? await this.storage.claimUpload(
          actor.id,
          payload.uploadIntentId,
          'content',
        )
      : null;

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
        ...this.fileColumns(file),
        created_by: actor.id,
        updated_by: actor.id,
      })
      .select(adminContentColumns)
      .single<{ id: string }>();

    if (error) {
      // The file was verified but the record never existed: don't orphan it.
      if (file) {
        await this.storage.removeObjects(file.bucket, [file.path]);
      }

      throw error;
    }

    await this.audit.record({
      actorId: actor.id,
      action: 'content.created',
      entityType: 'content_items',
      entityId: data.id,
      metadata: {
        title: payload.title,
        contentType: payload.contentType,
        status: payload.status,
        brandId: brand?.id ?? null,
        file: file
          ? { name: file.fileName, size: file.size, mimeType: file.mimeType }
          : null,
      },
    });

    return {
      data,
      message:
        payload.status === 'approved'
          ? 'Content saved and published to MayPharm.'
          : 'Content saved. Set the status to approved when it is ready to publish.',
    };
  }

  @Patch(':id')
  async update(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.auth.requireAdmin(authorization);
    const contentId = parseId(id);
    const payload = contentInputSchema.parse(body);
    const existing = await this.getStoredFile(contentId);
    const brand = payload.brandId ? await this.getBrand(payload.brandId) : null;

    if (payload.uploadIntentId && payload.removeFile) {
      throw new BadRequestException(
        'Choose either a replacement file or removal, not both.',
      );
    }

    const file = payload.uploadIntentId
      ? await this.storage.claimUpload(
          actor.id,
          payload.uploadIntentId,
          'content',
        )
      : null;
    const fileChange = file
      ? this.fileColumns(file)
      : payload.removeFile
        ? this.fileColumns(null)
        : {};

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
        ...fileChange,
        updated_by: actor.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contentId)
      .select(adminContentColumns)
      .single<{ id: string }>();

    if (error) {
      if (file) {
        await this.storage.removeObjects(file.bucket, [file.path]);
      }

      throw error;
    }

    // Only once the record points at the new file is the old one released.
    if ((file || payload.removeFile) && existing.storage_path) {
      await this.storage.removeObjects(existing.storage_bucket, [
        existing.storage_path,
      ]);
    }

    await this.audit.record({
      actorId: actor.id,
      action: 'content.updated',
      entityType: 'content_items',
      entityId: data.id,
      metadata: {
        title: payload.title,
        contentType: payload.contentType,
        status: payload.status,
        brandId: brand?.id ?? null,
        fileReplaced: Boolean(file),
        fileRemoved: payload.removeFile && !file,
        file: file
          ? { name: file.fileName, size: file.size, mimeType: file.mimeType }
          : undefined,
      },
    });

    return {
      data,
      message: file
        ? 'Content updated and file replaced.'
        : payload.removeFile
          ? 'Content updated and file removed.'
          : 'Content updated.',
    };
  }

  @Delete(':id')
  async remove(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const actor = await this.auth.requireAdmin(authorization);
    const contentId = parseId(id);
    const existing = await this.getStoredFile(contentId);

    const { error } = await this.supabase.admin
      .from('content_items')
      .delete()
      .eq('id', contentId);

    if (error) {
      throw error;
    }

    await this.storage.removeObjects(existing.storage_bucket, [
      existing.storage_path,
    ]);
    await this.audit.record({
      actorId: actor.id,
      action: 'content.deleted',
      entityType: 'content_items',
      entityId: contentId,
      metadata: { title: existing.title, fileName: existing.file_name },
    });

    return { message: `Deleted “${existing.title}”.` };
  }

  private fileColumns(file: VerifiedUpload | null) {
    return {
      storage_bucket: file?.bucket ?? this.storage.bucket,
      storage_path: file?.path ?? null,
      file_name: file?.fileName ?? null,
      file_size: file?.size ?? null,
      mime_type: file?.mimeType ?? null,
    };
  }

  private async getStoredFile(contentId: string) {
    const { data, error } = await this.supabase.admin
      .from('content_items')
      .select('id,title,storage_bucket,storage_path,file_name')
      .eq('id', contentId)
      .maybeSingle<StoredFileRow>();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new NotFoundException('Content record not found.');
    }

    return data;
  }

  private async getBrand(brandId: string) {
    const { data, error } = await this.supabase.admin
      .from('brands')
      .select('id,name')
      .eq('id', brandId)
      .maybeSingle<{ id: string; name: string }>();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new BadRequestException(
        'The selected brand folder no longer exists.',
      );
    }

    return data;
  }
}
