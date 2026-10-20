import {
	CanActivate,
	createParamDecorator,
	ExecutionContext,
	Injectable,
	SetMetadata,
	UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService, AuthUser } from './auth.service';
import { UsersService } from '../users/users.service';

const PUBLIC = 'memedex:public';
/** Skips the bearer-token check (for signed image URLs and env.js). */
export const Public = () => SetMetadata(PUBLIC, true);

/** The signed-in user (set by AuthGuard). */
export const CurrentUser = createParamDecorator(
	(_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

@Injectable()
export class AuthGuard implements CanActivate {
	constructor(
		private readonly auth: AuthService,
		private readonly users: UsersService,
		private readonly reflector: Reflector,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [context.getHandler(), context.getClass()])) {
			return true;
		}
		const req = context.switchToHttp().getRequest();
		const res = context.switchToHttp().getResponse();
		const header = (req.headers['authorization'] as string) || '';
		const token = header.startsWith('Bearer ') ? header.slice(7) : null;
		if (!token) throw new UnauthorizedException('missing_token');

		try {
			req.user = await this.auth.verify(token);
		} catch {
			res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
			throw new UnauthorizedException('invalid_or_expired_token');
		}
		this.users.touch(req.user);
		return true;
	}
}
