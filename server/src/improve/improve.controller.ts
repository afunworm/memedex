import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/auth.guard';
import type { AuthUser } from '../auth/auth.service';
import { ImproveMode, ImproveService } from './improve.service';

@Controller('api/memes')
export class ImproveController {
	constructor(private readonly improve: ImproveService) {}

	/** Look for / make better versions. Nothing is replaced until a candidate is accepted. */
	@Post('improve')
	start(@CurrentUser() user: AuthUser, @Body() body: { ids: number[]; mode?: string }, @Req() req: Request) {
		const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter((v) => Number.isInteger(v) && v > 0) : [];
		if (!ids.length || ids.length > 500) throw new BadRequestException('ids required');
		const mode = (['web', 'enhance', 'auto'] as const).find((m) => m === body?.mode) ?? 'auto';
		return { queued: this.improve.enqueue(user.sub, ids, mode as ImproveMode, ImproveService.baseUrl(req)) };
	}

	@Get(':id/candidates')
	list(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
		return this.improve.candidates(user.sub, id);
	}

	/** The user confirmed: replace the image with this version. */
	@Post(':id/candidates/:cid/accept')
	accept(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Param('cid', ParseIntPipe) cid: number) {
		return this.improve.accept(user.sub, id, cid);
	}

	@Delete(':id/candidates/:cid')
	discard(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Param('cid', ParseIntPipe) cid: number) {
		return this.improve.discard(user.sub, id, cid);
	}
}
