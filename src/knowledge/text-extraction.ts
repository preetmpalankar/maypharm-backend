import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';

/** Hard cap on extracted text per item, so one huge file can't run up cost. */
export const maxExtractedChars = 400_000;

export type ExtractedText = {
  text: string;
  /** How the file was read, or why it wasn't (kept in the index state). */
  method: string;
};

const decoder = new TextDecoder('utf-8');

function clean(text: string) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxExtractedChars);
}

async function fromPdf(bytes: Uint8Array) {
  // unpdf is ESM-only, so it is loaded on demand.
  const { extractText, getDocumentProxy } = await import('unpdf');
  // Font data only matters for rendering; silence its warnings.
  const pdf = await getDocumentProxy(bytes, { verbosity: 0 });
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map((page, index) => `[Page ${index + 1}]\n${page}`).join('\n\n');
}

async function fromDocx(bytes: Uint8Array) {
  const { value } = await mammoth.extractRawText({
    buffer: Buffer.from(bytes),
  });
  return value;
}

async function fromXlsx(bytes: Uint8Array) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);

  const sheets: string[] = [];
  workbook.eachSheet((sheet) => {
    const rows: string[] = [];
    sheet.eachRow((row) => {
      const values = (row.values as unknown[])
        .slice(1)
        .map((cell) => cellText(cell))
        .filter((value) => value !== '');
      if (values.length > 0) rows.push(values.join(' | '));
    });
    if (rows.length > 0)
      sheets.push(`[Sheet: ${sheet.name}]\n${rows.join('\n')}`);
  });

  return sheets.join('\n\n');
}

function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  if (typeof cell === 'object') {
    const value = cell as {
      text?: unknown;
      result?: unknown;
      richText?: { text: string }[];
    };
    if (Array.isArray(value.richText))
      return value.richText.map((part) => part.text).join('');
    if (value.text !== undefined) return cellText(value.text);
    if (value.result !== undefined) return cellText(value.result);
    return '';
  }
  if (
    typeof cell === 'string' ||
    typeof cell === 'number' ||
    typeof cell === 'boolean'
  ) {
    return String(cell).trim();
  }
  return '';
}

async function fromPptx(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const slides: string[] = [];
  for (const name of slideNames) {
    const xml = await zip.files[name].async('string');
    const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) =>
      decodeXml(match[1]),
    );
    if (runs.length > 0)
      slides.push(`[Slide ${slideNumber(name)}]\n${runs.join(' ')}`);
  }

  return slides.join('\n\n');
}

function slideNumber(name: string) {
  return Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Text from an uploaded file, by extension. Media (images, video, audio) have
 * no text to extract here; the item's title, description and details still
 * get indexed by the caller.
 */
export async function extractText(
  bytes: Uint8Array,
  extension: string,
): Promise<ExtractedText> {
  switch (extension) {
    case 'pdf':
      return { text: clean(await fromPdf(bytes)), method: 'pdf' };
    case 'docx':
      return { text: clean(await fromDocx(bytes)), method: 'docx' };
    case 'xlsx':
      return { text: clean(await fromXlsx(bytes)), method: 'xlsx' };
    case 'pptx':
      return { text: clean(await fromPptx(bytes)), method: 'pptx' };
    case 'csv':
    case 'txt':
      return { text: clean(decoder.decode(bytes)), method: extension };
    default:
      return { text: '', method: `no-text:${extension || 'unknown'}` };
  }
}
