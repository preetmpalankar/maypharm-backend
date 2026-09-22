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
exports.ContentController = void 0;
const common_1 = require("@nestjs/common");
const zod_1 = require("zod");
const pagination_1 = require("./pagination");
const supabase_service_1 = require("./supabase.service");
const contentTypes = [
    'product',
    'clinical',
    'academy',
    'media',
    'field_asset',
    'regulatory',
];
const publicContentQuerySchema = pagination_1.paginationSchema.extend({
    type: zod_1.z.enum(contentTypes).optional(),
    q: zod_1.z.string().trim().min(2).max(80).optional(),
    brand: zod_1.z
        .string()
        .trim()
        .min(1)
        .max(120)
        .regex(/^[a-z0-9-]+$/, 'Invalid brand slug.')
        .optional(),
});
let ContentController = class ContentController {
    supabase;
    constructor(supabase) {
        this.supabase = supabase;
    }
    async getBrandIdBySlug(slug) {
        const { data, error } = await this.supabase.admin
            .from('brands')
            .select('id')
            .eq('slug', slug)
            .eq('status', 'active')
            .maybeSingle();
        if (error) {
            throw error;
        }
        return data?.id ?? null;
    }
    async listApprovedContent(authorization, query) {
        await this.supabase.getUserFromBearer(authorization);
        const params = publicContentQuerySchema.parse(query);
        const { from, to } = (0, pagination_1.getRange)(params.page, params.pageSize);
        let brandId = null;
        if (params.brand) {
            brandId = await this.getBrandIdBySlug(params.brand);
            if (!brandId) {
                return {
                    data: [],
                    meta: (0, pagination_1.getMeta)(params.page, params.pageSize, 0),
                };
            }
        }
        let request = this.supabase.admin
            .from('content_items')
            .select('id,title,content_type,category,product_name,brand_id,description,status,storage_bucket,storage_path,metadata,updated_at', {
            count: 'exact',
        })
            .eq('status', 'approved')
            .order('updated_at', { ascending: false })
            .order('id', { ascending: false })
            .range(from, to);
        if (params.type) {
            request = request.eq('content_type', params.type);
        }
        if (brandId) {
            request = request.eq('brand_id', brandId);
        }
        if (params.q) {
            const safeQuery = params.q.replace(/[%_,]/g, '');
            request = request.or(`title.ilike.%${safeQuery}%,description.ilike.%${safeQuery}%,category.ilike.%${safeQuery}%,product_name.ilike.%${safeQuery}%`);
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
    async getApprovedContent(authorization, id) {
        await this.supabase.getUserFromBearer(authorization);
        const { data, error } = await this.supabase.admin
            .from('content_items')
            .select('id,title,content_type,category,product_name,brand_id,description,status,storage_bucket,storage_path,metadata,updated_at')
            .eq('id', id)
            .eq('status', 'approved')
            .single();
        if (error || !data) {
            throw new common_1.NotFoundException('Content not available.');
        }
        return { data };
    }
    async streamApprovedAsset(authorization, range, id, download, response) {
        const user = await this.supabase.getUserFromBearer(authorization);
        const { data: item, error } = await this.supabase.admin
            .from('content_items')
            .select('id,title,status,storage_bucket,storage_path')
            .eq('id', id)
            .single();
        if (error || !item?.storage_path || item.status !== 'approved') {
            throw new common_1.NotFoundException('Asset not available.');
        }
        const { data: signedAsset, error: signedUrlError } = await this.supabase.admin.storage
            .from(item.storage_bucket)
            .createSignedUrl(item.storage_path, 60);
        if (signedUrlError || !signedAsset?.signedUrl) {
            throw new common_1.NotFoundException('Asset not available.');
        }
        const upstream = await fetch(signedAsset.signedUrl, {
            headers: range ? { Range: range } : undefined,
        });
        if (!upstream.ok || !upstream.body) {
            throw new common_1.NotFoundException('Asset not available.');
        }
        await this.supabase.admin.from('audit_events').insert({
            actor_id: user.id,
            action: 'asset.viewed',
            entity_type: 'content_items',
            entity_id: item.id,
            metadata: {
                title: item.title,
                storagePath: item.storage_path,
            },
        });
        const filename = getAssetFilename(item.title, item.storage_path);
        const contentDisposition = download === '1'
            ? `attachment; filename="${filename}"`
            : `inline; filename="${filename}"`;
        const headers = {
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            Pragma: 'no-cache',
            Expires: '0',
            'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
            'Content-Disposition': contentDisposition,
            'X-Content-Type-Options': 'nosniff',
            'X-Robots-Tag': 'noindex, nofollow, noarchive',
            'Accept-Ranges': upstream.headers.get('accept-ranges') ?? 'bytes',
        };
        for (const header of ['content-length', 'content-range']) {
            const value = upstream.headers.get(header);
            if (value) {
                headers[header.replace(/\b\w/g, (match) => match.toUpperCase())] =
                    value;
            }
        }
        response.status(upstream.status);
        response.set(headers);
        return new common_1.StreamableFile(Buffer.from(await upstream.arrayBuffer()));
    }
};
exports.ContentController = ContentController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "listApprovedContent", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "getApprovedContent", null);
__decorate([
    (0, common_1.Get)(':id/asset'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Headers)('range')),
    __param(2, (0, common_1.Param)('id')),
    __param(3, (0, common_1.Query)('download')),
    __param(4, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, Object, Object]),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "streamApprovedAsset", null);
exports.ContentController = ContentController = __decorate([
    (0, common_1.Controller)('content'),
    __metadata("design:paramtypes", [supabase_service_1.SupabaseService])
], ContentController);
function getAssetFilename(title, storagePath) {
    const extension = storagePath.split('.').pop()?.toLowerCase();
    const safeTitle = title
        .trim()
        .replace(/[^a-z0-9.-]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 120) || 'maypharm-asset';
    if (!extension || safeTitle.toLowerCase().endsWith(`.${extension}`)) {
        return safeTitle;
    }
    return `${safeTitle}.${extension}`;
}
//# sourceMappingURL=content.controller.js.map