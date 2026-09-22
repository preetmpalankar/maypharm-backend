import { SupabaseClient, User } from '@supabase/supabase-js';
export declare class SupabaseService {
    readonly admin: SupabaseClient;
    constructor();
    getUserFromBearer(authorization?: string): Promise<User>;
    requireAdmin(userId: string): Promise<void>;
}
