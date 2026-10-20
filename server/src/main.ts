import './load-env';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'fs';
import { join } from 'path';
import { AppModule } from './app.module';
import { PUBLIC_DIR } from './config';
import { encryptionProblem } from './common/secret-crypto';

async function bootstrap() {
	const logger = new Logger('MemeDex');
	const app = await NestFactory.create<NestExpressApplication>(AppModule);
	app.set('trust proxy', true);
	app.enableShutdownHooks();

	// Local dev: the Angular dev server on :4200 calls this API
	if (process.env.NODE_ENV !== 'production') {
		app.enableCors({ origin: ['http://localhost:4200'], allowedHeaders: ['Authorization', 'Content-Type'] });
	}

	// One container: the server also serves the Angular build, with
	// index.html for any non-API path (client-side routes).
	const index = join(PUBLIC_DIR, 'index.html');
	if (existsSync(index)) {
		app.useStaticAssets(PUBLIC_DIR, {
			index: false,
			setHeaders: (res, path) => {
				// Hashed bundles can be cached forever; index.html must not be
				if (/\.[0-9a-z]{8,}\.(js|css)$/i.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
			},
		});
		app.use((req: any, res: any, next: () => void) => {
			if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path === '/env.js') return next();
			res.setHeader('Cache-Control', 'no-cache');
			res.sendFile(index);
		});
	} else {
		logger.warn(`No client build in ${PUBLIC_DIR}; serving the API only`);
	}

	const problem = encryptionProblem();
	if (problem) logger.warn(`${problem}: users can't save their Claude API key until it is set`);

	const port = Number(process.env.PORT) || 8080;
	await app.listen(port);
	logger.log(`MemeDex listening on port ${port}`);
}
bootstrap();
