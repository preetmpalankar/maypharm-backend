import { contentDisposition } from './asset-storage.service';
import { assetFileName } from './asset-names';

describe('download naming', () => {
  it('builds a header that survives quotes and non-ASCII names', () => {
    const header = contentDisposition('attachment', 'Études "cliniques".pdf');

    expect(header).toContain('attachment; filename="_tudes _cliniques_.pdf"');
    expect(header).toContain(
      "filename*=UTF-8''%C3%89tudes%20%22cliniques%22.pdf",
    );
  });

  it('prefers the uploader file name, then falls back to the title', () => {
    expect(
      assetFileName({
        title: 'Ignored',
        storage_path: 'x/y.pdf',
        file_name: 'Original.pdf',
      }),
    ).toBe('Original.pdf');
    expect(
      assetFileName({
        title: 'Cardio Monograph',
        storage_path: 'product/abc.pdf',
        file_name: null,
      }),
    ).toBe('Cardio_Monograph.pdf');
  });
});
