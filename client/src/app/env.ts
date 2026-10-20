/** Runtime settings from the server's /env.js (loaded before the app in index.html). */
interface RuntimeEnv {
	oidcIssuer: string;
	oidcClientId: string;
}

export const env: RuntimeEnv = (window as unknown as { __env?: RuntimeEnv }).__env ?? {
	oidcIssuer: '',
	oidcClientId: '',
};
