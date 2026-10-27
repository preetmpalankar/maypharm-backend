import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AdminBrandsController } from './admin/admin-brands.controller';
import { AdminCategoriesController } from './admin/admin-categories.controller';
import { AdminContentController } from './admin/admin-content.controller';
import { AdminInsightsController } from './admin/admin-insights.controller';
import { AdminUploadsController } from './admin/admin-uploads.controller';
import { AdminUsersController } from './admin/admin-users.controller';
import { AppController } from './app.controller';
import { AssistantController } from './assistant/assistant.controller';
import { AssistantService } from './assistant/assistant.service';
import { RetrievalService } from './assistant/retrieval.service';
import { AuditService } from './audit/audit.service';
import { AuthService } from './auth/auth.service';
import { BookmarksController } from './bookmarks.controller';
import { BrandsController } from './brands.controller';
import { CategoriesController } from './categories.controller';
import { AccountThrottlerGuard } from './common/account-throttler.guard';
import { ContentController } from './content.controller';
import { EmbeddingsService } from './knowledge/embeddings.service';
import { GraphExtractionService } from './knowledge/graph-extraction.service';
import { KnowledgeIndexerService } from './knowledge/knowledge-indexer.service';
import { KnowledgeWorkerService } from './knowledge/knowledge-worker.service';
import { AssetStorageService } from './storage/asset-storage.service';
import { ContentFilesService } from './storage/content-files.service';
import { UploadSweeperService } from './storage/upload-sweeper.service';
import { SupabaseService } from './supabase.service';

@Module({
  imports: [
    // Generous by default: a single video view is many range requests.
    // Sensitive endpoints tighten this with @Throttle.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 1200 }]),
  ],
  controllers: [
    AppController,
    ContentController,
    BrandsController,
    CategoriesController,
    BookmarksController,
    AssistantController,
    AdminContentController,
    AdminBrandsController,
    AdminCategoriesController,
    AdminUsersController,
    AdminUploadsController,
    AdminInsightsController,
  ],
  providers: [
    SupabaseService,
    AuthService,
    AuditService,
    AssetStorageService,
    ContentFilesService,
    UploadSweeperService,
    EmbeddingsService,
    GraphExtractionService,
    KnowledgeIndexerService,
    KnowledgeWorkerService,
    RetrievalService,
    AssistantService,
    { provide: APP_GUARD, useClass: AccountThrottlerGuard },
  ],
})
export class AppModule {}
