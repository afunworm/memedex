import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.guard';
import type { AuthUser } from '../auth/auth.service';
import { SimilarService } from './similar.service';

@Controller('api/memes')
export class SimilarController {
	constructor(private readonly similar: SimilarService) {}

	/** "More like this": by=meaning (same vibe) or by=look (same template / character / scene). */
	@Get(':id/similar')
	find(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Query('by') by?: string) {
		return this.similar.find(user.sub, id, by === 'look' ? 'look' : 'meaning');
	}
}
