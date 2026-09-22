"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupabaseService = void 0;
const common_1 = require("@nestjs/common");
const supabase_js_1 = require("@supabase/supabase-js");
let SupabaseService = class SupabaseService {
    admin;
    constructor() {
        const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !serviceRoleKey) {
            throw new common_1.InternalServerErrorException('Supabase backend credentials are not configured.');
        }
        this.admin = (0, supabase_js_1.createClient)(url, serviceRoleKey, {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
            },
        });
    }
    async getUserFromBearer(authorization) {
        const token = authorization?.startsWith('Bearer ')
            ? authorization.slice('Bearer '.length)
            : null;
        if (!token) {
            throw new common_1.UnauthorizedException('Bearer token required.');
        }
        const { data: { user }, error, } = await this.admin.auth.getUser(token);
        if (error || !user) {
            throw new common_1.UnauthorizedException('Invalid Supabase session.');
        }
        return user;
    }
    async requireAdmin(userId) {
        const { data, error } = await this.admin
            .from('admin_profiles')
            .select('role,status')
            .eq('id', userId)
            .single();
        if (error ||
            data?.role !== 'admin' ||
            !['active', 'invited'].includes(data.status)) {
            throw new common_1.UnauthorizedException('Administrator access required.');
        }
    }
};
exports.SupabaseService = SupabaseService;
exports.SupabaseService = SupabaseService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [])
], SupabaseService);
//# sourceMappingURL=supabase.service.js.map