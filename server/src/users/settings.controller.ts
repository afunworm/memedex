import { BadRequestException, Body, Controller, Get, Post, Put } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.guard';
import type { AuthUser } from '../auth/auth.service';
import { UsersService } from './users.service';
import { ClaudeError, ClaudeService } from '../ai/claude.service';

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

	/** apiKey: a new key, '' to remove it, or left out to keep the saved one. */
	@Put('settings')
	save(@CurrentUser() user: AuthUser, @Body() body: { apiKey?: string; model?: string }) {
		if (body.apiKey !== undefined) {
			const key = String(body.apiKey).trim();
			if (key && !/^sk-ant-[\w-]{20,}$/.test(key)) throw new BadRequestException("That doesn't look like a Claude API key (sk-ant-...)");
			this.users.saveApiKey(user.sub, key || null);
		}
		if (body.model !== undefined) this.users.saveModel(user.sub, String(body.model));
		return this.users.settings(user.sub);
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
