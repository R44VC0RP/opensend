import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { compile, typecheck, closeCompilers, type Artifact } from './compile.js';

const [command, rootArg, entryArg] = process.argv.slice(2),
  root = resolve(rootArg ?? '.');
const token = process.env.OPENSEND_TEMPLATE_TOKEN ?? process.env.OPENSEND_API_KEY;
const api = process.env.OPENSEND_URL?.replace(/\/$/, '');
async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (!api || !token)
    throw new Error('Set OPENSEND_URL and OPENSEND_TEMPLATE_TOKEN (authoring) or OPENSEND_API_KEY (migration).');
  const url = new URL(api);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
    throw new Error('Use HTTPS, except for localhost fixtures.');
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
  });
  const data = (await response.json()) as T & { error?: { code: string } };
  if (!response.ok) throw new Error(`OpenSend rejected the request (${data.error?.code ?? response.status}).`);
  return data;
}
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const result: string[] = [];
  for (const e of entries) {
    const path = resolve(directory, e.name);
    if (e.isDirectory()) result.push(...(await files(path)));
    else if (e.isFile() && e.name.endsWith('.tsx')) result.push(path);
  }
  return result;
}
async function main() {
  if (command === 'restore') {
    const templateId = process.env.OPENSEND_TEMPLATE_ID;
    if (!templateId) throw new Error('Set OPENSEND_TEMPLATE_ID.');
    const saved = await call<{ revision: number; artifact: Artifact | null }>(
      `/authoring/templates/${encodeURIComponent(templateId)}`,
    );
    await mkdir(root, { recursive: true });
    await writeFile(
      resolve(root, '.opensend-revision.json'),
      JSON.stringify({ templateId, revision: saved.revision }) + '\n',
      { flag: 'wx' },
    );
    if (!saved.artifact) {
      console.log('No saved source. Create a React Email template in this workspace.');
      return;
    }
    for (const [name, content] of Object.entries(saved.artifact.source)) {
      const path = resolve(root, name),
        rel = relative(root, path);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Unsafe source path.');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, { flag: 'wx' });
    }
    await writeFile(
      resolve(root, 'package.json'),
      JSON.stringify({ private: true, type: 'module', dependencies: saved.artifact.dependencies }, null, 2) + '\n',
      { flag: 'wx' },
    );
    console.log(`Restored revision ${saved.revision}. Install its pinned dependencies before building.`);
    return;
  }
  if (command === 'build' || command === 'save') {
    if (!entryArg) throw new Error('Usage: npm run build -- <project-root> <entry-relative-to-root>');
    typecheck(root);
    const artifact = await compile(root, resolve(root, entryArg), process.env.OPENSEND_TEMPLATE_KIND !== 'automation');
    if (command === 'build') {
      await mkdir(resolve(root, 'dist'), { recursive: true });
      await writeFile(resolve(root, 'dist', 'opensend-artifact.json'), JSON.stringify(artifact, null, 2) + '\n');
      console.log('Built dist/opensend-artifact.json');
      return;
    }
    const templateId = process.env.OPENSEND_TEMPLATE_ID;
    if (!templateId) throw new Error('Set OPENSEND_TEMPLATE_ID.');
    const path = `/authoring/templates/${encodeURIComponent(templateId)}`,
      current = JSON.parse(await readFile(resolve(root, '.opensend-revision.json'), 'utf8')) as {
        templateId: string;
        revision: number;
      };
    if (current.templateId !== templateId) throw new Error('Restore this template before saving.');
    const saved = await call<{ revision: number }>(path, 'PUT', { revision: current.revision, artifact });
    await writeFile(
      resolve(root, '.opensend-revision.json'),
      JSON.stringify({ templateId, revision: saved.revision }) + '\n',
    );
    console.log('Saved draft. Review and publish it in OpenSend.');
    return;
  }
  if (command === 'import') {
    typecheck(root);
    const candidates = [
      ...(await files(resolve(root, 'emails/mailers/ready'))),
      ...(await files(resolve(root, 'emails/automations'))),
    ];
    const reportPath = resolve(root, 'reports', 'opensend-import.json');
    type Imported = { file: string; kind: string; status: string; id?: string; checksum?: string; error?: string };
    const prior: Imported[] = JSON.parse(await readFile(reportPath, 'utf8').catch(() => '[]'));
    const report: Imported[] = [];
    const checkpoint = async () => {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(
        reportPath,
        JSON.stringify([...report, ...prior.filter((p) => !report.some((r) => r.file === p.file))], null, 2) + '\n',
      );
    };
    const seen = new Set<string>();
    for (const file of candidates) {
      const kind = file.includes('/automations/') ? 'automation' : 'marketing';
      try {
        const artifact = await compile(root, file, kind === 'marketing');
        if (artifact.legacySesName && seen.has(artifact.legacySesName))
          throw new Error(`Duplicate SES name: ${artifact.legacySesName}`);
        if (artifact.legacySesName) seen.add(artifact.legacySesName);
        if (process.env.OPENSEND_IMPORT_WRITE !== '1') {
          report.push({ file: relative(root, file), kind, status: 'validated' });
          continue;
        }
        const key = relative(root, file),
          checksum = createHash('sha256').update(JSON.stringify(artifact)).digest('hex'),
          previous = prior.find((r) => r.file === key && r.id);
        if (previous?.checksum === checksum && previous.status === 'draft imported') {
          report.push(previous);
          continue;
        }
        const template = previous?.id
          ? { id: previous.id }
          : await call<{ id: string }>('/v1/template-library', 'POST', { name: basename(file, '.tsx'), kind });
        const record: Imported = { file: key, kind, status: 'created', id: template.id, checksum };
        report.push(record);
        await checkpoint();
        const current = await call<{ revision: number }>(`/v1/template-library/${template.id}`);
        await call(`/v1/template-library/${template.id}/versions`, 'POST', { revision: current.revision, artifact });
        record.status = 'draft imported';
        await checkpoint();
      } catch (error) {
        const key=relative(root,file),record=report.find(r=>r.file===key)??{file:key,kind,status:'failed',id:prior.find(r=>r.file===key)?.id};
        record.status='failed';record.error=error instanceof Error?error.message:'Compilation failed';
        if(!report.includes(record))report.push(record);
        await checkpoint();
      }
    }
    await mkdir(resolve(root, 'reports'), { recursive: true });
    await writeFile(resolve(root, 'reports', 'opensend-import.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(
      `${report.filter((r) => r.status !== 'failed').length} succeeded; ${report.filter((r) => r.status === 'failed').length} failed. Report: reports/opensend-import.json. No SES publishing or sending performed.`,
    );
    if (report.some((r) => r.status === 'failed')) process.exitCode = 1;
    return;
  }
  throw new Error('Use build, restore, save, or import.');
}
main()
  .finally(closeCompilers)
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'Authoring failed.');
    process.exitCode = 1;
  });
