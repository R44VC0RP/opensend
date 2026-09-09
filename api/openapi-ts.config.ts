import { defineConfig } from '@hey-api/openapi-ts';
export default defineConfig({
  input: './openapi.json',
  output: '../sdk/src',
  plugins: ['@hey-api/typescript', '@hey-api/client-fetch', { name: '@hey-api/sdk', auth: true }],
});
