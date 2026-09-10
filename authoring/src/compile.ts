import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { register } from 'tsx/esm/api';
const loaders = new Map<string, ReturnType<typeof register>>();
export async function closeCompilers() {
  await Promise.all([...loaders.values()].map((loader) => loader()));
  loaders.clear();
}
import * as React from 'react';
import { render, toPlainText } from '@react-email/components';

export interface Artifact {
  subject: string;
  previewText: string;
  html: string;
  text: string;
  source: Record<string, string>;
  dependencies: Record<string, string>;
  fields: { name: string; required: boolean; sample: string; default?: string }[];
  legacySesName?: string;
}
export async function bundle(root: string, entry: string) {
  const source: Record<string, string> = {},
    dependencies: Record<string, string> = {};
  root = await realpath(root);
  const visit = async (file: string) => {
    file = await realpath(file);
    const key = relative(root, file).replaceAll('\\', '/');
    if (key.startsWith('../') || isAbsolute(key)) throw new Error('Local imports must stay inside the source project.');
    if (Object.hasOwn(source, key)) return;
    if (Object.keys(source).length >= 150) throw new Error('Template source exceeds 150 local files.');
    const content = await readFile(file, 'utf8');
    source[key] = content;
    const ast = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const imports: string[] = [];
    const walk = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      ts.forEachChild(node, walk);
    };
    walk(ast);
    for (const specifier of imports) {
      if (specifier.startsWith('.')) {
        const base = resolve(dirname(file), specifier);
        let resolved: string | undefined;
        for (const candidate of [
          base,
          `${base}.tsx`,
          `${base}.ts`,
          `${base}.json`,
          resolve(base, 'index.tsx'),
          resolve(base, 'index.ts'),
        ])
          if (
            await stat(candidate)
              .then((s) => s.isFile())
              .catch(() => false)
          ) {
            resolved = candidate;
            break;
          }
        if (!resolved) throw new Error(`Unable to resolve local import ${specifier} from ${key}.`);
        await visit(resolved);
      } else if (!specifier.startsWith('node:')) {
        const pkg = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
        const require = createRequire(pathToFileURL(file));
        let manifest: string;
        try {
          manifest = require.resolve(`${pkg}/package.json`);
        } catch {
          let dir = dirname(require.resolve(pkg));
          for (;;) {
            const candidate = resolve(dir, 'package.json');
            if (
              await stat(candidate)
                .then((s) => s.isFile())
                .catch(() => false)
            ) {
              manifest = candidate;
              break;
            }
            const parent = dirname(dir);
            if (parent === dir) throw new Error(`Cannot locate ${pkg} manifest.`);
            dir = parent;
          }
        }
        dependencies[pkg] = (JSON.parse(await readFile(manifest!, 'utf8')) as { version: string }).version;
      }
    }
  };
  await visit(entry);
  // Export a self-contained compiler configuration; the old project may depend on Bun types or scripts outside this bundle.
  source['tsconfig.json'] = JSON.stringify(
    {
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: true,
        skipLibCheck: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        allowImportingTsExtensions: true,
        noEmit: true,
      },
      include: Object.keys(source),
    },
    null,
    2,
  );
  for (const pkg of ['react', 'react-dom', '@types/react', '@types/react-dom', 'typescript']) {
    try {
      const require = createRequire(pathToFileURL(entry));
      dependencies[pkg] = JSON.parse(await readFile(require.resolve(`${pkg}/package.json`), 'utf8')).version;
    } catch {
      if (pkg !== '@types/react-dom') throw new Error(`Install ${pkg} before bundling.`);
    }
  }
  return { source, dependencies };
}
export function typecheck(root: string) {
  const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const result = spawnSync(
    process.execPath,
    [compiler, '--noEmit', '--incremental', 'false', '--project', resolve(root, 'tsconfig.json')],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('TypeScript checking failed; no artifact was published.');
}
export async function compile(root: string, file: string, marketing: boolean): Promise<Artifact> {
  let loader = loaders.get(root);
  if (!loader) {
    loader = register({ namespace: `opensend-author-${loaders.size}`, tsconfig: resolve(root, 'tsconfig.json') });
    loaders.set(root, loader);
  }
  const module = (await (
    loader as ReturnType<typeof register> & { import: (path: string, parent: string) => Promise<unknown> }
  ).import(pathToFileURL(resolve(file)).href, import.meta.url)) as {
    default: React.ComponentType;
    metadata?: { subject?: string; previewText?: string; sesName?: string };
    textPart?: string;
  };
  if (!module.default || !module.metadata?.subject)
    throw new Error(`Missing component or subject metadata: ${relative(root, file)}`);
  let html = await render(React.createElement(module.default));
  let text = module.textPart || toPlainText(html);
  if (marketing) {
    // Preserve every existing layout/style; migrate only the known legacy footer URL.
    html = html.replace(/https:\/\/unsubscribe\.spex4less\.com\/[^"\s<>]*/g, '{{unsubscribeUrl}}');
    text = text.replace(/https:\/\/unsubscribe\.spex4less\.com\/[^\s<>]*/g, '{{unsubscribeUrl}}');
  }
  if (Buffer.byteLength(html, 'utf8') >= 100 * 1024)
    throw new Error(`${relative(root, file)} exceeds 100 KiB of HTML.`);
  if (marketing && !module.metadata.previewText?.trim()) throw new Error('Marketing templates require preview text.');
  const names = [
    ...new Set(
      [...`${html}\n${text}\n${module.metadata.subject}`.matchAll(/{{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}/g)].map(
        (m) => m[1]!,
      ),
    ),
  ].filter((n) => n !== 'unsubscribeUrl');
  const built = await bundle(root, file);
  return {
    subject: module.metadata.subject,
    previewText: module.metadata.previewText ?? '',
    html,
    text,
    ...built,
    fields: names.map((name) => ({ name, required: true, sample: 'Example' })),
    ...(module.metadata.sesName ? { legacySesName: module.metadata.sesName } : {}),
  };
}
