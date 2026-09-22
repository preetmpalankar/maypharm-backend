"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const app_controller_1 = require("./app.controller");
const app_service_1 = require("./app.service");
const admin_controller_1 = require("./admin.controller");
const brands_controller_1 = require("./brands.controller");
const categories_controller_1 = require("./categories.controller");
const content_controller_1 = require("./content.controller");
const supabase_service_1 = require("./supabase.service");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [],
        controllers: [
            app_controller_1.AppController,
            admin_controller_1.AdminController,
            brands_controller_1.BrandsController,
            categories_controller_1.CategoriesController,
            content_controller_1.ContentController,
        ],
        providers: [app_service_1.AppService, supabase_service_1.SupabaseService],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map