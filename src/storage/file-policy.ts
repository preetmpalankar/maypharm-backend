import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

export type UploadKind = 'content' | 'logo';

type FileTypeRule = {
  mime: string;
  label: string;
  matches: (bytes: Uint8Array) => boolean;
};

const megabyte = 1024 * 1024;
const gigabyte = 1024 * megabyte;

function startsWith(signature: number[]) {
  return (bytes: Uint8Array) =>
    bytes.length >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte);
}

function asciiAt(bytes: Uint8Array, offset: number, text: string) {
  if (bytes.length < offset + text.length) {
    return false;
  }

  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) {
      return false;
    }
  }

  return true;
}

/** The PDF spec allows the header anywhere in the first 1024 bytes. */
function isPdf(bytes: Uint8Array) {
  const limit = Math.min(bytes.length, 1024) - 5;

  for (let offset = 0; offset <= limit; offset += 1) {
    if (asciiAt(bytes, offset, '%PDF-')) {
      return true;
    }
  }

  return false;
}

/** MP4 and QuickTime share the ISO base media layout: a box type at byte 4. */
function isIsoMedia(bytes: Uint8Array) {
  return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].some((box) =>
    asciiAt(bytes, 4, box),
  );
}

function isWebp(bytes: Uint8Array) {
  return asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP');
}

/** Office Open XML files (xlsx, docx, pptx) are ZIP containers. */
const isZip = startsWith([0x50, 0x4b, 0x03, 0x04]);

/** CSV has no signature; reject anything carrying binary NUL bytes instead. */
function isText(bytes: Uint8Array) {
  if (bytes.length === 0) {
    return false;
  }

  return !bytes.includes(0x00);
}

const fileTypes: Record<string, FileTypeRule> = {
  pdf: { mime: 'application/pdf', label: 'PDF', matches: isPdf },
  png: {
    mime: 'image/png',
    label: 'PNG',
    matches: startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  jpg: {
    mime: 'image/jpeg',
    label: 'JPG',
    matches: startsWith([0xff, 0xd8, 0xff]),
  },
  jpeg: {
    mime: 'image/jpeg',
    label: 'JPG',
    matches: startsWith([0xff, 0xd8, 0xff]),
  },
  webp: { mime: 'image/webp', label: 'WEBP', matches: isWebp },
  mp4: { mime: 'video/mp4', label: 'MP4', matches: isIsoMedia },
  mov: { mime: 'video/quicktime', label: 'MOV', matches: isIsoMedia },
  webm: {
    mime: 'video/webm',
    label: 'WEBM',
    matches: startsWith([0x1a, 0x45, 0xdf, 0xa3]),
  },
  csv: { mime: 'text/csv', label: 'CSV', matches: isText },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'XLSX',
    matches: isZip,
  },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'DOCX',
    matches: isZip,
  },
  pptx: {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    label: 'PPTX',
    matches: isZip,
  },
};

export const uploadPolicies: Record<
  UploadKind,
  { maxBytes: number; extensions: readonly string[] }
> = {
  content: {
    // Supabase Pro allows up to 50 GB per object, through resumable uploads.
    maxBytes: 50 * gigabyte,
    extensions: [
      'pdf',
      'png',
      'jpg',
      'jpeg',
      'webp',
      'mp4',
      'mov',
      'webm',
      'csv',
      'xlsx',
      'docx',
      'pptx',
    ],
  },
  logo: {
    maxBytes: 2 * megabyte,
    extensions: ['png', 'jpg', 'jpeg', 'webp'],
  },
};

/** How many leading bytes the verifier needs to tell every type apart. */
export const signatureSampleBytes = 4096;

export type ResolvedFileType = {
  extension: string;
  mime: string;
  label: string;
};

export function getExtension(fileName: string) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(fileName.trim());
  return match?.[1]?.toLowerCase() ?? '';
}

export function describeAllowed(kind: UploadKind) {
  const labels = new Set(
    uploadPolicies[kind].extensions.map(
      (extension) => fileTypes[extension].label,
    ),
  );
  return [...labels].join(', ');
}

export function formatMegabytes(bytes: number) {
  return bytes >= gigabyte
    ? `${Math.round(bytes / gigabyte)} GB`
    : `${Math.round(bytes / megabyte)} MB`;
}

/**
 * Decides what a file is from its extension, never from the browser's
 * reported MIME type (Windows reports CSV as application/vnd.ms-excel, some
 * browsers report nothing at all). The stored content type is then the
 * canonical one for that extension.
 */
export function resolveFileType(
  fileName: string,
  kind: UploadKind,
): ResolvedFileType {
  const extension = getExtension(fileName);
  const policy = uploadPolicies[kind];

  if (!extension || !policy.extensions.includes(extension)) {
    throw new BadRequestException(
      kind === 'logo'
        ? `Unsupported logo type. Upload a ${describeAllowed(kind)} image.`
        : `Unsupported file type. Upload one of: ${describeAllowed(kind)}.`,
    );
  }

  const rule = fileTypes[extension];
  return { extension, mime: rule.mime, label: rule.label };
}

export function assertWithinSizeLimit(size: number, kind: UploadKind) {
  const { maxBytes } = uploadPolicies[kind];

  if (!Number.isFinite(size) || size <= 0) {
    throw new BadRequestException('The selected file is empty.');
  }

  if (size > maxBytes) {
    throw new PayloadTooLargeException(
      kind === 'logo'
        ? `Logo must be ${formatMegabytes(maxBytes)} or smaller.`
        : `File is larger than the ${formatMegabytes(maxBytes)} upload limit.`,
    );
  }
}

/** True when the leading bytes are consistent with the file's extension. */
export function matchesSignature(extension: string, bytes: Uint8Array) {
  const rule = fileTypes[extension];
  return Boolean(rule && rule.matches(bytes));
}

/**
 * Keeps the uploader's file name for display and downloads, minus anything
 * that could break a Content-Disposition header or a path.
 */
export function sanitizeDisplayName(fileName: string) {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the intent
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  return cleaned || 'file';
}
