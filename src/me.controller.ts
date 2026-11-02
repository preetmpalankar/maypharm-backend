import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  NotFoundException,
  PayloadTooLargeException,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { AuthService } from './auth/auth.service';
import { AssetStorageService } from './storage/asset-storage.service';
import { matchesSignature } from './storage/file-policy';
import { SupabaseService } from './supabase.service';

const maxAvatarBytes = 2 * 1024 * 1024;
const avatarTypes: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** The signed-in person's own profile picture. */
@Controller('me')
export class MeController {
  constructor(
    private readonly auth: AuthService,
    private readonly supabase: SupabaseService,
    private readonly storage: AssetStorageService,
  ) {}

  @Get('avatar')
  async streamAvatar(
    @Headers('authorization') authorization: string | undefined,
    @Res() response: Response,
  ) {
    const me = await this.auth.requireMember(authorization);
    const path = await this.avatarPath(me.id);

    if (!path) {
      throw new NotFoundException('No profile picture.');
    }

    await this.storage.pipeTo(response, {
      bucket: this.storage.bucket,
      path,
      fileName: path.split('/').pop() ?? 'avatar',
      disposition: 'inline',
      cacheControl: 'private, max-age=300',
    });
  }

  /** Replaces the picture with the image in the request body (JPEG, PNG or WEBP, up to 2 MB). */
  @Put('avatar')
  async uploadAvatar(
    @Headers('authorization') authorization: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: Request,
  ) {
    const me = await this.auth.requireMember(authorization);
    const mime = (contentType ?? '').split(';')[0].trim().toLowerCase();
    const extension = avatarTypes[mime];
    const body: unknown = request.body;

    if (!extension || !Buffer.isBuffer(body) || body.length === 0) {
      throw new BadRequestException('Upload a JPEG, PNG or WEBP image.');
    }
    if (body.length > maxAvatarBytes) {
      throw new PayloadTooLargeException(
        'Profile pictures must be 2 MB or smaller.',
      );
    }
    // Trust the bytes, not the header.
    if (!matchesSignature(extension, new Uint8Array(body))) {
      throw new BadRequestException('This file is not a valid image.');
    }

    const previous = await this.avatarPath(me.id);
    const path = `avatars/${me.id}-${randomUUID()}.${extension}`;
    const { error: uploadError } = await this.supabase.admin.storage
      .from(this.storage.bucket)
      .upload(path, body, { contentType: mime });
    if (uploadError) throw uploadError;

    const { error } = await this.supabase.admin
      .from('admin_profiles')
      .update({ avatar_path: path })
      .eq('id', me.id);
    if (error) {
      await this.storage.removeObjects(this.storage.bucket, [path]);
      throw error;
    }

    await this.storage.removeObjects(this.storage.bucket, [previous]);
    return { data: { avatar_path: path } };
  }

  private async avatarPath(userId: string) {
    const { data, error } = await this.supabase.admin
      .from('admin_profiles')
      .select('avatar_path')
      .eq('id', userId)
      .maybeSingle<{ avatar_path: string | null }>();
    if (error) throw error;
    return data?.avatar_path ?? null;
  }
}
