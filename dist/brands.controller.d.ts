import { StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseService } from './supabase.service';
type BrandRow = {
    id: string;
    name: string;
    slug: string;
    category: string;
    description: string;
    logo_bucket: string;
    logo_path: string | null;
    sort_order: number;
    updated_at: string;
};
export declare class BrandsController {
    private readonly supabase;
    constructor(supabase: SupabaseService);
    private getCountsByBrand;
    private getBrandBySlug;
    listBrands(authorization: string | undefined, query: Record<string, string>): Promise<{
        data: {
            counts: {
                product: number;
                clinical: number;
                media: number;
                total: number;
            };
            id: string;
            name: string;
            slug: string;
            category: string;
            description: string;
            logo_bucket: string;
            logo_path: string | null;
            sort_order: number;
            updated_at: string;
        }[];
        meta: {
            page: number;
            pageSize: number;
            total: number;
            totalPages: number;
            hasNextPage: boolean;
            hasPreviousPage: boolean;
        };
    }>;
    listCategories(authorization: string | undefined): Promise<{
        data: string[];
    }>;
    getBrand(authorization: string | undefined, slug: string): Promise<{
        data: {
            counts: {
                product: number;
                clinical: number;
                media: number;
                total: number;
            };
            id: string;
            name: string;
            slug: string;
            category: string;
            description: string;
            logo_bucket: string;
            logo_path: string | null;
            sort_order: number;
            updated_at: string;
        };
    }>;
    listBrandLibrary(authorization: string | undefined, slug: string, library: string, query: Record<string, string>): Promise<{
        brand: BrandRow;
        library: {
            label: "Product Library";
            description: "Visual ads, labels and marketing material";
            contentTypes: readonly ["product", "field_asset"];
            key: "product" | "clinical" | "media";
        } | {
            label: "Clinical Evidence";
            description: "Brand confidential docs and clinical literature";
            contentTypes: readonly ["clinical", "regulatory"];
            key: "product" | "clinical" | "media";
        } | {
            label: "Media Library";
            description: "Social media posts, videos and brand films";
            contentTypes: readonly ["media"];
            key: "product" | "clinical" | "media";
        };
        data: {
            id: any;
            title: any;
            content_type: any;
            category: any;
            product_name: any;
            description: any;
            status: any;
            storage_bucket: any;
            storage_path: any;
            metadata: any;
            updated_at: any;
        }[];
        meta: {
            page: number;
            pageSize: number;
            total: number;
            totalPages: number;
            hasNextPage: boolean;
            hasPreviousPage: boolean;
        };
    }>;
    streamBrandLogo(authorization: string | undefined, slug: string, response: Response): Promise<StreamableFile>;
}
export {};
