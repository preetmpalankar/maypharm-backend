"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.paginationSchema = void 0;
exports.getRange = getRange;
exports.getMeta = getMeta;
const zod_1 = require("zod");
exports.paginationSchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    pageSize: zod_1.z.coerce.number().int().min(1).max(50).default(20),
});
function getRange(page, pageSize) {
    const from = (page - 1) * pageSize;
    return { from, to: from + pageSize - 1 };
}
function getMeta(page, pageSize, total) {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    return {
        page,
        pageSize,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
    };
}
//# sourceMappingURL=pagination.js.map