import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Response } from 'express';
import { SupabaseService } from '../supabase.service';
import { toSafeSlug } from '../common/validation';
import {
  assertWithinSizeLimit,
  getExtension,
  matchesSignature,
  resolveFileType,
  sanitizeDisplayName,
  signatureSampleBytes,
  type UploadKind,
} from './file-policy';

/** Supabase signed upload URLs are valid for two hours. */
const uploadWindowMs = 2 * 60 * 60 * 1000;
/** Unclaimed uploads are kept this long before the sweeper removes them. */
const abandonAfterMs = 24 * 60 * 60 * 1000;

type UploadIntentRow = {
  id: string;
  bucket: string;
  path: string;
  kind: UploadKind;
  file_name: string;
  declared_size: number;
  mime_type: string;
  created_by: string;
  created_at: string;
  consumed_at: string | null;
};

export type UploadSlot = {
  intentId: string;
  path: string;
  signedUrl: string;
  /**
   * For resumable (TUS) uploads, which every file over a few MB should use
   * and anything over 5 GB must: send `token` as the `x-signature` header to
   * `resumableEndpoint`, with `bucket` and `path` as the object metadata.
   */
  token: string;
  bucket: string;
  resumableEndpoint: string;
  mimeType: string;
  expiresAt: string;
};

export type VerifiedUpload = {
  bucket: string;
  path: string;
  fileName: string;
  size: number;
  mimeType: string;
};

/** Tells the browser to discard this upload and send the file again. */
function uploadRejected(
  Exception:
    | typeof BadRequestException
    | typeof ConflictException
    | typeof ForbiddenException,
  message: string,
) {
  return new Exception({ message, code: 'upload_invalid' });
}

export type StreamOptions = {
  bucket: string;
  path: string;
  range?: string;
  fileName: string;
  disposition: 'inline' | 'attachment';
  cacheControl: string;
};

/**
 * Builds a Content-Disposition value that survives any file name: an ASCII
 * fallback for old clients plus the RFC 5987 UTF-8 form.
 */
export function contentDisposition(
  disposition: 'inline' | 'attachment',
  fileName: string,
) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Supabase's resumable (TUS) endpoint for uploads authorised by a signed
 * upload token (sent as `x-signature`). Signed uploads have their own route,
 * `/upload/resumable/sign`; the plain `/upload/resumable` route expects a
 * user's bearer token and rejects them.
 */
export function resumableEndpoint(projectUrl: string) {
  return `${new URL(projectUrl).origin}/storage/v1/upload/resumable/sign`;
}

@Injectable()
export class AssetStorageService {
  private readonly logger = new Logger('AssetStorage');

  constructor(private readonly supabase: SupabaseService) {}

  get bucket() {
    return this.supabase.bucket;
  }

  /**
   * Validates a file before a single byte is sent, then issues a signed URL
   * the browser uploads to directly and records the intent.
   */
  async createUploadSlot(
    actorId: string,
    input: {
      kind: UploadKind;
      fileName: string;
      fileSize: number;
      folder: string;
    },
  ): Promise<UploadSlot> {
    const fileName = sanitizeDisplayName(input.fileName);
    const type = resolveFileType(fileName, input.kind);
    assertWithinSizeLimit(input.fileSize, input.kind);

    const stem = fileName.replace(/\.[^.]+$/, '');
    const path = `${input.folder}/${randomUUID()}-${toSafeSlug(stem)}.${type.extension}`;
    const expiresAt = new Date(Date.now() + uploadWindowMs).toISOString();

    // upsert lets the browser retry an interrupted upload against the same URL.
    const { data, error } = await this.supabase.admin.storage
      .from(this.bucket)
      .createSignedUploadUrl(path, { upsert: true });

    if (error || !data?.signedUrl) {
      this.logger.error(
        `Could not sign upload for ${path}: ${error?.message ?? 'no URL returned'}`,
      );
      throw new ServiceUnavailableException(
        'File storage is temporarily unavailable. Please try again.',
      );
    }

    const { data: intent, error: intentError } = await this.supabase.admin
      .from('upload_intents')
      .insert({
        bucket: this.bucket,
        path,
        kind: input.kind,
        file_name: fileName,
        declared_size: Math.round(input.fileSize),
        mime_type: type.mime,
        created_by: actorId,
        expires_at: expiresAt,
      })
      .select('id')
      .single<{ id: string }>();

    if (intentError) {
      throw intentError;
    }

    return {
      intentId: intent.id,
      path,
      signedUrl: data.signedUrl,
      token: data.token,
      bucket: this.bucket,
      resumableEndpoint: resumableEndpoint(this.supabase.url),
      mimeType: type.mime,
      expiresAt,
    };
  }

  /**
   * Confirms an uploaded object really is what it claims to be, then claims
   * the intent so it can be attached to exactly one record. Rejected files are
   * deleted on the spot.
   */
  async claimUpload(
    actorId: string,
    intentId: string,
    kind: UploadKind,
  ): Promise<VerifiedUpload> {
    const { data: intent, error } = await this.supabase.admin
      .from('upload_intents')
      .select('*')
      .eq('id', intentId)
      .maybeSingle<UploadIntentRow>();

    if (error) {
      throw error;
    }

    if (!intent || intent.kind !== kind) {
      throw uploadRejected(
        BadRequestException,
        'This upload could not be found. Please choose the file again.',
      );
    }

    if (intent.created_by !== actorId) {
      throw uploadRejected(
        ForbiddenException,
        'This upload belongs to another administrator.',
      );
    }

    if (intent.consumed_at) {
      throw uploadRejected(
        ConflictException,
        'This upload is already attached to a record. Please choose the file again.',
      );
    }

    if (
      Date.now() - new Date(intent.created_at).getTime() >
      abandonAfterMs - uploadWindowMs
    ) {
      throw uploadRejected(
        BadRequestException,
        'This upload has expired. Please choose the file again.',
      );
    }

    const probe = await this.probe(intent.bucket, intent.path);

    if (!probe) {
      throw uploadRejected(
        BadRequestException,
        'The file did not finish uploading. Please upload it again.',
      );
    }

    try {
      assertWithinSizeLimit(probe.size, kind);

      if (!matchesSignature(getExtension(intent.path), probe.sample)) {
        const type = resolveFileType(intent.path, kind);
        throw uploadRejected(
          BadRequestException,
          `This file's contents do not look like a ${type.label}. Check that you selected the right file.`,
        );
      }
    } catch (rejection) {
      // The object is deleted, so whatever the reason the browser must not
      // reuse this upload: tag every rejection, keeping its status and text.
      await this.removeObjects(intent.bucket, [intent.path]);

      if (rejection instanceof HttpException) {
        const response = rejection.getResponse();
        const message =
          typeof response === 'string'
            ? response
            : ((response as { message?: string }).message ?? rejection.message);
        throw new HttpException(
          { message, code: 'upload_invalid' },
          rejection.getStatus(),
        );
      }

      throw rejection;
    }

    // Claim atomically: concurrent submits of the same upload cannot both win.
    const { data: claimed, error: claimError } = await this.supabase.admin
      .from('upload_intents')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', intent.id)
      .is('consumed_at', null)
      .select('id')
      .maybeSingle<{ id: string }>();

    if (claimError) {
      throw claimError;
    }

    if (!claimed) {
      throw uploadRejected(
        ConflictException,
        'This upload is already attached to a record. Please choose the file again.',
      );
    }

    return {
      bucket: intent.bucket,
      path: intent.path,
      fileName: intent.file_name,
      size: probe.size,
      mimeType: intent.mime_type,
    };
  }

  /** Best-effort delete; storage hiccups are logged, never surfaced. */
  async removeObjects(bucket: string, paths: (string | null | undefined)[]) {
    const targets = paths.filter((path): path is string => Boolean(path));

    if (targets.length === 0) {
      return;
    }

    const { error } = await this.supabase.admin.storage
      .from(bucket)
      .remove(targets);

    if (error) {
      this.logger.warn(
        `Could not remove ${targets.join(', ')} from ${bucket}: ${error.message}`,
      );
    }
  }

  /**
   * Streams an object to the client without buffering it, forwarding Range
   * requests so video seeking works. Takes over the response entirely: Nest's
   * StreamableFile path would reset a 206 to 200, which Safari will not play.
   */
  async pipeTo(response: Response, options: StreamOptions) {
    const signedUrl = await this.signDownload(options.bucket, options.path);
    const upstream = await fetch(signedUrl, {
      headers: options.range ? { Range: options.range } : undefined,
    });

    if (upstream.status === 416) {
      response.status(416);
      response.setHeader(
        'Content-Range',
        upstream.headers.get('content-range') ?? 'bytes */*',
      );
      response.end();
      return;
    }

    if (!upstream.ok || !upstream.body) {
      throw new NotFoundException('Asset not available.');
    }

    response.status(upstream.status);
    response.set({
      'Content-Type':
        upstream.headers.get('content-type') ?? 'application/octet-stream',
      'Content-Disposition': contentDisposition(
        options.disposition,
        options.fileName,
      ),
      'Cache-Control': options.cacheControl,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    });

    for (const header of [
      'content-length',
      'content-range',
      'etag',
      'last-modified',
    ]) {
      const value = upstream.headers.get(header);

      if (value) {
        response.setHeader(header, value);
      }
    }

    try {
      await pipeline(
        Readable.fromWeb(
          upstream.body as unknown as WebReadableStream<Uint8Array>,
        ),
        response,
      );
    } catch (error) {
      // Viewers closing a tab or seeking a video abort mid-stream constantly.
      const code = (error as NodeJS.ErrnoException).code;

      if (code !== 'ERR_STREAM_PREMATURE_CLOSE' && code !== 'ECONNRESET') {
        this.logger.warn(
          `Stream of ${options.path} failed: ${(error as Error).message}`,
        );
      }
    }
  }

  /** Removes uploads that were issued but never attached to a record. */
  async sweepAbandonedUploads() {
    const cutoff = new Date(Date.now() - abandonAfterMs).toISOString();
    const { data, error } = await this.supabase.admin
      .from('upload_intents')
      .select('id,bucket,path')
      .is('consumed_at', null)
      .lt('created_at', cutoff)
      .limit(200)
      .returns<Pick<UploadIntentRow, 'id' | 'bucket' | 'path'>[]>();

    if (error) {
      this.logger.warn(`Upload sweep skipped: ${error.message}`);
      return 0;
    }

    const intents = data ?? [];

    if (intents.length === 0) {
      return 0;
    }

    const byBucket = new Map<string, string[]>();

    for (const intent of intents) {
      byBucket.set(intent.bucket, [
        ...(byBucket.get(intent.bucket) ?? []),
        intent.path,
      ]);
    }

    for (const [bucket, paths] of byBucket) {
      await this.removeObjects(bucket, paths);
    }

    await this.supabase.admin
      .from('upload_intents')
      .delete()
      .in(
        'id',
        intents.map((intent) => intent.id),
      );

    this.logger.log(`Swept ${intents.length} abandoned upload(s).`);
    return intents.length;
  }

  private async signDownload(bucket: string, path: string) {
    const { data, error } = await this.supabase.admin.storage
      .from(bucket)
      .createSignedUrl(path, 60);

    if (error || !data?.signedUrl) {
      throw new NotFoundException('Asset not available.');
    }

    return data.signedUrl;
  }

  /**
   * Reads just the leading bytes of an object: enough to sniff its type, with
   * the total size taken from Content-Range. Returns null if it is missing.
   */
  private async probe(bucket: string, path: string) {
    const { data, error } = await this.supabase.admin.storage
      .from(bucket)
      .createSignedUrl(path, 60);

    if (error || !data?.signedUrl) {
      return null;
    }

    const response = await fetch(data.signedUrl, {
      headers: { Range: `bytes=0-${signatureSampleBytes - 1}` },
    });

    if (response.status === 400 || response.status === 404) {
      return null;
    }

    if (!response.ok || !response.body) {
      throw new ServiceUnavailableException(
        'File storage is temporarily unavailable. Please try again.',
      );
    }

    const totalFromRange = Number(
      response.headers.get('content-range')?.split('/')[1],
    );
    const size = Number.isFinite(totalFromRange)
      ? totalFromRange
      : Number(response.headers.get('content-length') ?? 0);

    // If Range is ignored the body is the whole file: stop after the sample.
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body.getReader();

    while (received < signatureSampleBytes) {
      const { done, value } = await reader.read();

      if (done || !value) {
        break;
      }

      chunks.push(value);
      received += value.length;
    }

    await reader.cancel().catch(() => undefined);

    const sample = new Uint8Array(Math.min(received, signatureSampleBytes));
    let offset = 0;

    for (const chunk of chunks) {
      const slice = chunk.subarray(0, sample.length - offset);
      sample.set(slice, offset);
      offset += slice.length;

      if (offset >= sample.length) {
        break;
      }
    }

    return { size, sample };
  }
}
