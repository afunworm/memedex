import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { map, take } from 'rxjs';

export const authGuard: CanActivateFn = (_route, state) => {
	const router = inject(Router);
	return inject(OidcSecurityService).isAuthenticated$.pipe(
		take(1),
		map(({ isAuthenticated }) => {
			if (isAuthenticated) return true;
			sessionStorage.setItem('auth_redirect', state.url);
			return router.parseUrl('/login');
		}),
	);
};
