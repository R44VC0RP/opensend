import {HeadObjectCommand,GetObjectCommand,PutObjectCommand,CopyObjectCommand,type S3Client} from '@aws-sdk/client-s3';
import { ApiError } from './core.js';

const MAX_RAW_BYTES = 40 * 1024 * 1024; // SES receiving maximum, before MIME parsing or copying.

// AWS's receiving-email-notifications-examples shows the SES-added first Received field can end
// in "for recipient@example.com;". Remove that field (including folds) when not ours. The S3
// action preserves raw MIME, so also drop top-level Bcc/Resent-Bcc if physically present.
// Operate on byte offsets: never reserialize MIME, DKIM headers, attachments or the body.
function workspaceMime(bytes:Uint8Array,region:string,recipients:string[]) {
  const raw=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let pos=0,kept=0,seenReceived=false;
  const chunks:Uint8Array[]=[];
  while(pos<raw.length) {
    const start=pos;
    let end=raw.indexOf(10,pos); if (end===pos || (end===pos+1 && raw[pos]===13)) break;
    const firstEnd=end<0?raw.length:end;
    pos=end<0?raw.length:end+1;
    while(raw[pos]===32 || raw[pos]===9) { end=raw.indexOf(10,pos); pos=end<0?raw.length:end+1; }
    const name=raw.toString('latin1',start,Math.min(firstEnd,start+12)).toLowerCase();
    const maybeBlind=name.startsWith('bcc') || name.startsWith('resent-bcc');
    let remove=maybeBlind && /^(?:bcc|resent-bcc)[ \t]*:/i.test(raw.toString('latin1',start,firstEnd));
    if (!seenReceived && name.startsWith('received:')) {
      seenReceived=true;
      const field=raw.toString('latin1',start,pos).replace(/\r?\n[ \t]+/g,' ');
      const match=/\bby\s+inbound-smtp\.([\w-]+)\.amazonaws\.com\b[^;]*?\sfor\s+([^;]+);/i.exec(field);
      remove=match?.[1]===region && !recipients.includes(match[2]!.trim().replace(/^<|>$/g,'').toLowerCase());
    }
    if (remove) { chunks.push(raw.subarray(kept,start));kept=pos; }
  }
  return chunks.length ? Buffer.concat([...chunks,raw.subarray(kept)]) : bytes;
}

/** Inspect the exact bytes being copied. CopySourceIfMatch prevents substituting another object after inspection. */
export async function copyWorkspaceRaw(client:S3Client,region:string,bucket:string,source:string,key:string,recipients:string[],kind:'raw'|'legacy-raw') {
  const location={Bucket:bucket,Key:source};
  const head=await client.send(new HeadObjectCommand(location));
  if (head.ContentLength === undefined || !head.ETag) throw new Error('Raw message metadata unavailable');
  if (head.ContentLength > MAX_RAW_BYTES) throw new ApiError(413,'RAW_MESSAGE_TOO_LARGE','The raw message exceeds the 40 MiB receiving limit.');
  // Pin the checked object and do not let fetch transparently expand BYO Content-Encoding metadata.
  const object=await client.send(new GetObjectCommand({...location,IfMatch:head.ETag,ResponseContentEncoding:'identity'}));
  const original=await object.Body!.transformToByteArray();
  const bytes=workspaceMime(original,region,recipients);
  const destination={Bucket:bucket,Key:key,Tagging:`opensend-kind=${kind}`};
  if(bytes===original) await client.send(new CopyObjectCommand({...destination,CopySource:`${bucket}/${source}`,CopySourceIfMatch:head.ETag,TaggingDirective:'REPLACE'}));
  else await client.send(new PutObjectCommand({...destination,Body:bytes,ContentType:'message/rfc822'}));
  return bytes;
}
