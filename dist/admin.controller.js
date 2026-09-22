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
exports.AdminController = void 0;
const common_1 = require("@nestjs/common");
const platform_express_1 = require("@nestjs/platform-express");
const zod_1 = require("zod");
const pagination_1 = require("./pagination");
const supabase_service_1 = require("./supabase.service");
const createUserSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    fullName: zod_1.z.string().min(2).max(120),
    role: zod_1.z.enum(['admin', 'medical', 'marketing', 'sales', 'viewer']),
    territory: zod_1.z.string().max(120).optional(),
});
const contentIdSchema = zod_1.z.string().uuid();
const brandIdSchema = zod_1.z.string().uuid();
const categoryIdSchema = zod_1.z.string().uuid();
const categorySchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(2).max(120),
    description: zod_1.z.string().trim().max(600).default(''),
    status: zod_1.z.enum(['active', 'archived']).default('active'),
    sortOrder: zod_1.z.coerce.number().int().min(0).max(9999).default(0),
});
const brandSchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(2).max(120),
    category: zod_1.z.string().trim().min(2).max(120),
    description: zod_1.z.string().trim().max(600).default(''),
    status: zod_1.z.enum(['active', 'archived']).default('active'),
    sortOrder: zod_1.z.coerce.number().int().min(0).max(9999).default(0),
});
const contentSchema = zod_1.z
    .object({
    title: zod_1.z.string().min(2).max(180),
    contentType: zod_1.z.enum([
        'product',
        'clinical',
        'academy',
        'media',
        'field_asset',
        'regulatory',
    ]),
    category: zod_1.z.string().min(2).max(120),
    productName: zod_1.z.string().max(160).optional(),
    brandId: zod_1.z.string().uuid().optional(),
    status: zod_1.z.enum(['draft', 'review', 'approved', 'archived']),
    description: zod_1.z.string().min(10).max(2000),
    metadata: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).default({}),
})
    .superRefine((payload, context) => {
    if (payload.contentType === 'clinical' &&
        !payload.brandId &&
        !payload.productName?.trim()) {
        context.addIssue({
            code: 'custom',
            path: ['brandId'],
            message: 'Clinical evidence must be tagged to a brand.',
        });
    }
});
const assetBucket = 'maypharm-admin-assets';
const maxUploadBytes = 50 * 1024 * 1024;
const maxLogoBytes = 2 * 1024 * 1024;
const allowedLogoMimeTypes = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
]);
const allowedMimeTypes = new Set([
    'application/pdf',
    'image/png',
    'image/jpeg',
    'video/mp4',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
function getStoragePath(contentType, title, originalName) {
    const extension = originalName.split('.').pop()?.toLowerCase() ?? 'bin';
    const safeName = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 80);
    return `${contentType}/${crypto.randomUUID()}-${safeName}.${extension}`;
}
function getLogoStoragePath(name, originalName) {
    const extension = originalName.split('.').pop()?.toLowerCase() ?? 'png';
    const safeName = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 60);
    return `brands/${crypto.randomUUID()}-${safeName}.${extension}`;
}
function collectMetadata(body) {
    return Object.fromEntries(Object.entries(body)
        .filter(([key, value]) => key.startsWith('metadata.') && value?.trim())
        .map(([key, value]) => [key.replace('metadata.', ''), value.trim()]));
}
let AdminController = class AdminController {
    supabase;
    constructor(supabase) {
        this.supabase = supabase;
    }
    async requireAdmin(authorization) {
        const user = await this.supabase.getUserFromBearer(authorization);
        await this.supabase.requireAdmin(user.id);
        return user;
    }
    async getBrandOrFail(brandId) {
        const { data, error } = await this.supabase.admin
            .from('brands')
            .select('id,name')
            .eq('id', brandId)
            .maybeSingle();
        if (error) {
            throw new common_1.BadRequestException(error.message);
        }
        if (!data) {
            throw new common_1.BadRequestException('Selected brand no longer exists.');
        }
        return data;
    }
    async uploadBrandLogo(name, logo) {
        if (logo.size > maxLogoBytes) {
            throw new common_1.BadRequestException('Logo must be 2 MB or smaller.');
        }
        if (!allowedLogoMimeTypes.has(logo.mimetype)) {
            throw new common_1.BadRequestException('Unsupported logo type. Upload a PNG, JPG, or WEBP image.');
        }
        const logoPath = getLogoStoragePath(name, logo.originalname);
        const { error } = await this.supabase.admin.storage
            .from(assetBucket)
            .upload(logoPath, logo.buffer, {
            contentType: logo.mimetype,
            upsert: false,
        });
        if (error) {
            throw new common_1.BadRequestException(error.message);
        }
        return logoPath;
    }
    async listContent(authorization, query) {
        await this.requireAdmin(authorization);
        const params = pagination_1.paginationSchema.parse(query);
        const { from, to } = (0, pagination_1.getRange)(params.page, params.pageSize);
        const { data, error, count } = await this.supabase.admin
            .from('content_items')
            .select('id,title,content_type,category,status,product_name,brand_id,storage_path,metadata,updated_at', { count: 'exact' })
            .order('updated_at', { ascending: false })
            .order('id', { ascending: false })
            .range(from, to);
        if (error) {
            throw error;
        }
        return {
            data: data ?? [],
            meta: (0, pagination_1.getMeta)(params.page, params.pageSize, count ?? 0),
        };
    }
    async getContent(authorization, id) {
        await this.requireAdmin(authorization);
        const contentId = contentIdSchema.parse(id);
        const { data, error } = await this.supabase.admin
            .from('content_items')
            .select('id,title,content_type,category,status,product_name,brand_id,description,storage_path,metadata,updated_at')
            .eq('id', contentId)
            .single();
        if (error) {
            throw new common_1.BadRequestException(error.message);
        }
        return { data };
    }
    async listUsers(authorization, query) {
        await this.requireAdmin(authorization);
        const params = pagination_1.paginationSchema.parse(query);
        const { from, to } = (0, pagination_1.getRange)(params.page, params.pageSize);
        const { data, error, count } = await this.supabase.admin
            .from('admin_profiles')
            .select('id,full_name,email,role,status,territory,created_at', {
            count: 'exact',
        })
            .order('created_at', { ascending: false })
            .range(from, to);
        if (error) {
            throw error;
        }
        return {
            data: data ?? [],
            meta: (0, pagination_1.getMeta)(params.page, params.pageSize, count ?? 0),
        };
    }
    async listAuditEvents(authorization, query) {
        await this.requireAdmin(authorization);
        const params = pagination_1.paginationSchema.parse(query);
        const { from, to } = (0, pagination_1.getRange)(params.page, params.pageSize);
        const { data, error, count } = await this.supabase.admin
            .from('audit_events')
            .select('id,actor_id,action,entity_type,entity_id,metadata,created_at', {
            count: 'exact',
        })
            .order('created_at', { ascending: false })
            .range(from, to);
        if (error) {
            throw error;
        }
        return {
            data: data ?? [],
            meta: (0, pagination_1.getMeta)(params.page, params.pageSize, count ?? 0),
        };
    }
    async createUser(authorization, body) {
        const actor = await this.requireAdmin(authorization);
        const payload = createUserSchema.parse(body);
        const { data, error } = await this.supabase.admin.auth.admin.createUser({
            email: payload.email,
            email_confirm: true,
            user_metadata: {
                full_name: payload.fullName,
                role: payload.role,
                territory: payload.territory ?? null,
            },
        });
        if (error) {
            throw error;
        }
        const { error: profileError } = await this.supabase.admin
            .from('admin_profiles')
            .upsert({
            id: data.user.id,
            email: payload.email,
            full_name: payload.fullName,
            role: payload.role,
            territory: payload.territory ?? null,
            status: 'invited',
            created_by: actor.id,
        });
        if (profileError) {
            throw profileError;
        }
        await this.supabase.admin.from('audit_events').insert({
            actor_id: actor.id,
            action: 'user.created',
            entity_type: 'admin_profiles',
            entity_id: data.user.id,
            metadata: payload,
        });
        return { id: data.user.id, email: data.user.email };
    }
    async createContent(authorization, body, asset) {
        const actor = await this.requireAdmin(authorization);
        const payload = contentSchema.parse({
            title: body.title,
            contentType: body.contentType,
            category: body.category,
            productName: body.productName || undefined,
            brandId: body.brandId || undefined,
            status: body.status,
            description: body.description,
            metadata: collectMetadata(body),
        });
        const brand = payload.brandId
            ? await this.getBrandOrFail(payload.brandId)
            : null;
        let storagePath = null;
        if (asset) {
            if (asset.size > maxUploadBytes) {
                throw new common_1.BadRequestException('File is larger than the 50 MB upload limit.');
            }
            if (!allowedMimeTypes.has(asset.mimetype)) {
                throw new common_1.BadRequestException('Unsupported file type. Upload PDF, PNG, JPG, MP4, CSV, or XLSX files.');
            }
            storagePath = getStoragePath(payload.contentType, payload.title, asset.originalname);
            const { error: uploadError } = await this.supabase.admin.storage
                .from(assetBucket)
                .upload(storagePath, asset.buffer, {
                contentType: asset.mimetype,
                upsert: false,
            });
            if (uploadError) {
                throw new common_1.BadRequestException(uploadError.message);
            }
        }
        const { data, error } = await this.supabase.admin
            .from('content_items')
            .insert({
            title: payload.title,
            content_type: payload.contentType,
            category: payload.category,
            product_name: payload.productName ?? brand?.name ?? null,
            brand_id: brand?.id ?? null,
            status: payload.status,
            description: payload.description,
            metadata: payload.metadata,
            storage_bucket: assetBucket,
            storage_path: storagePath,
            created_by: actor.id,
            updated_by: actor.id,
        })
            .select('id,title,content_type,category,status,product_name,brand_id,storage_path,metadata,updated_at')
            .single();
        if (error) {
            throw new common_1.BadRequestException(error.message);
        }
        await this.supabase.admin.from('audit_events').insert({
            actor_id: actor.id,
            action: 'content.created',
            entity_type: 'content_items',
            entity_id: data.id,
            metadata: {
                ...payload,
                fileName: asset?.originalname ?? null,
                fileSize: asset?.size ?? null,
                mimeType: asset?.mimetype ?? null,
                storagePath,
            },
        });
        return {
            data,
            message: storagePath
                ? 'Content record and private asset uploaded successfully.'
                : 'Content record saved without an asset.',
        };
    }
    async updateContent(authorization, id, body, asset) {
        const actor = await this.requireAdmin(authorization);
        const contentId = contentIdSchema.parse(id);
        const payload = contentSchema.parse({
            title: body.title,
            contentType: body.contentType,
            category: body.category,
            productName: body.productName || undefined,
            brandId: body.brandId || undefined,
            status: body.status,
            description: body.description,
            metadata: collectMetadata(body),
        });
        const brand = payload.brandId
            ? await this.getBrandOrFail(payload.brandId)
            : null;
        const { data: existing, error: existingError } = await this.supabase.admin
            .from('content_items')
            .select('storage_path')
            .eq('id', contentId)
            .single();
        if (existingError) {
            throw new common_1.BadRequestException(existingError.message);
        }
        const previousStoragePath = existing.storage_path;
        let storagePath = previousStoragePath;
        if (asset) {
            if (asset.size > maxUploadBytes) {
                throw new common_1.BadRequestException('File is larger than the 50 MB upload limit.');
            }
            if (!allowedMimeTypes.has(asset.mimetype)) {
                throw new common_1.BadRequestException('Unsupported file type. Upload PDF, PNG, JPG, MP4, CSV, or XLSX files.');
            }
            storagePath = getStoragePath(payload.contentType, payload.title, asset.originalname);
            const { error: uploadError } = await this.supabase.admin.storage
                .from(assetBucket)
                .upload(storagePath, asset.buffer, {
                contentType: asset.mimetype,
                upsert: false,
            });
            if (uploadError) {
                throw new common_1.BadRequestException(uploadError.message);
            }
        }
        const { data, error } = await this.supabase.admin
            .from('content_items')
            .update({
            title: payload.title,
            content_type: payload.contentType,
            category: payload.category,
            product_name: payload.productName ?? brand?.name ?? null,
            brand_id: brand?.id ?? null,
            status: payload.status,
            description: payload.description,
            metadata: payload.metadata,
            storage_path: storagePath,
            updated_by: actor.id,
            updated_at: new Date().toISOString(),
        })
            .eq('id', contentId)
            .select('id,title,content_type,category,status,product_name,brand_id,storage_path,metadata,updated_at')
            .single();
        if (error) {
            throw new common_1.BadRequestException(error.message);
        }
        await this.supabase.admin.from('audit_events').insert({
            actor_id: actor.id,
            action: 'content.updated',
            entity_type: 'content_items',
            entity_id: data.id,
            metadata: {
                ...payload,
                fileReplaced: Boolean(asset),
                fileName: asset?.originalname ?? null,
                fileSize: asset?.size ?? null,
                mimeType: asset?.mimetype ?? null,
                previousStoragePath,
                storagePath,
            },
        });
        return {
            data,
            message: asset
                ? 'Content record updated and asset replaced successfully.'
                : 'Content record updated successfully.',
        };
    }
    async listBrands(authorization, query) {
        await this.requireAdmin(authorization);
        const params = pagination_1.paginationSchema.parse(query);
        const { from, to } = (0, pagination_1.getRange)(params.page, params.pageSize);
        const { data, error, count } = await this.supabase.admin
            .from('brands')
            .select('id,name,slug,category,description,logo_path,status,sort_order,updated_at', { count: 'exact' })
            .order('sort_order', { ascending: true })
            .order('name', { ascending: true })
            .range(from, to);
        if (error) {
            throw error;
        }
        return {
            data: data ?? [],
            meta: (0, pagination_1.getMeta)(params.page, params.pageSize, count ?? 0),
        };
    }
    async getBrand(authorization, id) {
        await this.requireAdmin(authorization);
        const brandId = brandIdSchema.parse(id);
        const { data, error } = await this.supabase.admin
            .from('brands')
            .select('id,name,slug,category,description,logo_path,status,sort_order,updated_at')
            .eq('id', brandId)
            .maybeSingle();
        if (error) {
            throw new common_1.BadRequestException(error.message);
        }
        if (!data) {
            throw new common_1.BadRequestException('Brand not found.');
        }
        return { data };
    }
    async createBrand(authorization, body, logo) {
        const actor = await this.requireAdmin(authorization);
        const payload = brandSchema.parse({
            name: body.name,
            category: body.category,
            description: body.description ?? '',
            status: body.status || 'active',
            sortOrder: body.sortOrder || 0,
        });
        const logoPath = logo
            ? await this.uploadBrandLogo(payload.name, logo)
            : null;
        const { data, error } = await this.supabase.admin
            .from('brands')
            .insert({
            name: payload.name,
            category: payload.category,
            description: payload.description,
            status: payload.status,
            sort_order: payload.sortOrder,
            logo_bucket: assetBucket,
            logo_path: logoPath,
            created_by: actor.id,
            updated_by: actor.id,
        })
            .select('id,name,slug,category,description,logo_path,status,sort_order,updated_at')
            .single();
        if (error) {
            throw new common_1.BadRequestException(error.code === '23505'
                ? 'A brand with that name already exists.'
                : error.message);
        }
        await this.supabase.admin.from('audit_events').insert({
            actor_id: actor.id,
            action: 'brand.created',
            entity_type: 'brands',
            entity_id: data.id,
            metadata: { ...payload, logoPath },
        });
        return { data, message: `Brand ${payload.name} created.` };
    }
    async updateBrand(authorization, id, body, logo) {
        const actor = await this.requireAdmin(authorization);
        const brandId = brandIdSchema.parse(id);
        const payload = brandSchema.parse({
            name: body.name,
            category: body.category,
            description: body.description ?? '',
            status: body.status || 'active',
            sortOrder: body.sortOrder || 0,
        });
        const { data: existing, error: existingError } = await this.supabase.admin
            .from('brands')
            .select('logo_path')
            .eq('id', brandId)
            .maybeSingle();
        if (existingError) {
            throw new common_1.BadRequestException(existingError.message);
        }
        if (!existing) {
            throw new common_1.BadRequestException('Brand not found.');
        }
        const logoPath = logo
            ? await this.uploadBrandLogo(payload.name, logo)
            : existing.logo_path;
        const { data, error } = await this.supabase.admin
            .from('brands')
            .update({
            name: payload.name,
            category: payload.category,
            description: payload.description,
            status: payload.status,
            sort_order: payload.sortOrder,
            logo_path: logoPath,
            updated_by: actor.id,
        })
            .eq('id', brandId)
            .select('id,name,slug,category,description,logo_path,status,sort_order,updated_at')
            .single();
        if (error) {
            throw new common_1.BadRequestException(error.code === '23505'
                ? 'A brand with that name already exists.'
                : error.message);
        }
        await this.supabase.admin.from('audit_events').insert({
            actor_id: actor.id,
            action: 'brand.updated',
            entity_type: 'brands',
            entity_id: data.id,
            metadata: { ...payload, logoReplaced: Boolean(logo), logoPath },
        });
        return { data, message: `Brand ${payload.name} updated.` };
    }
    async listCategories(authorization, query) {
        await this.requireAdmin(authorization);
        const params = pagination_1.paginationSchema.parse(query);
        const { from, to } = (0, pagination_1.getRange)(params.page, params.pageSize);
        const { data, error, count } = await this.supabase.admin
            .from('categories')
            .select('id,name,slug,description,status,sort_order,updated_at', {
            count: 'exact',
        })
            .order('sort_order', { ascending: true })
            .order('name', { ascending: true })
            .range(from, to);
        if (error) {
            throw error;
        }
        return {
            data: data ?? [],
            meta: (0, pagination_1.getMeta)(params.page, params.pageSize, count ?? 0),
        };
    }
    async getCategory(authorization, id) {
        await this.requireAdmin(authorization);
        const categoryId = categoryIdSchema.parse(id);
        const { data, error } = await this.supabase.admin
            .from('categories')
            .select('id,name,slug,description,status,sort_order,updated_at')
            .eq('id', categoryId)
            .maybeSingle();
        if (error) {
            throw new common_1.BadRequestException(error.message);
        }
        if (!data) {
            throw new common_1.BadRequestException('Category not found.');
        }
        return { data };
    }
    async createCategory(authorization, body) {
        const actor = await this.requireAdmin(authorization);
        const payload = categorySchema.parse({
            name: body.name,
            description: body.description ?? '',
            status: body.status || 'active',
            sortOrder: body.sortOrder || 0,
        });
        const { data, error } = await this.supabase.admin
            .from('categories')
            .insert({
            name: payload.name,
            description: payload.description,
            status: payload.status,
            sort_order: payload.sortOrder,
            created_by: actor.id,
            updated_by: actor.id,
        })
            .select('id,name,slug,description,status,sort_order,updated_at')
            .single();
        if (error) {
            throw new common_1.BadRequestException(error.code === '23505'
                ? 'A category with that name already exists.'
                : error.message);
        }
        await this.supabase.admin.from('audit_events').insert({
            actor_id: actor.id,
            action: 'category.created',
            entity_type: 'categories',
            entity_id: data.id,
            metadata: payload,
        });
        return { data, message: `Category ${payload.name} created.` };
    }
    async updateCategory(authorization, id, body) {
        const actor = await this.requireAdmin(authorization);
        const categoryId = categoryIdSchema.parse(id);
        const payload = categorySchema.parse({
            name: body.name,
            description: body.description ?? '',
            status: body.status || 'active',
            sortOrder: body.sortOrder || 0,
        });
        const { data: existing, error: existingError } = await this.supabase.admin
            .from('categories')
            .select('name')
            .eq('id', categoryId)
            .maybeSingle();
        if (existingError) {
            throw new common_1.BadRequestException(existingError.message);
        }
        if (!existing) {
            throw new common_1.BadRequestException('Category not found.');
        }
        const { data, error } = await this.supabase.admin
            .from('categories')
            .update({
            name: payload.name,
            description: payload.description,
            status: payload.status,
            sort_order: payload.sortOrder,
            updated_by: actor.id,
        })
            .eq('id', categoryId)
            .select('id,name,slug,description,status,sort_order,updated_at')
            .single();
        if (error) {
            throw new common_1.BadRequestException(error.code === '23505'
                ? 'A category with that name already exists.'
                : error.message);
        }
        if (existing.name !== payload.name) {
            await this.supabase.admin
                .from('content_items')
                .update({ category: payload.name })
                .eq('category', existing.name);
            await this.supabase.admin
                .from('brands')
                .update({ category: payload.name })
                .eq('category', existing.name);
        }
        await this.supabase.admin.from('audit_events').insert({
            actor_id: actor.id,
            action: 'category.updated',
            entity_type: 'categories',
            entity_id: data.id,
            metadata: { ...payload, previousName: existing.name },
        });
        return { data, message: `Category ${payload.name} updated.` };
    }
};
exports.AdminController = AdminController;
__decorate([
    (0, common_1.Get)('content'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "listContent", null);
__decorate([
    (0, common_1.Get)('content/:id'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "getContent", null);
__decorate([
    (0, common_1.Get)('users'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "listUsers", null);
__decorate([
    (0, common_1.Get)('audit-events'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "listAuditEvents", null);
__decorate([
    (0, common_1.Post)('users'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "createUser", null);
__decorate([
    (0, common_1.Post)('content'),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('asset', {
        limits: { fileSize: maxUploadBytes, files: 1 },
    })),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "createContent", null);
__decorate([
    (0, common_1.Patch)('content/:id'),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('asset', {
        limits: { fileSize: maxUploadBytes, files: 1 },
    })),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "updateContent", null);
__decorate([
    (0, common_1.Get)('brands'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "listBrands", null);
__decorate([
    (0, common_1.Get)('brands/:id'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "getBrand", null);
__decorate([
    (0, common_1.Post)('brands'),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('logo', {
        limits: { fileSize: maxLogoBytes, files: 1 },
    })),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "createBrand", null);
__decorate([
    (0, common_1.Patch)('brands/:id'),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('logo', {
        limits: { fileSize: maxLogoBytes, files: 1 },
    })),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "updateBrand", null);
__decorate([
    (0, common_1.Get)('categories'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "listCategories", null);
__decorate([
    (0, common_1.Get)('categories/:id'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "getCategory", null);
__decorate([
    (0, common_1.Post)('categories'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "createCategory", null);
__decorate([
    (0, common_1.Patch)('categories/:id'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "updateCategory", null);
exports.AdminController = AdminController = __decorate([
    (0, common_1.Controller)('admin'),
    __metadata("design:paramtypes", [supabase_service_1.SupabaseService])
], AdminController);
//# sourceMappingURL=admin.controller.js.map