import { Component, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { take } from 'rxjs';

/** Where the OIDC provider sends the browser back; checkAuth() (app init) has handled the code. */
@Component({
	selector: 'app-callback',
	template: `<p class="p-8 text-center text-zinc-400">Signing you in…</p>`,
})
export class CallbackPage implements OnInit {
	private readonly oidc = inject(OidcSecurityService);
	private readonly router = inject(Router);

	ngOnInit() {
		this.oidc.isAuthenticated$.pipe(take(1)).subscribe(({ isAuthenticated }) => {
			const target = sessionStorage.getItem('auth_redirect') || '/';
			sessionStorage.removeItem('auth_redirect');
			this.router.navigateByUrl(isAuthenticated ? target : '/login', { replaceUrl: true });
		});
	}
}
