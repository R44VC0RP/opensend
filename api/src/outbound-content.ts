import { z } from '@hono/zod-openapi';
import { Buffer } from 'node:buffer';
import { ApiError } from './core.js';

// Shared attachment validation for /v1/emails, campaigns, templates and inbound replies.

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
// Base64 of 8 MiB plus padding and the line breaks MIME tools and SDKs insert.
export const MAX_ATTACHMENT_BASE64 = 12 * 1024 * 1024;
// https://docs.aws.amazon.com/ses/latest/dg/mime-types.html: SES rejects these extensions; everything else is deliverable.
const BANNED_EXTENSIONS = new Set(['ade', 'adp', 'app', 'asp', 'bas', 'bat', 'cer', 'chm', 'cmd', 'com', 'cpl', 'crt', 'csh', 'der', 'exe', 'fxp', 'gadget', 'hlp', 'hta', 'inf', 'ins', 'isp', 'its', 'js', 'jse', 'ksh', 'lib', 'lnk',
  'mad', 'maf', 'mag', 'mam', 'maq', 'mar', 'mas', 'mat', 'mau', 'mav', 'maw', 'mda', 'mdb', 'mde', 'mdt', 'mdw', 'mdz', 'msc', 'msh', 'msh1', 'msh2', 'mshxml', 'msh1xml', 'msh2xml', 'msi', 'msp', 'mst', 'ops', 'pcd', 'pif', 'plg', 'prf', 'prg',
  'reg', 'scf', 'scr', 'sct', 'shb', 'shs', 'sys', 'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'tmp', 'url', 'vb', 'vbe', 'vbs', 'vps', 'vsmacros', 'vss', 'vst', 'vsw', 'vxd', 'ws', 'wsc', 'wsf', 'wsh', 'xnk']);

export const AttachmentFilename = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f/\\]+$/);
export const AttachmentContentType = z.string().max(100).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:\s*;[ -~]*)?$/, 'Use a MIME type such as application/pdf, optionally with parameters.');
export const AttachmentContentId = z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.@-]+$/);
export const AttachmentDisposition = z.enum(['attachment', 'inline']);
export const AttachmentMetadata = z.object({ filename: AttachmentFilename, contentType: AttachmentContentType.default('application/octet-stream'), disposition: AttachmentDisposition.default('attachment'), contentId: AttachmentContentId.optional() }).strict();
export const AttachmentUpload = AttachmentMetadata.extend({ content: z.string().min(4).max(MAX_ATTACHMENT_BASE64).describe('Base64 (standard or URL-safe alphabet; line breaks are accepted). No data URLs. Maximum decoded bytes: 8 MiB.') }).strict().openapi('AttachmentUpload');
export type AttachmentMetadataInput = z.infer<typeof AttachmentMetadata>;

/** Decodes base64 as SDKs actually emit it: standard or URL-safe alphabet, with or without padding, line breaks and spaces ignored. */
export function decodeBase64(content: string, field = 'content'): Uint8Array {
  // Flat character classes only: repeated groups would exhaust the stack on multi-megabyte uploads.
  const compact = content.replace(/[\r\n\t ]+/g, '');
  const unpadded = compact.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/_-]*$/.test(unpadded) || unpadded.length % 4 === 1 || compact.length - unpadded.length > 2) throw new ApiError(422, 'INVALID_BASE64', 'Attachment content must be base64.', field);
  const bytes = Buffer.from(unpadded, 'base64');
  if (bytes.length !== Math.floor(unpadded.length * 3 / 4)) throw new ApiError(422, 'INVALID_BASE64', 'Attachment content must be base64.', field);
  return bytes;
}

/** Size caps and the SES banned-extension list are the only content rules; type, charset and file signatures are the caller's business. */
export function validateAttachment<T extends AttachmentMetadataInput>(metadata: T, bytes: Uint8Array): T {
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new ApiError(413, 'ATTACHMENT_LIMIT_EXCEEDED', `Attachment ${metadata.filename} must be nonempty and at most 8 MiB decoded.`);
  // Windows ignores trailing dots and spaces when it opens a file, so "payload.exe. " is still an executable.
  const name = metadata.filename.replace(/[. ]+$/, ''), dot = name.lastIndexOf('.'), extension = dot > 0 ? name.slice(dot + 1).trim().toLowerCase() : '';
  if (BANNED_EXTENSIONS.has(extension)) throw new ApiError(422, 'UNSUPPORTED_ATTACHMENT_TYPE', `Amazon SES does not deliver .${extension} attachments.`, 'filename');
  if (metadata.disposition === 'inline' && !metadata.contentId) throw new ApiError(422, 'INLINE_ATTACHMENT_INVALID', 'Inline attachments require contentId.', 'contentId');
  return metadata;
}
