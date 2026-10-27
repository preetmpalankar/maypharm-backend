import { BadRequestException } from '@nestjs/common';
import {
  resumableEndpoint,
  type AssetStorageService,
  type VerifiedUpload,
} from './asset-storage.service';
import { titleFromFileName } from './asset-names';
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

  it('sends signed resumable uploads to the signed TUS route', () => {
    expect(resumableEndpoint('https://sjdmyzreeorswiurnvze.supabase.co')).toBe(
      'https://sjdmyzreeorswiurnvze.supabase.co/storage/v1/upload/resumable/sign',
    );
    expect(resumableEndpoint('https://db.example.com/')).toBe(
      'https://db.example.com/storage/v1/upload/resumable/sign',
    );
  });
});

describe('titles from file names', () => {
  it('turns a file name into a readable title', () => {
    expect(titleFromFileName('Testoryl_XR-brochure.pdf')).toBe(
      'Testoryl XR brochure',
    );
    expect(titleFromFileName('launch  deck.final.pptx')).toBe(
      'launch deck.final',
    );
    expect(titleFromFileName('.pdf')).toBe('Untitled');
  });
});
