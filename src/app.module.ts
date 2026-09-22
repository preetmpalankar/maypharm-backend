import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdminController } from './admin.controller';
import { BrandsController } from './brands.controller';
import { CategoriesController } from './categories.controller';
import { ContentController } from './content.controller';
import { SupabaseService } from './supabase.service';

@Module({
  imports: [],
  controllers: [
    AppController,
    AdminController,
    BrandsController,
    CategoriesController,
    ContentController,
  ],
  providers: [AppService, SupabaseService],
})
export class AppModule {}
