import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { map } from 'rxjs';
import { Toasts } from './toast';

@Component({
	selector: 'app-root',
	imports: [RouterOutlet, RouterLink, RouterLinkActive],
	template: `
		@if (signedIn()) {
			<header class="sticky top-0 z-30 border-b border-zinc-800/80 bg-zinc-950/85 backdrop-blur">
				<div class="mx-auto flex h-14 max-w-7xl items-center gap-1 px-4 sm:gap-2">
					<a routerLink="/" class="mr-auto flex items-center gap-2">
						<img src="favicon.svg" alt="" class="size-7" />
						<span class="font-display text-xl font-extrabold tracking-tight">Meme<span class="text-amber-400">Dex</span></span>
					</a>
					<a routerLink="/" routerLinkActive="!text-zinc-50 bg-zinc-800" [routerLinkActiveOptions]="{ exact: true }" class="btn-ghost hidden sm:inline-flex">Library</a>
					<a routerLink="/settings" routerLinkActive="!text-zinc-50 bg-zinc-800" class="btn-ghost whitespace-nowrap px-2.5 sm:px-3.5">Settings</a>
					<button type="button" class="btn-ghost whitespace-nowrap px-2.5 sm:px-3.5" (click)="logout()">Sign out</button>
				</div>
			</header>
		}
		<router-outlet />

		<div class="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
			@for (t of toasts.items(); track t.id) {
				<button
					type="button"
					(click)="toasts.dismiss(t.id)"
					class="pointer-events-auto max-w-sm rounded-lg px-4 py-2.5 text-left text-sm font-medium shadow-lg shadow-black/40"
					[class]="t.tone === 'error' ? 'bg-red-600 text-white' : 'bg-zinc-100 text-zinc-900'"
				>
					{{ t.text }}
				</button>
			}
		</div>
	`,
})
export class App {
	private readonly oidc = inject(OidcSecurityService);
	protected readonly toasts = inject(Toasts);
	protected readonly signedIn = toSignal(this.oidc.isAuthenticated$.pipe(map((a) => a.isAuthenticated)), {
		initialValue: false,
	});

	logout() {
		this.oidc.logoffAndRevokeTokens().subscribe();
	}
}
