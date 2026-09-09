import { writeFile } from 'node:fs/promises';
import { createApp } from './app.js';
const document = createApp().getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'OpenSend API', version: '0.1.0' } });
await writeFile(new URL('../openapi.json', import.meta.url), JSON.stringify(document, null, 2) + '\n');
console.log(`Generated OpenAPI for ${Object.keys(document.paths ?? {}).length} paths.`);
