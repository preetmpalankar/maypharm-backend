"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const app_module_1 = require("./app.module");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    app.enableCors({
        origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
            .split(',')
            .map((origin) => origin.trim()),
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['authorization', 'content-type'],
        credentials: true,
    });
    await app.listen(process.env.PORT ?? 3000, process.env.HOST ?? '127.0.0.1');
}
void bootstrap();
//# sourceMappingURL=main.js.map