import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthService } from './auth/auth.service';
import { MeController } from './me.controller';
import type { AssetStorageService } from './storage/asset-storage.service';
import type { SupabaseService } from './supabase.service';

const auth = {
  requireMember: () => Promise.resolve({ id: 'user-1', role: 'sales' }),
} as unknown as AuthService;
const controller = new MeController(
  auth,
  {} as SupabaseService,
  {} as AssetStorageService,
);
const upload = (type: string, body: unknown) =>
  controller.uploadAvatar('Bearer x', type, { body } as Request);

describe('profile pictures', () => {
  it('refuses anything that is not a JPEG, PNG or WEBP', async () => {
    await expect(
      upload('application/pdf', Buffer.from('%PDF-1.4')),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(upload('image/png', undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('checks the bytes, not just the header', async () => {
    await expect(
      upload('image/png', Buffer.from('definitely not a png')),
    ).rejects.toThrow('This file is not a valid image.');
  });

  it('refuses images over 2 MB', async () => {
    await expect(
      upload('image/jpeg', Buffer.alloc(2 * 1024 * 1024 + 1)),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });
});
