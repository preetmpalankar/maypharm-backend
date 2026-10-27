import { BadRequestException } from '@nestjs/common';
import {
  resumableEndpoint,
  type AssetStorageService,
  type VerifiedUpload,
} from './asset-storage.service';
import { ContentFilesService } from './content-files.service';
import type { SupabaseService } from '../supabase.service';

const upload = (name: string): VerifiedUpload => ({
  bucket: 'maypharm-admin-assets',
  path: `media/${name}`,
  fileName: name,
  size: 10,
  mimeType: 'video/mp4',
});

describe('content files', () => {
  it('deletes the uploads it already claimed when a later one is rejected', async () => {
    const removed: string[] = [];
    const claimUpload = jest.fn((_actor: string, intentId: string) =>
      intentId === 'bad'
        ? Promise.reject(new BadRequestException('not a video'))
        : Promise.resolve(upload(`${intentId}.mp4`)),
    );
    const storage = {
      claimUpload,
      removeObjects: jest.fn((_bucket: string, paths: string[]) => {
        removed.push(...paths);
        return Promise.resolve();
      }),
    } as unknown as AssetStorageService;
    const files = new ContentFilesService({} as SupabaseService, storage);

    await expect(
      files.claimAll('admin', ['a', 'b', 'bad', 'c']),
    ).rejects.toThrow('not a video');
    expect(removed).toEqual(['media/a.mp4', 'media/b.mp4']);
    expect(claimUpload).toHaveBeenCalledTimes(3);
  });

  it('rejects a malformed file reference before touching the database', async () => {
    const files = new ContentFilesService(
      {} as SupabaseService,
      {} as AssetStorageService,
    );
    await expect(
      files.resolve('7c1d4a52-2f6e-4f0b-9a37-1b2a3c4d5e6f', '../etc'),
    ).rejects.toThrow('Invalid file reference.');
  });

  it('uploads large files to the direct storage host', () => {
    expect(resumableEndpoint('https://sjdmyzreeorswiurnvze.supabase.co')).toBe(
      'https://sjdmyzreeorswiurnvze.storage.supabase.co/storage/v1/upload/resumable',
    );
    expect(resumableEndpoint('https://db.example.com')).toBe(
      'https://db.example.com/storage/v1/upload/resumable',
    );
  });
});
