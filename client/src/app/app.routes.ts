import { Routes } from '@angular/router';
import { authGuard } from './auth.guard';

export const routes: Routes = [
	{ path: 'login', loadComponent: () => import('./pages/login').then((m) => m.LoginPage), title: 'Sign in · MemeDex' },
	{ path: 'callback', loadComponent: () => import('./pages/callback').then((m) => m.CallbackPage) },
	{
		path: '',
		canActivate: [authGuard],
		loadComponent: () => import('./pages/library').then((m) => m.LibraryPage),
		title: 'MemeDex',
	},
	{
		path: 'settings',
		canActivate: [authGuard],
		loadComponent: () => import('./pages/settings').then((m) => m.SettingsPage),
		title: 'Settings · MemeDex',
	},
	{
		path: 'duplicates',
		canActivate: [authGuard],
		loadComponent: () => import('./pages/duplicates').then((m) => m.DuplicatesPage),
		title: 'Duplicates · MemeDex',
	},
	{ path: '**', redirectTo: '' },
];
