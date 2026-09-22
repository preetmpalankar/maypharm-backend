import { SupabaseService } from './supabase.service';
export declare class CategoriesController {
    private readonly supabase;
    constructor(supabase: SupabaseService);
    listCategories(authorization: string | undefined, query: Record<string, string>): Promise<{
        data: {
            id: any;
            name: any;
            slug: any;
            description: any;
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
}
