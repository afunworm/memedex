import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.guard';
import type { AuthUser } from '../auth/auth.service';
import { MemesService } from '../memes/memes.service';
import { DuplicatesService } from './duplicates.service';

function ids(value: unknown, min: number): number[] {
	const list = Array.isArray(value) ? value.map(Number).filter((v) => Number.isInteger(v) && v > 0) : [];
	if (list.length < min || list.length > 200) throw new BadRequestException('ids required');
	return list;
}

@Controller('api/duplicates')
export class DuplicatesController {
	constructor(
		private readonly duplicates: DuplicatesService,
		private readonly memes: MemesService,
	) {}

	@Get()
	find(@CurrentUser() user: AuthUser) {
		return this.duplicates.find(user.sub);
	}

	/** Keep one, move the others' descriptions and tags onto it, delete the others. */
	@Post('merge')
	merge(@CurrentUser() user: AuthUser, @Body() body: { keepId: number; removeIds: number[] }) {
		const keepId = Number(body?.keepId);
		if (!Number.isInteger(keepId)) throw new BadRequestException('keepId required');
		return this.memes.mergeInto(user.sub, keepId, ids(body?.removeIds, 1));
	}

	@Post('ignore')
	ignore(@CurrentUser() user: AuthUser, @Body() body: { ids: number[] }) {
		this.duplicates.ignore(user.sub, ids(body?.ids, 2));
		return { ok: true };
	}
}
