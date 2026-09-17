// Shared file-content checks; callers own allowed extensions, MIME policy and errors.
export function attachmentContentMatches(extension: string, bytes: Uint8Array): boolean {
  const starts = (prefix: number[]) => prefix.every((value, index) => bytes[index] === value);
  const ascii = (start: number, end: number) => new TextDecoder('latin1').decode(bytes.subarray(start, end));
  if (extension === 'png') return starts([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
  if (extension === 'jpg' || extension === 'jpeg') return starts([0xff, 0xd8, 0xff]);
  if (extension === 'gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  if (extension === 'webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (extension === 'pdf') return ascii(0, 5) === '%PDF-';
  if (['docx', 'xlsx', 'pptx'].includes(extension)) {
    const content = new TextDecoder('latin1').decode(bytes);
    const marker = extension === 'docx' ? 'word/' : extension === 'xlsx' ? 'xl/' : 'ppt/';
    return starts([0x50, 0x4b]) && content.includes('[Content_Types].xml') && content.includes(marker);
  }
  if (!['txt', 'csv', 'json', 'ics'].includes(extension)) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) return false;
    if (extension === 'json') JSON.parse(text);
    if (extension === 'ics') {
      const calendar = text.replaceAll('\r\n', '\n').trim();
      return calendar.startsWith('BEGIN:VCALENDAR\n') && calendar.endsWith('END:VCALENDAR');
    }
    return true;
  } catch { return false; }
}
