import { ApplicationConfig, provideAppInitializer, provideBrowserGlobalErrorListeners, inject } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
	AbstractSecurityStorage,
	DefaultLocalStorageService,
	LogLevel,
	OidcSecurityService,
	authInterceptor,
	provideAuth,
} from 'angular-auth-oidc-client';
import { firstValueFrom } from 'rxjs';
import { routes } from './app.routes';
import { env } from './env';

export const appConfig: ApplicationConfig = {
	providers: [
		provideBrowserGlobalErrorListeners(),
		provideRouter(routes, withComponentInputBinding()),
		// Same sign-in as App Portal: authorization code + PKCE in the browser
		// (public client, no secret); the token goes to /api/ as a Bearer header.
		provideAuth({
			config: {
				authority: env.oidcIssuer,
				clientId: env.oidcClientId,
				redirectUrl: window.location.origin + '/callback',
				postLogoutRedirectUri: window.location.origin,
				scope: 'openid profile email offline_access',
				responseType: 'code',
				silentRenew: true,
				useRefreshToken: true,
				renewTimeBeforeTokenExpiresInSeconds: 30,
				logLevel: LogLevel.Warn,
				secureRoutes: ['/api/'],
			},
		}),
		provideHttpClient(withInterceptors([authInterceptor()])),
		{ provide: AbstractSecurityStorage, useClass: DefaultLocalStorageService },
		provideAppInitializer(() => firstValueFrom(inject(OidcSecurityService).checkAuth())),
	],
};
