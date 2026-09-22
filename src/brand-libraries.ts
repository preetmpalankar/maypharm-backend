/**
 * Every brand folder exposes the same three libraries. Each one maps onto the
 * existing content_type enum so brand navigation and the global type-based
 * views stay backed by a single content table.
 */
export const brandLibraries = {
  product: {
    label: 'Product Library',
    description: 'Visual ads, labels and marketing material',
    contentTypes: ['product', 'field_asset'],
  },
  clinical: {
    label: 'Clinical Evidence',
    description: 'Brand confidential docs and clinical literature',
    contentTypes: ['clinical', 'regulatory'],
  },
  media: {
    label: 'Media Library',
    description: 'Social media posts, videos and brand films',
    contentTypes: ['media'],
  },
} as const;

export type BrandLibraryKey = keyof typeof brandLibraries;

export const brandLibraryKeys = Object.keys(brandLibraries) as [
  BrandLibraryKey,
  ...BrandLibraryKey[],
];
