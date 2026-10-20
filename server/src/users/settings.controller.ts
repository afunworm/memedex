import { BadRequestException, Body, Controller, Get, Post, Put } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.guard';
import type { AuthUser } from '../auth/auth.service';
import { UsersService } from './users.service';
import { ClaudeError, ClaudeService } from '../ai/claude.service';
import { ReverseSearchError, testSearchKey } from '../improve/reverse-search';

@Controller('api')
export class SettingsController {
	constructor(
		private readonly users: UsersService,
		private readonly claude: ClaudeService,
	) {}

	@Get('me')
	me(@CurrentUser() user: AuthUser) {
		return { sub: user.sub, name: user.name, email: user.email, ...this.users.settings(user.sub) };
	}

	@Get('settings')
	get(@CurrentUser() user: AuthUser) {
		return this.users.settings(user.sub);
	}

	/** apiKey / searchApiKey: a new key, '' to remove it, or left out to keep the saved one. */
	@Put('settings')
	save(
		@CurrentUser() user: AuthUser,
		@Body() body: { apiKey?: string; model?: string; searchProvider?: string; searchApiKey?: string },
	) {
		if (body.apiKey !== undefined) {
			const key = String(body.apiKey).trim();
			if (key && !/^sk-ant-[\w-]{20,}$/.test(key)) throw new BadRequestException("That doesn't look like a Claude API key (sk-ant-...)");
			this.users.saveApiKey(user.sub, key || null);
		}
		if (body.model !== undefined) this.users.saveModel(user.sub, String(body.model));
		if (body.searchProvider !== undefined || body.searchApiKey !== undefined) {
			const key = body.searchApiKey === undefined ? undefined : String(body.searchApiKey).trim() || null;
			if (key && key.length > 500) throw new BadRequestException('That key is too long');
			this.users.saveSearch(user.sub, body.searchProvider === undefined ? undefined : String(body.searchProvider), key);
		}
		return this.users.settings(user.sub);
	}

	@Post('settings/test-search')
	async testSearch(@CurrentUser() user: AuthUser) {
		const search = this.users.search(user.sub);
		if (!search) return { ok: false, error: 'Choose a search service and save its API key first' };
		try {
			return { ok: true, message: await testSearchKey(search.provider, search.apiKey) };
		} catch (e) {
			return { ok: false, error: e instanceof ReverseSearchError ? e.message : 'Could not reach the search service' };
		}
	}

	@Post('settings/test')
	async test(@CurrentUser() user: AuthUser) {
		try {
			return { ok: true, model: await this.claude.test(user.sub) };
		} catch (e) {
			if (e instanceof ClaudeError) return { ok: false, error: e.message };
			throw e;
		}
	}
}
