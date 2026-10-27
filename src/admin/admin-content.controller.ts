import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
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
import { AssetStorageService } from '../storage/asset-storage.service';
import {
  ContentFilesService,
  maxFilesPerItem,
} from '../storage/content-files.service';
import { assetFileName, titleFromFileName } from '../storage/asset-names';
import { SupabaseService } from '../supabase.service';
import { contentInputSchema, contentListQuerySchema } from './schemas';

export const adminContentColumns =
  'id,title,content_type,category,status,product_name,brand_id,description,storage_bucket,storage_path,file_name,file_size,mime_type,metadata,custom_fields,ai_ingestion,created_at,updated_at,brand:brands(id,name,slug)';

type StoredItemRow = { id: string; title: string };

@Controller('admin/content')
export class AdminContentController {
  constructor(
    private readonly auth: AuthService,
    private readonly supabase: SupabaseService,
    private readonly storage: AssetStorageService,
    private readonly files: ContentFilesService,
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
      data: await this.files.withFiles(data ?? []),
      meta: getMeta(params.page, params.pageSize, count ?? 0),
    };
  }

  @Get(':id')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    await this.auth.requireAdmin(authorization);
    return { data: await this.load(parseId(id)) };
  }

  /**
   * Lets admins check a file before publishing; works for every status.
   * `?file=<id>` picks one of the item's files (default: the first).
   */
  @Get(':id/asset')
  async streamAsset(
    @Headers('authorization') authorization: string | undefined,
    @Headers('range') range: string | undefined,
    @Param('id') id: string,
    @Query('file') fileId: string | undefined,
    @Query('download') download: string | undefined,
    @Res() response: Response,
  ) {
    await this.auth.requireAdmin(authorization);
    const contentId = parseId(id);
    const item = await this.getStoredItem(contentId);
    const file = await this.files.resolve(contentId, fileId);

    await this.storage.pipeTo(response, {
      bucket: file.storage_bucket,
      path: file.storage_path,
      range,
      fileName: assetFileName({ title: item.title, ...file }),
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
    const brand = await this.getBrand(payload.brandId);

    if (payload.uploadIntentIds.length === 0) {
      throw new BadRequestException('Attach at least one file.');
    }

    if (payload.uploadIntentIds.length > maxFilesPerItem) {
      throw new BadRequestException(
        `Attach at most ${maxFilesPerItem} files to one item.`,
      );
    }

    const uploads = await this.files.claimAll(
      actor.id,
      payload.uploadIntentIds,
    );
    // No title given: name it after its first file.
    const title = payload.title || titleFromFileName(uploads[0].fileName);

    const { data, error } = await this.supabase.admin
      .from('content_items')
      .insert({
        title,
        content_type: payload.contentType,
        category: payload.category,
        product_name: payload.productName ?? brand.name,
        brand_id: brand.id,
        status: payload.status,
        description: payload.description,
        metadata: payload.metadata,
        custom_fields: payload.customFields,
        ai_ingestion: payload.aiIngestion,
        created_by: actor.id,
        updated_by: actor.id,
      })
      .select('id')
      .single<{ id: string }>();

    if (error) {
      // The files were verified but the record never existed: don't orphan them.
      await this.files.discard(uploads);
      throw error;
    }

    try {
      await this.files.attach(data.id, uploads, 0, actor.id);
      await this.files.syncPrimary(data.id);
    } catch (attachError) {
      await this.supabase.admin
        .from('content_items')
        .delete()
        .eq('id', data.id);
      await this.files.discard(uploads);
      throw attachError;
    }

    await this.audit.record({
      actorId: actor.id,
      action: 'content.created',
      entityType: 'content_items',
      entityId: data.id,
      metadata: {
        title,
        contentType: payload.contentType,
        status: payload.status,
        aiIngestion: payload.aiIngestion,
        brandId: brand.id,
        files: uploads.map((file) => ({
          name: file.fileName,
          size: file.size,
          mimeType: file.mimeType,
        })),
      },
    });

    return {
      data: await this.load(data.id),
      message:
        payload.status === 'approved'
          ? 'Content saved and published to MayPharm.'
          : 'Content saved. Set the status to approved when it is ready to publish.',
    };
  }

  /**
   * Checks a new item's details without saving anything, so the admin
   * portal can queue it for a background upload knowing the save will pass.
   */
  @Post('validate')
  @HttpCode(200)
  async validate(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    await this.auth.requireAdmin(authorization);
    const payload = contentInputSchema.parse(body);

    await this.getBrand(payload.brandId);

    return { ok: true };
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
    const existing = await this.getStoredItem(contentId);
    const brand = await this.getBrand(payload.brandId);
    const title = payload.title || existing.title;

    const current = await this.files.list(contentId);
    const removing = current.filter((file) =>
      payload.removeFileIds.includes(file.id),
    );

    const remaining =
      current.length - removing.length + payload.uploadIntentIds.length;

    if (remaining === 0) {
      throw new BadRequestException('Keep at least one file.');
    }

    if (remaining > maxFilesPerItem) {
      throw new BadRequestException(
        `Attach at most ${maxFilesPerItem} files to one item.`,
      );
    }

    const uploads = await this.files.claimAll(
      actor.id,
      payload.uploadIntentIds,
    );

    try {
      await this.files.attach(contentId, uploads, current.length, actor.id);
    } catch (attachError) {
      await this.files.discard(uploads);
      throw attachError;
    }

    // Only once the new files are on the record are removed ones released.
    await this.files.detach(removing);
    await this.files.syncPrimary(contentId);

    const { error } = await this.supabase.admin
      .from('content_items')
      .update({
        title,
        content_type: payload.contentType,
        category: payload.category,
        product_name: payload.productName ?? brand.name,
        brand_id: brand.id,
        status: payload.status,
        description: payload.description,
        metadata: payload.metadata,
        custom_fields: payload.customFields,
        ai_ingestion: payload.aiIngestion,
        updated_by: actor.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contentId);

    if (error) {
      throw error;
    }

    await this.audit.record({
      actorId: actor.id,
      action: 'content.updated',
      entityType: 'content_items',
      entityId: contentId,
      metadata: {
        title,
        contentType: payload.contentType,
        status: payload.status,
        aiIngestion: payload.aiIngestion,
        brandId: brand.id,
        filesAdded: uploads.map((file) => ({
          name: file.fileName,
          size: file.size,
          mimeType: file.mimeType,
        })),
        filesRemoved: removing.map((file) => file.file_name),
      },
    });

    const changes = [
      uploads.length > 0 &&
        `${uploads.length} file${uploads.length === 1 ? '' : 's'} added`,
      removing.length > 0 &&
        `${removing.length} file${removing.length === 1 ? '' : 's'} removed`,
    ].filter(Boolean);

    return {
      data: await this.load(contentId),
      message: changes.length
        ? `Content updated: ${changes.join(', ')}.`
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
    const existing = await this.getStoredItem(contentId);
    const files = await this.files.list(contentId);

    const { error } = await this.supabase.admin
      .from('content_items')
      .delete()
      .eq('id', contentId);

    if (error) {
      throw error;
    }

    // The rows went with the item (cascade); release the stored objects.
    for (const file of files) {
      await this.storage.removeObjects(file.storage_bucket, [
        file.storage_path,
      ]);
    }

    await this.audit.record({
      actorId: actor.id,
      action: 'content.deleted',
      entityType: 'content_items',
      entityId: contentId,
      metadata: {
        title: existing.title,
        files: files.map((file) => file.file_name),
      },
    });

    return { message: `Deleted “${existing.title}”.` };
  }

  /** One item with its files, as the admin portal shows it. */
  private async load(contentId: string) {
    const { data, error } = await this.supabase.admin
      .from('content_items')
      .select(adminContentColumns)
      .eq('id', contentId)
      .maybeSingle<{ id: string }>();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new NotFoundException('Content record not found.');
    }

    const [withFiles] = await this.files.withFiles([data]);
    return withFiles;
  }

  private async getStoredItem(contentId: string) {
    const { data, error } = await this.supabase.admin
      .from('content_items')
      .select('id,title')
      .eq('id', contentId)
      .maybeSingle<StoredItemRow>();

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
