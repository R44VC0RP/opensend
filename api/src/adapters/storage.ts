import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { FetchHttpHandler } from '@smithy/fetch-http-handler';
import { ApiError } from '../core.js';
import type { Storage } from '../core.js';
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
export function r2Storage(bucket: R2Bucket): Storage {
  return {
    async put(key, body, contentType) { await bucket.put(key, body, { httpMetadata: { contentType } }); },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      if (object.size > MAX_OBJECT_BYTES) throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'Stored attachment exceeds the supported size limit.');
      return { body: new Uint8Array(await object.arrayBuffer()), contentType: object.httpMetadata?.contentType ?? 'application/octet-stream' };
    },
    async delete(key) { await bucket.delete(key); },
  };
}
export function s3Storage(env: Record<string, string | undefined>): Storage {
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) throw new ApiError(503, 'CONFIG_INVALID', 'S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required.');
  const bucket = env.S3_BUCKET;
  const client = new S3Client({ region: env.S3_REGION ?? 'us-east-1', endpoint: env.S3_ENDPOINT, forcePathStyle: Boolean(env.S3_ENDPOINT), credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }, requestHandler: new FetchHttpHandler({ requestTimeout: 15000 }), maxAttempts: 2 });
  return {
    async put(key, body, contentType) { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })); },
    async get(key) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if ((object.ContentLength ?? Infinity) > MAX_OBJECT_BYTES) throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'Stored attachment exceeds the supported size limit.');
        if (!object.Body) return null;
        return { body: await object.Body.transformToByteArray(), contentType: object.ContentType ?? 'application/octet-stream' };
      } catch (error) {
        if (error instanceof Error && error.name === 'NoSuchKey') return null;
        throw error;
      }
    },
    async delete(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
  };
}
