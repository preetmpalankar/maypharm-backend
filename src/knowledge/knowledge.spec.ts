import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
  chunkChars,
  chunkText,
  contentHash,
  describeItem,
  normalizeEntityName,
} from './chunking';
import { extractText } from './text-extraction';

describe('knowledge chunking', () => {
  it('describes an item from its fields and string metadata only', () => {
    const text = describeItem({
      id: 'x',
      title: 'Paracetamol 500 mg',
      content_type: 'product',
      category: 'Analgesics',
      product_name: 'Paracetamol',
      description: 'Pain relief tablets.',
      metadata: { genericName: 'Paracetamol', packSize: '', count: 3 },
      brand_name: 'Calpol',
    });

    expect(text).toContain('Title: Paracetamol 500 mg');
    expect(text).toContain('Brand: Calpol');
    expect(text).toContain('Generic Name: Paracetamol');
    expect(text).not.toContain('Pack Size');
    expect(text).not.toContain('Count');
  });

  it('indexes custom fields under their own titles', () => {
    const text = describeItem({
      id: 'x',
      title: 'Testoryl XR',
      content_type: 'product',
      category: 'Diabetes',
      product_name: null,
      description: 'Extended-release tablets.',
      metadata: {},
      custom_fields: [
        { label: 'Pack size (India)', value: '10 x 10 tablets' },
        { label: '  ', value: 'ignored' },
      ],
    });

    expect(text).toContain('Pack size (India): 10 x 10 tablets');
    expect(text).not.toContain('ignored');
  });

  it('splits long text into overlapping, headed chunks within the size limit', () => {
    const sentence = 'Patients reported improvement in the primary endpoint. ';
    const chunks = chunkText(sentence.repeat(120), '[Doc]');

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startsWith('[Doc]\n\n')).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(chunkChars + 10);
    }
    // Consecutive chunks overlap so a fact on the boundary survives in one.
    const tail = chunks[0].slice(-60).trim();
    expect(chunks[1]).toContain(tail.slice(-30));
  });

  it('returns no chunks for empty text and one for short text', () => {
    expect(chunkText('   ', '[Doc]')).toEqual([]);
    expect(chunkText('Short note.', '[Doc]')).toEqual(['[Doc]\n\nShort note.']);
  });

  it('hashes deterministically and separates parts', () => {
    expect(contentHash(['a', 'b'])).toBe(contentHash(['a', 'b']));
    expect(contentHash(['ab', ''])).not.toBe(contentHash(['a', 'b']));
  });

  it('normalizes entity names for merging', () => {
    expect(normalizeEntityName('  Calpol®   Plus ')).toBe('calpol plus');
    expect(normalizeEntityName('PARACETAMOL')).toBe(
      normalizeEntityName('paracetamol'),
    );
  });
});

describe('knowledge text extraction', () => {
  const encoder = new TextEncoder();

  it('reads CSV as text', async () => {
    const result = await extractText(
      encoder.encode('drug,strength\nParacetamol,500 mg\n'),
      'csv',
    );
    expect(result.method).toBe('csv');
    expect(result.text).toContain('Paracetamol,500 mg');
  });

  it('reads slide text from PPTX in slide order', async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide2.xml',
      '<p:sld><a:t>Second &amp; last</a:t></p:sld>',
    );
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>First slide</a:t></p:sld>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    const result = await extractText(bytes, 'pptx');
    expect(result.method).toBe('pptx');
    expect(result.text.indexOf('First slide')).toBeLessThan(
      result.text.indexOf('Second & last'),
    );
  });

  it('reads cell values from XLSX', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Trials');
    sheet.addRow(['Study', 'Endpoint']);
    sheet.addRow(['MP-301', 'HbA1c reduction']);
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());

    const result = await extractText(bytes, 'xlsx');
    expect(result.text).toContain('[Sheet: Trials]');
    expect(result.text).toContain('MP-301 | HbA1c reduction');
  });

  it('returns no text for media files', async () => {
    const result = await extractText(new Uint8Array([1, 2, 3]), 'mp4');
    expect(result).toEqual({ text: '', method: 'no-text:mp4' });
  });
});
