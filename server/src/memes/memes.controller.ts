import {
	BadRequestException,
	Body,
	Controller,
	Delete,
	Get,
	Param,
	ParseIntPipe,
	Patch,
	Post,
	Query,
	UploadedFiles,
	UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/auth.guard';
import type { AuthUser } from '../auth/auth.service';
import { MAX_UPLOAD_BYTES } from '../config';
import { MemesService } from './memes.service';
import type { MemeEdit } from './memes.service';
import { AiQueueService } from '../ai/ai-queue.service';

function ids(value: unknown): number[] {
	if (!Array.isArray(value) || !value.length || value.length > 500) throw new BadRequestException('ids required');
	return value.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0);
}

@Controller('api/memes')
export class MemesController {
	constructor(
		private readonly memes: MemesService,
		private readonly queue: AiQueueService,
	) {}

	@Get()
	list(
		@CurrentUser() user: AuthUser,
		@Query('offset') offset = '0',
		@Query('limit') limit = '60',
		@Query('tag') tag?: string,
		@Query('undescribed') undescribed?: string,
	) {
		return this.memes.list(user.sub, {
			offset: Math.max(0, Number(offset) || 0),
			limit: Math.min(200, Math.max(1, Number(limit) || 60)),
			tag: tag || undefined,
			undescribed: undescribed === '1',
		});
	}

	@Get('tags')
	tags(@CurrentUser() user: AuthUser) {
		return this.memes.tags(user.sub);
	}

	/** Current state of some memes (the page polls this while AI jobs run). */
	@Post('lookup')
	lookup(@CurrentUser() user: AuthUser, @Body() body: { ids: number[] }) {
		return this.memes.dtos(user.sub, ids(body?.ids));
	}

	@Get(':id')
	get(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
		this.memes.row(user.sub, id);
		return this.memes.dtos(user.sub, [id])[0];
	}

	@Post()
	@UseInterceptors(FilesInterceptor('files', 100, { limits: { fileSize: MAX_UPLOAD_BYTES } }))
	upload(@CurrentUser() user: AuthUser, @UploadedFiles() files: Express.Multer.File[]) {
		if (!files?.length) throw new BadRequestException('No files');
		return this.memes.upload(user.sub, files);
	}

	@Patch(':id')
	update(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() body: MemeEdit) {
		const edit: MemeEdit = {};
		if (body.title !== undefined) edit.title = body.title === null ? null : String(body.title);
		if (body.descriptions !== undefined) {
			if (!Array.isArray(body.descriptions)) throw new BadRequestException('descriptions must be a list');
			edit.descriptions = body.descriptions.map(String);
		}
		if (body.tags !== undefined) {
			if (!Array.isArray(body.tags)) throw new BadRequestException('tags must be a list');
			edit.tags = body.tags.map(String);
		}
		return this.memes.update(user.sub, id, edit);
	}

	/** Queue "AI generate tags & descriptions" for one or more memes. */
	@Post('ai')
	ai(@CurrentUser() user: AuthUser, @Body() body: { ids: number[] }) {
		return { queued: this.queue.enqueue(user.sub, ids(body?.ids)) };
	}

	@Post('delete')
	async remove(@CurrentUser() user: AuthUser, @Body() body: { ids: number[] }) {
		await this.memes.remove(user.sub, ids(body?.ids));
		return { ok: true };
	}

	@Delete(':id')
	async removeOne(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
		await this.memes.remove(user.sub, [id]);
		return { ok: true };
	}
}
