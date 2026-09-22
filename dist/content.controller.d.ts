import { StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseService } from './supabase.service';
export declare class ContentController {
    private readonly supabase;
    constructor(supabase: SupabaseService);
    private getBrandIdBySlug;
    listApprovedContent(authorization: string | undefined, query: Record<string, string>): Promise<{
        data: {
            id: any;
            title: any;
            content_type: any;
            category: any;
            product_name: any;
            brand_id: any;
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
    getApprovedContent(authorization: string | undefined, id: string): Promise<{
        data: {
            id: any;
            title: any;
            content_type: any;
            category: any;
            product_name: any;
            brand_id: any;
            description: any;
            status: any;
            storage_bucket: any;
            storage_path: any;
            metadata: any;
            updated_at: any;
        };
    }>;
    streamApprovedAsset(authorization: string | undefined, range: string | undefined, id: string, download: string | undefined, response: Response): Promise<StreamableFile>;
}
