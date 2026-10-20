import { BadRequestException, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { ImageStore } from '../images/image-store.service';
import { MemeRow, MemesService } from '../memes/memes.service';
import { ClaudeService } from './claude.service';
import { UsersService } from '../users/users.service';

/** How many images are described at once (across all users). */
const CONCURRENCY = 3;

/**
 * Background queue for "AI generate tags & descriptions". The state lives in
 * memes.ai_status (queued / running / done / error), so the page can poll it
 * and a restart picks up where it left off.
 */
@Injectable()
export class AiQueueService implements OnApplicationBootstrap {
	private readonly logger = new Logger('AI queue');
	private readonly pending: { sub: string; id: number }[] = [];
	private running = 0;

	constructor(
		private readonly dbs: DbService,
		private readonly memes: MemesService,
		private readonly images: ImageStore,
		private readonly claude: ClaudeService,
		private readonly users: UsersService,
	) {}

	onApplicationBootstrap() {
		const rows = this.dbs.db
			.prepare(`SELECT id, user_sub FROM memes WHERE ai_status IN ('queued', 'running') ORDER BY id`)
			.all() as { id: number; user_sub: string }[];
		for (const r of rows) this.pending.push({ sub: r.user_sub, id: r.id });
		if (rows.length) this.logger.log(`Resuming ${rows.length} queued image(s)`);
		this.memes.embedAllMissing().catch(() => undefined);
		this.pump();
	}

	enqueue(sub: string, ids: number[]): number[] {
		if (!this.users.apiKey(sub)) throw new BadRequestException('Add your Claude API key in Settings first');
		const queued: number[] = [];
		for (const id of ids) {
			const r = this.memes.row(sub, id);
			if (r.ai_status === 'queued' || r.ai_status === 'running') continue;
			this.memes.setAiStatus(id, 'queued');
			this.pending.push({ sub, id });
			queued.push(id);
		}
		this.pump();
		return queued;
	}

	private pump() {
		while (this.running < CONCURRENCY && this.pending.length) {
			const job = this.pending.shift()!;
			this.running++;
			this.run(job.sub, job.id).finally(() => {
				this.running--;
				this.pump();
			});
		}
	}

	private async run(sub: string, id: number) {
		let r: MemeRow;
		try {
			r = this.memes.row(sub, id);
		} catch {
			return; // deleted while queued
		}
		this.memes.setAiStatus(id, 'running');
		try {
			const image = await this.images.forClaude(this.images.fullPath(sub, r.sha256, r.ext));
			const current = this.memes.dtos(sub, [id])[0];
			const suggestion = await this.claude.describe(sub, image, {
				descriptions: current.descriptions.map((d) => d.text),
				tags: current.tags,
			});
			await this.memes.applyAi(sub, id, suggestion);
		} catch (e: any) {
			const message = e?.response?.message ?? e?.message ?? 'Failed';
			this.memes.setAiStatus(id, 'error', String(message).slice(0, 500));
			this.logger.warn(`Meme ${id}: ${message}`);
		}
	}
}
