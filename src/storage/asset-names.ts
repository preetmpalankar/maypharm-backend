/**
 * The name a viewer's browser saves a file under: the uploader's original
 * file name when known, otherwise one derived from the record title (rows
 * uploaded before file names were stored).
 */
export function assetFileName(item: {
  title: string;
  storage_path: string | null;
  file_name?: string | null;
}) {
  if (item.file_name) {
    return item.file_name;
  }

  const extension = item.storage_path?.split('.').pop()?.toLowerCase();
  const safeTitle =
    item.title
      .trim()
      .replace(/[^a-z0-9.-]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || 'maypharm-asset';

  if (!extension || safeTitle.toLowerCase().endsWith(`.${extension}`)) {
    return safeTitle;
  }

  return `${safeTitle}.${extension}`;
}
