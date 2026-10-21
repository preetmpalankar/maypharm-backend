import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from '../auth/auth.service';
import { AssetStorageService } from '../storage/asset-storage.service';
import { uploadPolicies } from '../storage/file-policy';
import { uploadSlotSchema } from './schemas';

@Controller('admin/uploads')
export class AdminUploadsController {
  constructor(
    private readonly auth: AuthService,
    private readonly storage: AssetStorageService,
  ) {}

  /**
   * Step one of an upload: validates name, type and size, then returns a
   * signed URL the browser PUTs the file to directly. The file is attached to
   * a record later by passing `intentId` to the content or brand endpoints.
   */
  @Post()
  @HttpCode(201)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async createUploadSlot(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const actor = await this.auth.requireAdmin(authorization);
    const payload = uploadSlotSchema.parse(body);
    const folder = payload.kind === 'logo' ? 'brands' : payload.contentType!;

    const slot = await this.storage.createUploadSlot(actor.id, {
      kind: payload.kind,
      fileName: payload.fileName,
      fileSize: payload.fileSize,
      folder,
    });

    return {
      data: {
        ...slot,
        maxBytes: uploadPolicies[payload.kind].maxBytes,
      },
    };
  }
}
