import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DbService } from './db/db.service';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './auth/auth.guard';
import { UsersService } from './users/users.service';
import { SettingsController } from './users/settings.controller';
import { ImageStore } from './images/image-store.service';
import { ImagesController } from './images/images.controller';
import { EmbeddingService } from './search/embedding.service';
import { VectorIndex } from './search/vector-index.service';
import { SearchService } from './search/search.service';
import { SearchController } from './search/search.controller';
import { MemesService } from './memes/memes.service';
import { MemesController } from './memes/memes.controller';
import { ClaudeService } from './ai/claude.service';
import { AiQueueService } from './ai/ai-queue.service';
import { EnvController } from './env.controller';
import { DuplicatesService } from './duplicates/duplicates.service';
import { DuplicatesController } from './duplicates/duplicates.controller';
import { UpscalerService } from './improve/upscaler.service';
import { ImproveService } from './improve/improve.service';
import { ImproveController } from './improve/improve.controller';
import { ImageEmbeddingService } from './search/image-embedding.service';
import { SimilarService } from './search/similar.service';
import { SimilarController } from './search/similar.controller';

@Module({
	controllers: [EnvController, SettingsController, ImagesController, MemesController, SearchController, DuplicatesController, ImproveController, SimilarController],
	providers: [
		DbService,
		AuthService,
		UsersService,
		ImageStore,
		EmbeddingService,
		VectorIndex,
		SearchService,
		MemesService,
		ClaudeService,
		AiQueueService,
		DuplicatesService,
		UpscalerService,
		ImproveService,
		ImageEmbeddingService,
		SimilarService,
		{ provide: APP_GUARD, useClass: AuthGuard },
	],
})
export class AppModule {}
