import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import {
  actor,
  ApiError,
  digest,
  errors,
  IdParams,
  json,
  notFound,
  response,
  security,
  type Actor,
  type App,
  type Runtime,
} from './core.js';
import { findTemplate, templateStorage } from './templates.js';
const AssetInput = z
  .object({
    contentType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    content: z
      .string()
      .min(4)
      .max(8 * 1024 * 1024)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();
const Asset = z
  .object({ id: z.string(), url: z.string(), contentType: z.string(), size: z.number() })
  .openapi('TemplateImage');
export async function saveTemplateAsset(
  runtime: Runtime,
  a: Pick<Actor, 'workspaceId' | 'environment'>,
  templateId: string,
  input: z.infer<typeof AssetInput>,
) {
  await findTemplate(runtime.db, a, templateId);
  const body = Buffer.from(input.content, 'base64');
  if (!body.length || body.length > 6 * 1024 * 1024 || body.toString('base64') !== input.content)
    throw new ApiError(422, 'IMAGE_ENCODING_INVALID', 'Use canonical base64 for an image of at most 6 MiB.');
  const prefix = (bytes: number[]) => bytes.every((v, i) => body[i] === v);
  const valid =
    input.contentType === 'image/png'
      ? prefix([137, 80, 78, 71, 13, 10, 26, 10])
      : input.contentType === 'image/jpeg'
        ? prefix([255, 216, 255])
        : input.contentType === 'image/gif'
          ? ['GIF87a', 'GIF89a'].includes(body.subarray(0, 6).toString())
          : body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP';
  if (!valid) throw new ApiError(422, 'IMAGE_CONTENT_INVALID', 'The image bytes do not match the declared format.');
  const assetId = await digest(`${templateId}:${input.contentType}:${input.content}`),
    key = `${a.workspaceId}/${a.environment}/template-assets/${assetId}`;
  await templateStorage(runtime).put(key, body, input.contentType);
  await runtime.db.execute(
    sql`INSERT INTO template_assets(id,template_id,storage_key,content_type,size) VALUES(${assetId},${templateId},${key},${input.contentType},${body.length}) ON CONFLICT DO NOTHING`,
  );
  return {
    id: assetId,
    url: `${runtime.config.publicUrl}/template-assets/${assetId}`,
    contentType: input.contentType,
    size: body.length,
  };
}
export function registerTemplateAssets(app: App) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/template-library/{id}/images',
      operationId: 'uploadTemplateImage',
      description:
        'Upload a raster image and return its immutable PUBLIC email URL. Template source and draft artifacts remain private.',
      tags: ['Templates'],
      security,
      request: { params: IdParams, body: json(AssetInput) },
      responses: { 201: response(Asset), ...errors },
    }),
    async (c) => {
      const a = actor(c, 'manage');
      if (a.domains.length)
        throw new ApiError(403, 'UNRESTRICTED_KEY_REQUIRED', 'Image uploads require an unrestricted principal.');
      return c.json(await saveTemplateAsset(c.env, a, c.req.valid('param').id, c.req.valid('json')), 201);
    },
  );
  app.post('/authoring/templates/:id/images', async (c) => {
    const input = AssetInput.safeParse(await c.req.json());
    if (!input.success) throw new ApiError(422, 'IMAGE_INPUT_INVALID', 'Provide a raster MIME type and base64 image.');
    return c.json(await saveTemplateAsset(c.env, actor(c), c.req.param('id'), input.data), 201);
  });
  app.get('/template-assets/:id', async (c) => {
    const assetId = c.req.param('id');
    if (!/^[a-f0-9]{64}$/.test(assetId)) return notFound('Image');
    const r = await c.env.db.execute<{ storage_key: string; content_type: string; size: number }>(
      sql`SELECT storage_key,content_type,size FROM template_assets WHERE id=${assetId}`,
    );
    const metadata = r.rows[0];
    if (!metadata) return notFound('Image');
    const object = await templateStorage(c.env).get(metadata.storage_key);
    if (!object || object.body.length !== metadata.size)
      throw new ApiError(503, 'IMAGE_UNAVAILABLE', 'The image is temporarily unavailable.');
    return new Response(object.body as Uint8Array<ArrayBuffer>, {
      headers: {
        'content-type': metadata.content_type,
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'",
      },
    });
  });
}
