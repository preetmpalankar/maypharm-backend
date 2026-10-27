import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase.service';
import {
  AssetStorageService,
  type VerifiedUpload,
} from './asset-storage.service';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Most files one content item can carry. */
export const maxFilesPerItem = 20;

export type ContentFile = {
  id: string;
  content_id: string;
  position: number;
  storage_bucket: string;
  storage_path: string;
  file_name: string;
  file_size: number | null;
  mime_type: string | null;
};

const fileColumns =
  'id,content_id,position,storage_bucket,storage_path,file_name,file_size,mime_type';

/**
 * The files attached to content items. content_items keeps mirroring the
 * first file in its own file columns, so everything that shows one file per
 * item (lists, thumbnails, older app versions) stays correct.
 */
@Injectable()
export class ContentFilesService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly storage: AssetStorageService,
  ) {}

  /** Files of each item, in order. */
  async listFor(contentIds: string[]) {
    const byItem = new Map<string, ContentFile[]>();
    if (contentIds.length === 0) return byItem;

    const { data, error } = await this.supabase.admin
      .from('content_files')
      .select(fileColumns)
      .in('content_id', contentIds)
      .order('position')
      .order('created_at')
      .returns<ContentFile[]>();
    if (error) throw error;

    for (const file of data ?? []) {
      byItem.set(file.content_id, [
        ...(byItem.get(file.content_id) ?? []),
        file,
      ]);
    }
    return byItem;
  }

  async list(contentId: string) {
    return (await this.listFor([contentId])).get(contentId) ?? [];
  }

  /** Adds the `files` array to each record. */
  async withFiles<T extends { id: string }>(items: T[]) {
    const files = await this.listFor(items.map((item) => item.id));
    return items.map((item) => ({
      ...item,
      files: (files.get(item.id) ?? []).map(publicFile),
    }));
  }

  /**
   * Verifies and claims every upload, in order. If one is rejected, the ones
   * already claimed are deleted again so nothing is left orphaned.
   */
  async claimAll(actorId: string, intentIds: string[]) {
    const claimed: VerifiedUpload[] = [];

    try {
      for (const intentId of intentIds) {
        claimed.push(
          await this.storage.claimUpload(actorId, intentId, 'content'),
        );
      }
    } catch (error) {
      await this.discard(claimed);
      throw error;
    }

    return claimed;
  }

  /** Deletes uploaded objects that never made it onto a record. */
  async discard(files: VerifiedUpload[]) {
    for (const file of files) {
      await this.storage.removeObjects(file.bucket, [file.path]);
    }
  }

  /** Appends verified uploads to an item after its existing files. */
  async attach(
    contentId: string,
    files: VerifiedUpload[],
    startAt: number,
    actorId: string,
  ) {
    if (files.length === 0) return;

    const { error } = await this.supabase.admin.from('content_files').insert(
      files.map((file, index) => ({
        content_id: contentId,
        position: startAt + index,
        storage_bucket: file.bucket,
        storage_path: file.path,
        file_name: file.fileName,
        file_size: file.size,
        mime_type: file.mimeType,
        created_by: actorId,
      })),
    );
    if (error) throw error;
  }

  /** Removes the given files from an item (rows first, then the stored objects). */
  async detach(files: ContentFile[]) {
    if (files.length === 0) return;

    const { error } = await this.supabase.admin
      .from('content_files')
      .delete()
      .in(
        'id',
        files.map((file) => file.id),
      );
    if (error) throw error;

    for (const file of files) {
      await this.storage.removeObjects(file.storage_bucket, [
        file.storage_path,
      ]);
    }
  }

  /** Renumbers an item's files 0..n-1 and mirrors the first one onto the item. */
  async syncPrimary(contentId: string) {
    const files = await this.list(contentId);

    for (const [index, file] of files.entries()) {
      if (file.position === index) continue;
      const { error } = await this.supabase.admin
        .from('content_files')
        .update({ position: index })
        .eq('id', file.id);
      if (error) throw error;
    }

    const first = files[0];
    const { error } = await this.supabase.admin
      .from('content_items')
      .update({
        storage_bucket: first?.storage_bucket ?? this.storage.bucket,
        storage_path: first?.storage_path ?? null,
        file_name: first?.file_name ?? null,
        file_size: first?.file_size ?? null,
        mime_type: first?.mime_type ?? null,
        // A new version for the knowledge index whenever the files change.
        updated_at: new Date().toISOString(),
      })
      .eq('id', contentId);
    if (error) throw error;

    return files;
  }

  /**
   * The file to stream: the one asked for, or the item's first file. Throws
   * a 404 when the item has none (or the id belongs to another item).
   */
  async resolve(contentId: string, fileId: string | undefined) {
    if (fileId !== undefined && !uuidPattern.test(fileId)) {
      throw new BadRequestException('Invalid file reference.');
    }

    const files = await this.list(contentId);
    const file = fileId
      ? files.find((candidate) => candidate.id === fileId)
      : files[0];

    if (!file) {
      throw new NotFoundException('This file is not available.');
    }
    return file;
  }
}

/** What clients see of a file: no bucket internals beyond what items already expose. */
export function publicFile(file: ContentFile) {
  return {
    id: file.id,
    position: file.position,
    storage_path: file.storage_path,
    file_name: file.file_name,
    file_size: file.file_size,
    mime_type: file.mime_type,
  };
}
