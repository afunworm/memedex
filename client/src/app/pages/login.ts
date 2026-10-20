import { Component, inject } from '@angular/core';
import { OidcSecurityService } from 'angular-auth-oidc-client';

@Component({
	selector: 'app-login',
	template: `
		<main class="grid min-h-dvh place-items-center px-4">
			<div class="w-full max-w-sm text-center">
				<img src="favicon.svg" alt="" class="mx-auto size-20 -rotate-6 drop-shadow-[0_8px_30px_rgba(251,191,36,0.35)]" />
				<h1 class="mt-6 font-display text-5xl font-extrabold tracking-tight">Meme<span class="text-amber-400">Dex</span></h1>
				<p class="mt-3 text-zinc-400">Your reaction images, findable in seconds.</p>
				<button type="button" class="btn-primary mt-8 w-full py-3 text-base" (click)="login()">Sign in</button>
			</div>
		</main>
	`,
})
export class LoginPage {
	private readonly oidc = inject(OidcSecurityService);

	login() {
		this.oidc.authorize();
	}
}
