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
exports.BrandsController = void 0;
const common_1 = require("@nestjs/common");
const zod_1 = require("zod");
const brand_libraries_1 = require("./brand-libraries");
const pagination_1 = require("./pagination");
const supabase_service_1 = require("./supabase.service");
const brandColumns = 'id,name,slug,category,description,logo_bucket,logo_path,sort_order,updated_at';
const contentColumns = 'id,title,content_type,category,product_name,description,status,storage_bucket,storage_path,metadata,updated_at';
const slugSchema = zod_1.z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'Invalid brand slug.');
const brandListQuerySchema = pagination_1.paginationSchema.extend({
    q: zod_1.z.string().trim().min(1).max(80).optional(),
    category: zod_1.z.string().trim().min(1).max(120).optional(),
});
const libraryQuerySchema = pagination_1.paginationSchema.extend({
    q: zod_1.z.string().trim().min(2).max(80).optional(),
});
const librarySchema = zod_1.z.enum(brand_libraries_1.brandLibraryKeys);
const emptyCounts = { product: 0, clinical: 0, media: 0, total: 0 };
function escapeFilter(value) {
    return value.replace(/[%_,()]/g, '');
}
let BrandsController = class BrandsController {
    supabase;
    constructor(supabase) {
        this.supabase = supabase;
    }
    async getCountsByBrand(brandIds) {
        const counts = new Map();
        if (brandIds.length === 0) {
            return counts;
        }
        const { data, error } = await this.supabase.admin
            .from('brand_library_counts')
            .select('brand_id,product_count,clinical_count,media_count,total_count')
            .in('brand_id', brandIds);
        if (error) {
            throw error;
        }
        for (const row of (data ?? [])) {
            counts.set(row.brand_id, {
                product: Number(row.product_count ?? 0),
                clinical: Number(row.clinical_count ?? 0),
                media: Number(row.media_count ?? 0),
                total: Number(row.total_count ?? 0),
            });
        }
        return counts;
    }
    async getBrandBySlug(slug) {
        const brandSlug = slugSchema.parse(slug);
        const { data, error } = await this.supabase.admin
            .from('brands')
            .select(brandColumns)
            .eq('slug', brandSlug)
            .eq('status', 'active')
            .maybeSingle();
        if (error) {
            throw error;
        }
        if (!data) {
            throw new common_1.NotFoundException('Brand not found.');
        }
        return data;
    }
    async listBrands(authorization, query) {
        await this.supabase.getUserFromBearer(authorization);
        const params = brandListQuerySchema.parse(query);
        const { from, to } = (0, pagination_1.getRange)(params.page, params.pageSize);
        let request = this.supabase.admin
            .from('brands')
            .select(brandColumns, { count: 'exact' })
            .eq('status', 'active')
            .order('sort_order', { ascending: true })
            .order('name', { ascending: true })
            .range(from, to);
        if (params.q) {
            const safeQuery = escapeFilter(params.q);
            request = request.or(`name.ilike.%${safeQuery}%,category.ilike.%${safeQuery}%`);
        }
        if (params.category) {
            request = request.ilike('category', escapeFilter(params.category));
        }
        const { data, error, count } = await request;
        if (error) {
            throw error;
        }
        const brands = (data ?? []);
        const counts = await this.getCountsByBrand(brands.map((brand) => brand.id));
        return {
            data: brands.map((brand) => ({
                ...brand,
                counts: counts.get(brand.id) ?? emptyCounts,
            })),
            meta: (0, pagination_1.getMeta)(params.page, params.pageSize, count ?? 0),
        };
    }
    async listCategories(authorization) {
        await this.supabase.getUserFromBearer(authorization);
        const { data, error } = await this.supabase.admin
            .from('brands')
            .select('category')
            .eq('status', 'active')
            .order('category', { ascending: true });
        if (error) {
            throw error;
        }
        const categories = new Map();
        for (const row of (data ?? [])) {
            const label = row.category?.trim();
            if (label && !categories.has(label.toLowerCase())) {
                categories.set(label.toLowerCase(), label);
            }
        }
        return { data: [...categories.values()] };
    }
    async getBrand(authorization, slug) {
        await this.supabase.getUserFromBearer(authorization);
        const brand = await this.getBrandBySlug(slug);
        const counts = await this.getCountsByBrand([brand.id]);
        return {
            data: {
                ...brand,
                counts: counts.get(brand.id) ?? emptyCounts,
            },
        };
    }
    async listBrandLibrary(authorization, slug, library, query) {
        await this.supabase.getUserFromBearer(authorization);
        const libraryKey = librarySchema.parse(library);
        const brand = await this.getBrandBySlug(slug);
        const params = libraryQuerySchema.parse(query);
        const { from, to } = (0, pagination_1.getRange)(params.page, params.pageSize);
        let request = this.supabase.admin
            .from('content_items')
            .select(contentColumns, { count: 'exact' })
            .eq('brand_id', brand.id)
            .eq('status', 'approved')
            .in('content_type', [...brand_libraries_1.brandLibraries[libraryKey].contentTypes])
            .order('updated_at', { ascending: false })
            .order('id', { ascending: false })
            .range(from, to);
        if (params.q) {
            const safeQuery = escapeFilter(params.q);
            request = request.or(`title.ilike.%${safeQuery}%,description.ilike.%${safeQuery}%,category.ilike.%${safeQuery}%`);
        }
        const { data, error, count } = await request;
        if (error) {
            throw error;
        }
        return {
            brand,
            library: { key: libraryKey, ...brand_libraries_1.brandLibraries[libraryKey] },
            data: data ?? [],
            meta: (0, pagination_1.getMeta)(params.page, params.pageSize, count ?? 0),
        };
    }
    async streamBrandLogo(authorization, slug, response) {
        await this.supabase.getUserFromBearer(authorization);
        const brand = await this.getBrandBySlug(slug);
        if (!brand.logo_path) {
            throw new common_1.NotFoundException('Brand logo not available.');
        }
        const { data, error } = await this.supabase.admin.storage
            .from(brand.logo_bucket)
            .download(brand.logo_path);
        if (error || !data) {
            throw new common_1.NotFoundException('Brand logo not available.');
        }
        response.set({
            'Cache-Control': 'private, max-age=300',
            'Content-Type': data.type || 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
            'X-Robots-Tag': 'noindex, nofollow, noarchive',
        });
        return new common_1.StreamableFile(Buffer.from(await data.arrayBuffer()));
    }
};
exports.BrandsController = BrandsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], BrandsController.prototype, "listBrands", null);
__decorate([
    (0, common_1.Get)('categories'),
    __param(0, (0, common_1.Headers)('authorization')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], BrandsController.prototype, "listCategories", null);
__decorate([
    (0, common_1.Get)(':slug'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Param)('slug')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], BrandsController.prototype, "getBrand", null);
__decorate([
    (0, common_1.Get)(':slug/library/:library'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Param)('slug')),
    __param(2, (0, common_1.Param)('library')),
    __param(3, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", Promise)
], BrandsController.prototype, "listBrandLibrary", null);
__decorate([
    (0, common_1.Get)(':slug/logo'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Param)('slug')),
    __param(2, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], BrandsController.prototype, "streamBrandLogo", null);
exports.BrandsController = BrandsController = __decorate([
    (0, common_1.Controller)('brands'),
    __metadata("design:paramtypes", [supabase_service_1.SupabaseService])
], BrandsController);
//# sourceMappingURL=brands.controller.js.map