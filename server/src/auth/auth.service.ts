import { Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { OIDC_CLIENT_ID, OIDC_ISSUER } from '../config';

export interface AuthUser {
	sub: string;
	name: string | null;
	email: string | null;
}

/**
 * Same model as App Portal: the browser signs in with authorization code +
 * PKCE (public client, no secret) and sends the access token as a Bearer
 * header; the server only verifies it against the issuer's signing keys.
 */
@Injectable()
export class AuthService implements OnModuleInit {
	private readonly logger = new Logger('Auth');
	private jwks!: ReturnType<typeof createRemoteJWKSet>;
	private userInfoEndpoint: string | null = null;
	/** Profile per subject, so userinfo isn't fetched on every request. */
	private readonly profiles = new Map<string, { name: string | null; email: string | null; at: number }>();

	async onModuleInit() {
		if (!OIDC_ISSUER || !OIDC_CLIENT_ID) {
			throw new Error('OIDC_ISSUER and OIDC_CLIENT_ID must be set');
		}
		const r = await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`);
		if (!r.ok) throw new Error(`OIDC discovery failed (${r.status})`);
		const discovery = await r.json();
		this.jwks = createRemoteJWKSet(new URL(discovery.jwks_uri ?? `${OIDC_ISSUER}/.well-known/jwks.json`));
		this.userInfoEndpoint = discovery.userinfo_endpoint ?? null;
		this.logger.log(`Using OIDC issuer ${OIDC_ISSUER}`);
	}

	async verify(token: string): Promise<AuthUser> {
		const { payload } = await jwtVerify(token, this.jwks, { issuer: OIDC_ISSUER });

		// Pocket ID marks access tokens with type = oauth-access-token; reject ID tokens etc.
		if (payload.type !== undefined && payload.type !== 'oauth-access-token') {
			throw new UnauthorizedException('not_an_access_token');
		}
		const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
		if (!aud.includes(OIDC_CLIENT_ID)) throw new UnauthorizedException('bad_audience');
		if (!payload.sub) throw new UnauthorizedException('no_subject');

		return { sub: payload.sub, ...(await this.profile(token, payload)) };
	}

	private async profile(token: string, payload: JWTPayload) {
		const cached = this.profiles.get(payload.sub!);
		if (cached && Date.now() - cached.at < 15 * 60_000) return cached;

		let name = (payload.name as string) ?? (payload.preferred_username as string) ?? null;
		let email = (payload.email as string) ?? null;
		if ((!name || !email) && this.userInfoEndpoint) {
			try {
				const r = await fetch(this.userInfoEndpoint, { headers: { Authorization: `Bearer ${token}` } });
				if (r.ok) {
					const info = await r.json();
					name = name ?? info.name ?? info.preferred_username ?? null;
					email = email ?? info.email ?? null;
				}
			} catch {
				/* the profile is cosmetic; keep going without it */
			}
		}
		const p = { name, email, at: Date.now() };
		this.profiles.set(payload.sub!, p);
		return p;
	}
}
