import { config } from 'dotenv';

// Local dev: read .env from the server folder or the project root. In Docker
// the variables come from the environment and neither file exists.
config({ quiet: true });
config({ path: '../.env', quiet: true });
