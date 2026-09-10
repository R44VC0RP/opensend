import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(apiRoot, '..');
const document = JSON.parse(await readFile(join(apiRoot, 'openapi.json'), 'utf8'));
const operations = [];
for (const [path, pathItem] of Object.entries(document.paths ?? {})) for (const [method, operation] of Object.entries(pathItem)) {
  if (!['get', 'post', 'put', 'patch', 'delete'].includes(method) || !operation?.operationId) continue;
  const samples = operation['x-codeSamples'];
  if (!Array.isArray(samples) || samples.length !== 2) throw new Error(`${operation.operationId} must provide TypeScript SDK and cURL samples.`);
  const typescript = samples.find(sample => sample.lang === 'TypeScript')?.source;
  const curl = samples.find(sample => sample.lang === 'Shell')?.source;
  if (!typescript?.includes(`import { ${operation.operationId} } from 'opensend-js'`) || !typescript.includes(`await ${operation.operationId}({`)) throw new Error(`${operation.operationId} has an invalid SDK sample.`);
  if (!curl?.startsWith(`curl --request ${method.toUpperCase()}`) || !curl.includes(path.split('/{')[0])) throw new Error(`${operation.operationId} has an invalid cURL sample.`);
  operations.push({ id: operation.operationId, typescript });
}
if (!operations.length || new Set(operations.map(operation => operation.id)).size !== operations.length) throw new Error('OpenAPI operations must have unique operation IDs.');

const directory = await mkdtemp(join(tmpdir(), 'opensend-doc-examples-'));
try {
  const files = [];
  for (const operation of operations) {
    const file = join(directory, `${operation.id}.ts`);
    await writeFile(file, operation.typescript);
    files.push(file);
  }
  const config = join(directory, 'tsconfig.json');
  await writeFile(config, JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true, ignoreDeprecations: '6.0',
    baseUrl: workspaceRoot, paths: { 'opensend-js': ['sdk/src/index.ts'], 'opensend-js/client': ['sdk/src/client/index.ts'] },
    typeRoots: [join(apiRoot, 'node_modules/@types')], types: ['node'],
  }, files }, null, 2));
  const result = spawnSync(process.execPath, [join(apiRoot, 'node_modules/typescript/bin/tsc'), '-p', config], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Generated SDK examples failed type-checking:\n${result.stdout}${result.stderr}`);
} finally { await rm(directory, { recursive: true, force: true }); }

console.log(`Verified ${operations.length} generated SDK and cURL example pairs.`);
