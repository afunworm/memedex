import { Controller, Get, Header } from '@nestjs/common';
import { Public } from './auth/auth.guard';
import { OIDC_CLIENT_ID, OIDC_ISSUER } from './config';

/**
 * The browser's runtime settings, from the server env. Replaces App Portal's
 * nginx envsubst step: one image works for any OIDC provider.
 */
@Controller()
export class EnvController {
	@Public()
	@Get('env.js')
	@Header('Content-Type', 'application/javascript; charset=utf-8')
	@Header('Cache-Control', 'no-cache')
	env() {
		const env = { oidcIssuer: OIDC_ISSUER, oidcClientId: OIDC_CLIENT_ID };
		return `window.__env = ${JSON.stringify(env)};`;
	}

	@Public()
	@Get('api/health')
	health() {
		return { ok: true };
	}
}
