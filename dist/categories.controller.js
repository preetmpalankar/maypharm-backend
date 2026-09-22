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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CategoriesController = void 0;
const common_1 = require("@nestjs/common");
const zod_1 = require("zod");
const pagination_1 = require("./pagination");
const supabase_service_1 = require("./supabase.service");
const categoryColumns = 'id,name,slug,description,sort_order,updated_at';
const listQuerySchema = pagination_1.paginationSchema.extend({
    q: zod_1.z.string().trim().min(1).max(80).optional(),
});
let CategoriesController = class CategoriesController {
    supabase;
    constructor(supabase) {
        this.supabase = supabase;
    }
    async listCategories(authorization, query) {
        await this.supabase.getUserFromBearer(authorization);
        const params = listQuerySchema.parse(query);
        const { from, to } = (0, pagination_1.getRange)(params.page, params.pageSize);
        let request = this.supabase.admin
            .from('categories')
            .select(categoryColumns, { count: 'exact' })
            .eq('status', 'active')
            .order('sort_order', { ascending: true })
            .order('name', { ascending: true })
            .range(from, to);
        if (params.q) {
            request = request.ilike('name', `%${params.q.replace(/[%_,()]/g, '')}%`);
        }
        const { data, error, count } = await request;
        if (error) {
            throw error;
        }
        return {
            data: data ?? [],
            meta: (0, pagination_1.getMeta)(params.page, params.pageSize, count ?? 0),
        };
    }
};
exports.CategoriesController = CategoriesController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], CategoriesController.prototype, "listCategories", null);
exports.CategoriesController = CategoriesController = __decorate([
    (0, common_1.Controller)('categories'),
    __metadata("design:paramtypes", [supabase_service_1.SupabaseService])
], CategoriesController);
//# sourceMappingURL=categories.controller.js.map