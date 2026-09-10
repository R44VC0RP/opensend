import { z } from '@hono/zod-openapi';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { ApiError } from './core.js';

const FileName = z
  .string()
  .max(200)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_./-]+$/);
export const TemplateArtifact = z
  .object({
    subject: z
      .string()
      .min(1)
      .max(998)
      .refine((v) => !/[\r\n]/.test(v)),
    previewText: z.string().max(200).default(''),
    html: z
      .string()
      .min(1)
      .max(512 * 1024),
    text: z
      .string()
      .min(1)
      .max(512 * 1024),
    source: z
      .record(FileName, z.string().max(512 * 1024))
      .refine((v) => Object.keys(v).length <= 150, 'At most 150 source files.'),
    dependencies: z.record(z.string().max(100), z.string().max(100)),
    fields: z
      .array(
        z.object({
          name: z
            .string()
            .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
            .max(80),
          required: z.boolean().default(true),
          sample: z.string().max(2000).default(''),
          default: z.string().max(2000).optional(),
        }),
      )
      .max(50)
      .default([]),
    legacySesName: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
  })
  .strict()
  .openapi('TemplateArtifact');
export type TemplateArtifact = z.infer<typeof TemplateArtifact>;
export function validateTemplate(artifact: TemplateArtifact) {
  const errors: string[] = [];
  const bytes = new TextEncoder().encode(artifact.html).byteLength;
  if (bytes >= 100 * 1024) errors.push('HTML must be smaller than 100 KiB.');
  if (!Object.keys(artifact.source).some((k) => k.endsWith('.tsx'))) errors.push('Include the React TSX source.');
  const names = artifact.fields.map((f) => f.name);
  if (new Set(names).size !== names.length) errors.push('Personalization field names must be unique.');
  const visit = (node: DefaultTreeAdapterMap['node']) => {
    if ('tagName' in node) {
      if (
        [
          'script',
          'iframe',
          'object',
          'embed',
          'form',
          'input',
          'button',
          'textarea',
          'select',
          'base',
          'svg',
          'math',
        ].includes(node.tagName)
      )
        errors.push(`Unsupported email element: ${node.tagName}.`);
      for (const attr of node.attrs) {
        if (/^on/i.test(attr.name) || ['srcdoc', 'srcset'].includes(attr.name))
          errors.push(`Unsupported email attribute: ${attr.name}.`);
        if (
          ['href', 'src', 'background'].includes(attr.name) &&
          !/^(https:\/\/|mailto:|tel:|cid:|#|\{\{unsubscribeUrl\}\})/i.test(attr.value)
        )
          errors.push('Email links and images require safe absolute URLs.');
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
  };
  visit(parse(artifact.html));
  return { valid: errors.length === 0, errors: [...new Set(errors)], bytes };
}
export function assertTemplateFields(artifact: TemplateArtifact, values: Record<string, unknown>) {
  for (const field of artifact.fields) {
    if (values[field.name] == null && field.default !== undefined) values[field.name] = field.default;
    if (field.required && values[field.name] == null)
      throw new ApiError(422, 'MISSING_TEMPLATE_VARIABLE', `A value is required for ${field.name}.`, field.name);
    if (!field.required && values[field.name] == null) values[field.name] = '';
  }
}
