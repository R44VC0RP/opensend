// Copies OpenSend's design system from app/ into public/ at the same paths OpenSend serves them
// (tokens.css loads /fonts/…): styles, fonts, the theme bootstrap and favicon. One source of truth.
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const app = new URL('../../../app/', import.meta.url);
const pub = new URL('../public/', import.meta.url);
for (const dir of ['styles/', 'fonts/']) { rmSync(new URL(dir, pub), { recursive: true, force: true }); mkdirSync(new URL(dir, pub), { recursive: true }); }
for (const file of ['tokens.css', 'ui.css', 'app.css']) cpSync(new URL(`src/styles/${file}`, app), new URL(`styles/${file}`, pub));
for (const file of ['opentui-regular.woff2', 'opentui-bold.woff2', 'inter-variable.woff2', 'inter-variable-italic.woff2', 'inter-LICENSE.txt']) cpSync(new URL(`public/fonts/${file}`, app), new URL(`fonts/${file}`, pub));
for (const file of ['theme.js', 'favicon.svg']) cpSync(new URL(`public/${file}`, app), new URL(file, pub));
console.log('Synced the OpenSend design system into public/');
