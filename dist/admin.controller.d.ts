import { SupabaseService } from './supabase.service';
type UploadedAsset = {
    buffer: Buffer;
    size: number;
    mimetype: string;
    originalname: string;
};
export declare class AdminController {
    private readonly supabase;
    constructor(supabase: SupabaseService);
    private requireAdmin;
    private getBrandOrFail;
    private uploadBrandLogo;
    listContent(authorization: string | undefined, query: Record<string, string>): Promise<{
        data: {
            id: any;
            title: any;
            content_type: any;
            category: any;
            status: any;
            product_name: any;
            brand_id: any;
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
    getContent(authorization: string | undefined, id: string): Promise<{
        data: {
            id: any;
            title: any;
            content_type: any;
            category: any;
            status: any;
            product_name: any;
            brand_id: any;
            description: any;
            storage_path: any;
            metadata: any;
            updated_at: any;
        };
    }>;
    listUsers(authorization: string | undefined, query: Record<string, string>): Promise<{
        data: {
            id: any;
            full_name: any;
            email: any;
            role: any;
            status: any;
            territory: any;
            created_at: any;
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
    listAuditEvents(authorization: string | undefined, query: Record<string, string>): Promise<{
        data: {
            id: any;
            actor_id: any;
            action: any;
            entity_type: any;
            entity_id: any;
            metadata: any;
            created_at: any;
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
    createUser(authorization: string | undefined, body: unknown): Promise<{
        id: string;
        email: string | undefined;
    }>;
    createContent(authorization: string | undefined, body: Record<string, string>, asset?: UploadedAsset): Promise<{
        data: {
            id: any;
            title: any;
            content_type: any;
            category: any;
            status: any;
            product_name: any;
            brand_id: any;
            storage_path: any;
            metadata: any;
            updated_at: any;
        };
        message: string;
    }>;
    updateContent(authorization: string | undefined, id: string, body: Record<string, string>, asset?: UploadedAsset): Promise<{
        data: {
            id: any;
            title: any;
            content_type: any;
            category: any;
            status: any;
            product_name: any;
            brand_id: any;
            storage_path: any;
            metadata: any;
            updated_at: any;
        };
        message: string;
    }>;
    listBrands(authorization: string | undefined, query: Record<string, string>): Promise<{
        data: {
            id: any;
            name: any;
            slug: any;
            category: any;
            description: any;
            logo_path: any;
            status: any;
            sort_order: any;
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
    getBrand(authorization: string | undefined, id: string): Promise<{
        data: {
            id: any;
            name: any;
            slug: any;
            category: any;
            description: any;
            logo_path: any;
            status: any;
            sort_order: any;
            updated_at: any;
        };
    }>;
    createBrand(authorization: string | undefined, body: Record<string, string>, logo?: UploadedAsset): Promise<{
        data: {
            id: any;
            name: any;
            slug: any;
            category: any;
            description: any;
            logo_path: any;
            status: any;
            sort_order: any;
            updated_at: any;
        };
        message: string;
    }>;
    updateBrand(authorization: string | undefined, id: string, body: Record<string, string>, logo?: UploadedAsset): Promise<{
        data: {
            id: any;
            name: any;
            slug: any;
            category: any;
            description: any;
            logo_path: any;
            status: any;
            sort_order: any;
            updated_at: any;
        };
        message: string;
    }>;
    listCategories(authorization: string | undefined, query: Record<string, string>): Promise<{
        data: {
            id: any;
            name: any;
            slug: any;
            description: any;
            status: any;
            sort_order: any;
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
    getCategory(authorization: string | undefined, id: string): Promise<{
        data: {
            id: any;
            name: any;
            slug: any;
            description: any;
            status: any;
            sort_order: any;
            updated_at: any;
        };
    }>;
    createCategory(authorization: string | undefined, body: Record<string, string>): Promise<{
        data: {
            id: any;
            name: any;
            slug: any;
            description: any;
            status: any;
            sort_order: any;
            updated_at: any;
        };
        message: string;
    }>;
    updateCategory(authorization: string | undefined, id: string, body: Record<string, string>): Promise<{
        data: {
            id: any;
            name: any;
            slug: any;
            description: any;
            status: any;
            sort_order: any;
            updated_at: any;
        };
        message: string;
    }>;
}
export {};
