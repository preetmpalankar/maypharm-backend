import {
  type AssistantSource,
  buildContext,
  citedIndexes,
  locationsIn,
  queryTerms,
  stripChunkHeader,
  titleFrom,
  toPublicSource,
} from './prompt';

const source = (overrides: Partial<AssistantSource> = {}): AssistantSource => ({
  index: 1,
  contentId: '00000000-0000-4000-8000-000000000001',
  title: 'Calpol Product Monograph',
  contentType: 'product',
  category: 'Analgesics',
  brandName: 'Calpol',
  brandSlug: 'calpol',
  fileName: 'calpol.pdf',
  locations: [],
  score: 0.71,
  excerpts: [
    '[Calpol Product Monograph | product]\n\n[Page 2]\nParacetamol 500 mg tablets.',
  ],
  facts: [
    {
      source: 'Calpol',
      relation: 'contains_molecule',
      target: 'Paracetamol',
      evidence: 'Each tablet contains paracetamol',
    },
  ],
  ...overrides,
});

describe('assistant prompt', () => {
  it('numbers sources with their type, brand, excerpts and facts', () => {
    const context = buildContext([
      source(),
      source({ index: 2, title: 'Study MP-301', excerpts: [], facts: [] }),
    ]);

    expect(context).toContain('[1] Calpol Product Monograph');
    expect(context).toContain(
      'Type: product | Brand: Calpol | Category: Analgesics',
    );
    expect(context).toContain('Paracetamol 500 mg tablets.');
    expect(context).not.toContain('[Calpol Product Monograph | product]'); // chunk header stripped
    expect(context).toContain(
      '- Calpol contains molecule Paracetamol (evidence: "Each tablet contains paracetamol")',
    );
    expect(context).toContain('[2] Study MP-301');
  });

  it('says so when nothing matched', () => {
    expect(buildContext([])).toBe(
      'No approved MayPharm content matched this question.',
    );
  });

  it('reads cited source numbers in first-cited order, ignoring unknown ones', () => {
    expect(
      citedIndexes(
        'Dose is 500 mg [2]. Approved in adults [1][2]. See [9].',
        3,
      ),
    ).toEqual([2, 1]);
    expect(citedIndexes('Both apply [1, 3] and [2-3].', 3)).toEqual([1, 3, 2]);
    expect(citedIndexes('No citations here.', 3)).toEqual([]);
  });

  it('finds page and slide locations in excerpts', () => {
    expect(
      locationsIn(['[Page 4]\ntext', 'x [Slide 2] y', '[Page 4] again']),
    ).toEqual(['Page 4', 'Slide 2']);
  });

  it('strips only the leading chunk header', () => {
    expect(stripChunkHeader('[T | product]\n\nBody [1] text')).toBe(
      'Body [1] text',
    );
    expect(stripChunkHeader('No header')).toBe('No header');
  });

  it('keeps distinctive query terms', () => {
    expect(queryTerms('What is the dosage of Calpol® for adults?')).toEqual([
      'dosage',
      'calpol',
      'adults',
    ]);
  });

  it('sends clients sources without excerpts or facts', () => {
    const shared = toPublicSource(source());
    expect(shared).not.toHaveProperty('excerpts');
    expect(shared).not.toHaveProperty('facts');
    expect(shared.title).toBe('Calpol Product Monograph');
  });

  it('titles conversations from the first question', () => {
    expect(titleFrom('  What   is Calpol? ')).toBe('What is Calpol?');
    expect(titleFrom('x'.repeat(100))).toHaveLength(68);
  });
});
