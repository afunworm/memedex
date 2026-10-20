import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Post,
	Query,
	UploadedFile,
	UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/auth.guard';
import type { AuthUser } from '../auth/auth.service';
import { MAX_UPLOAD_BYTES } from '../config';
import { MemesService } from '../memes/memes.service';
import { SearchService } from './search.service';
import { AskKind, ClaudeError, ClaudeService } from '../ai/claude.service';
import { ImageStore } from '../images/image-store.service';

/** How many search results Claude looks at when picking replies. */
const PICK_FROM = 16;

@Controller('api')
export class SearchController {
	constructor(
		private readonly search: SearchService,
		private readonly memes: MemesService,
		private readonly claude: ClaudeService,
		private readonly images: ImageStore,
	) {}

	/** Find a reaction: hybrid search, no AI call. */
	@Get('search')
	async find(@CurrentUser() user: AuthUser, @Query('q') q = '') {
		if (!q.trim()) return { items: [] };
		const hits = await this.search.search(user.sub, [q.slice(0, 500)]);
		const dtos = this.memes.dtos(user.sub, hits.map((h) => h.memeId));
		return { items: dtos.map((m, i) => ({ ...m, matched: hits[i].matched })) };
	}

	/**
	 * Reply to a message (text and/or a screenshot), or react to a described
	 * situation: Claude works out what the meme should express, those phrases
	 * are searched, and Claude picks the best fits from the results.
	 */
	@Post('respond')
	@UseInterceptors(FileInterceptor('image', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
	async respond(
		@CurrentUser() user: AuthUser,
		@Body() body: { text?: string; kind?: string },
		@UploadedFile() file?: Express.Multer.File,
	) {
		const text = (body?.text ?? '').trim().slice(0, 4000);
		const kind: AskKind = body?.kind === 'situation' ? 'situation' : 'message';
		if (!text && !file) {
			throw new BadRequestException(kind === 'situation' ? 'Describe the situation first' : 'Enter a message or attach a screenshot');
		}

		try {
			const shot = file ? await this.images.forClaude(file.buffer).catch(() => null) : null;
			if (file && !shot) throw new BadRequestException('The attachment is not a readable image');

			const analysis = await this.claude.analyze(user.sub, kind, text, shot);
			const hits = await this.search.search(user.sub, [...analysis.reactions, ...analysis.keywords, text].filter(Boolean), 40);
			const candidates = this.memes.dtos(user.sub, hits.slice(0, PICK_FROM).map((h) => h.memeId));
			if (!candidates.length) return { analysis, picks: [], more: [] };

			const withImages = await Promise.all(
				candidates.map(async (c) => {
					const r = this.memes.row(user.sub, c.id);
					const image = await this.images.forClaude(this.images.thumbPath(user.sub, r.sha256)).catch(() => null);
					return { id: c.id, title: c.title, descriptions: c.descriptions.map((d) => d.text), tags: c.tags, image };
				}),
			);
			const picks = await this.claude.pick(user.sub, { kind, text, summary: analysis.summary }, withImages);
			const picked = new Set(picks.map((p) => p.id));
			const byId = new Map(candidates.map((c) => [c.id, c]));
			const rest = hits.filter((h) => !picked.has(h.memeId)).map((h) => h.memeId);
			return {
				analysis,
				picks: picks.map((p) => ({ ...byId.get(p.id)!, reason: p.reason })),
				more: this.memes.dtos(user.sub, rest),
			};
		} catch (e) {
			if (e instanceof ClaudeError) throw new BadRequestException(e.message);
			throw e;
		}
	}
}
