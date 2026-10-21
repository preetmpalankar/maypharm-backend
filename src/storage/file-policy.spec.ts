import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import {
  assertWithinSizeLimit,
  describeAllowed,
  getExtension,
  matchesSignature,
  resolveFileType,
  sanitizeDisplayName,
  uploadPolicies,
} from './file-policy';

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => new TextEncoder().encode(text);

function withPrefix(prefix: Uint8Array, length = 64) {
  const sample = new Uint8Array(length);
  sample.set(prefix);
  return sample;
}

describe('file policy', () => {
  describe('resolveFileType', () => {
    it('resolves by extension, case-insensitively, to the canonical MIME', () => {
      expect(resolveFileType('Brochure.PDF', 'content')).toEqual({
        extension: 'pdf',
        mime: 'application/pdf',
        label: 'PDF',
      });
      expect(resolveFileType('deck.pptx', 'content').mime).toBe(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      );
    });

    it('accepts CSV regardless of what the browser would have reported', () => {
      // Windows reports CSV as application/vnd.ms-excel; we never consult it.
      expect(resolveFileType('territories.csv', 'content').mime).toBe(
        'text/csv',
      );
    });

    it('rejects unknown and missing extensions with a helpful message', () => {
      expect(() => resolveFileType('setup.exe', 'content')).toThrow(
        BadRequestException,
      );
      expect(() => resolveFileType('README', 'content')).toThrow(
        /Unsupported file type/,
      );
    });

    it('restricts logos to raster images', () => {
      expect(resolveFileType('logo.webp', 'logo').mime).toBe('image/webp');
      expect(() => resolveFileType('logo.pdf', 'logo')).toThrow(
        /Unsupported logo type/,
      );
    });
  });

  describe('assertWithinSizeLimit', () => {
    it('allows files up to the limit', () => {
      expect(() =>
        assertWithinSizeLimit(uploadPolicies.content.maxBytes, 'content'),
      ).not.toThrow();
    });

    it('rejects empty and oversized files', () => {
      expect(() => assertWithinSizeLimit(0, 'content')).toThrow(/empty/);
      expect(() =>
        assertWithinSizeLimit(uploadPolicies.content.maxBytes + 1, 'content'),
      ).toThrow(PayloadTooLargeException);
      expect(() => assertWithinSizeLimit(3 * 1024 * 1024, 'logo')).toThrow(
        /2 MB/,
      );
    });
  });

  describe('matchesSignature', () => {
    it('recognises each supported format from its leading bytes', () => {
      expect(matchesSignature('pdf', withPrefix(ascii('%PDF-1.7')))).toBe(true);
      expect(
        matchesSignature(
          'png',
          withPrefix(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
        ),
      ).toBe(true);
      expect(
        matchesSignature('jpg', withPrefix(bytes(0xff, 0xd8, 0xff, 0xe0))),
      ).toBe(true);
      expect(
        matchesSignature(
          'webp',
          withPrefix(ascii('RIFF\x00\x00\x00\x00WEBPVP8 ')),
        ),
      ).toBe(true);
      expect(
        matchesSignature('mp4', withPrefix(ascii('\x00\x00\x00\x18ftypmp42'))),
      ).toBe(true);
      expect(
        matchesSignature('mov', withPrefix(ascii('\x00\x00\x00\x14ftypqt  '))),
      ).toBe(true);
      expect(
        matchesSignature('webm', withPrefix(bytes(0x1a, 0x45, 0xdf, 0xa3))),
      ).toBe(true);
      expect(
        matchesSignature('xlsx', withPrefix(bytes(0x50, 0x4b, 0x03, 0x04))),
      ).toBe(true);
      expect(
        matchesSignature('csv', ascii('name,territory\nPriya,West\n')),
      ).toBe(true);
    });

    it('finds a PDF header preceded by junk, as the spec allows', () => {
      const sample = new Uint8Array(200);
      sample.set(ascii('%PDF-1.4'), 120);
      expect(matchesSignature('pdf', sample)).toBe(true);
    });

    it('rejects a file whose contents do not match its extension', () => {
      // An executable renamed to look like a document.
      const executable = withPrefix(bytes(0x4d, 0x5a, 0x90, 0x00));
      expect(matchesSignature('pdf', executable)).toBe(false);
      expect(matchesSignature('png', executable)).toBe(false);
      expect(matchesSignature('mp4', executable)).toBe(false);
      expect(matchesSignature('xlsx', withPrefix(ascii('%PDF-1.7')))).toBe(
        false,
      );
    });

    it('rejects binary data posing as CSV, and empty samples', () => {
      expect(
        matchesSignature('csv', bytes(0x50, 0x4b, 0x03, 0x04, 0x00, 0x00)),
      ).toBe(false);
      expect(matchesSignature('csv', new Uint8Array())).toBe(false);
    });

    it('rejects unknown extensions outright', () => {
      expect(matchesSignature('exe', withPrefix(bytes(0x4d, 0x5a)))).toBe(
        false,
      );
    });
  });

  describe('helpers', () => {
    it('extracts extensions defensively', () => {
      expect(getExtension('report.final.PDF')).toBe('pdf');
      expect(getExtension('no-extension')).toBe('');
      expect(getExtension('trailing.')).toBe('');
    });

    it('sanitises display names without losing readability', () => {
      expect(sanitizeDisplayName('C:\\fakepath\\Q3 Report.pdf')).toBe(
        'Q3 Report.pdf',
      );
      expect(sanitizeDisplayName('../../etc/passwd')).toBe('passwd');
      expect(sanitizeDisplayName('bad"name\u0007.pdf')).toBe('badname.pdf');
      expect(sanitizeDisplayName('Études cliniques.pdf')).toBe(
        'Études cliniques.pdf',
      );
      expect(sanitizeDisplayName('   ')).toBe('file');
    });

    it('describes allowed types without duplicate labels', () => {
      expect(describeAllowed('logo')).toBe('PNG, JPG, WEBP');
    });
  });
});
