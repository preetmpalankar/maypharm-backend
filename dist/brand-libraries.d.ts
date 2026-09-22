export declare const brandLibraries: {
    readonly product: {
        readonly label: "Product Library";
        readonly description: "Visual ads, labels and marketing material";
        readonly contentTypes: readonly ["product", "field_asset"];
    };
    readonly clinical: {
        readonly label: "Clinical Evidence";
        readonly description: "Brand confidential docs and clinical literature";
        readonly contentTypes: readonly ["clinical", "regulatory"];
    };
    readonly media: {
        readonly label: "Media Library";
        readonly description: "Social media posts, videos and brand films";
        readonly contentTypes: readonly ["media"];
    };
};
export type BrandLibraryKey = keyof typeof brandLibraries;
export declare const brandLibraryKeys: [BrandLibraryKey, ...BrandLibraryKey[]];
