import { Controller, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/auth.guard';
import { DbService } from '../db/db.service';
import { ImageKind, ImageStore } from './image-store.service';

/**
 * Serves images by signed URL (see ImageStore.signedUrl), so plain <img> tags
 * work without the bearer token while each user's images stay private.
 */
@Controller('api/img')
export class ImagesController {
	constructor(
		private readonly dbs: DbService,
		private readonly images: ImageStore,
	) {}

	@Public()
	@Get(':id/:kind')
	serve(
		@Param('id', ParseIntPipe) id: number,
		@Param('kind') kind: string,
		@Query('e') e: string,
		@Query('s') s: string,
		@Res() res: Response,
	) {
		if (kind !== 'full' && kind !== 'thumb') throw new NotFoundException();
		const r = this.dbs.db.prepare(`SELECT user_sub, sha256, ext, mime FROM memes WHERE id = ?`).get(id) as
			| { user_sub: string; sha256: string; ext: string; mime: string }
			| undefined;
		if (!r) throw new NotFoundException();
		if (!this.images.verify(id, r.sha256, kind as ImageKind, Number(e), String(s ?? ''))) {
			throw new ForbiddenException('Link expired');
		}
		const path = kind === 'full' ? this.images.fullPath(r.user_sub, r.sha256, r.ext) : this.images.thumbPath(r.user_sub, r.sha256);
		res.setHeader('Cache-Control', 'private, max-age=21600, immutable');
		res.type(kind === 'full' ? r.mime : 'image/webp');
		res.sendFile(path, (err) => {
			if (err && !res.headersSent) res.status(404).end();
		});
	}
}
