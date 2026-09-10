const COLOR = /^#[0-9a-f]{3,8}$/i;
const PX = (_minimum: number, _maximum: number, negative = false) => new RegExp(`^(?:0|${negative ? '-?' : ''}(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?px)$`);
function color(value: string) { if (COLOR.test(value)) return true; const match = /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})(?:\s*,\s*(0|1|0?\.[0-9]+))?\s*\)$/.exec(value); return !!match && [match[1], match[2], match[3]].every(channel => Number(channel) <= 255); }
const properties: Record<string, (value: string) => boolean> = {
  color,
  'background-color': value => color(value) || value === 'transparent',
  'font-size': value => PX(1, 48).test(value) && parseFloat(value) >= 12 && parseFloat(value) <= 48,
  'font-weight': value => ['400', '500', '600', '700', 'bold', 'normal'].includes(value),
  'line-height': value => /^(?:1(?:\.[0-9]{1,2})?|2(?:\.0{1,2})?|(?:100|1[0-9]{2}|200)%)$/.test(value) || (PX(1, 72).test(value) && parseFloat(value) >= 12 && parseFloat(value) <= 72),
  'letter-spacing': value => PX(0, 8, true).test(value) && parseFloat(value) >= -2 && parseFloat(value) <= 8,
  'text-decoration': value => ['none', 'underline', 'line-through'].includes(value),
  padding: value => spacing(value, false),
  'padding-top': value => spacing(value, false, 1), 'padding-right': value => spacing(value, false, 1), 'padding-bottom': value => spacing(value, false, 1), 'padding-left': value => spacing(value, false, 1),
  'border-radius': value => PX(0, 24).test(value) && parseFloat(value) <= 24,
  'border-top-left-radius': value => PX(0, 24).test(value) && parseFloat(value) <= 24,
  'border-top-right-radius': value => PX(0, 24).test(value) && parseFloat(value) <= 24,
  'border-bottom-left-radius': value => PX(0, 24).test(value) && parseFloat(value) <= 24,
  'border-bottom-right-radius': value => PX(0, 24).test(value) && parseFloat(value) <= 24,
  'border-width': borderWidth, 'border-top-width': borderWidth, 'border-right-width': borderWidth, 'border-bottom-width': borderWidth, 'border-left-width': borderWidth,
  'border-style': borderStyle, 'border-top-style': borderStyle, 'border-right-style': borderStyle, 'border-bottom-style': borderStyle, 'border-left-style': borderStyle,
  'border-color': color, 'border-top-color': color, 'border-right-color': color, 'border-bottom-color': color, 'border-left-color': color,
  width: dimension, height: dimension,
};
function spacing(value: string, negative: boolean, exact?: number) { const parts = value.split(/\s+/); return (!exact ? parts.length >= 1 && parts.length <= 4 : parts.length === exact) && parts.every(part => PX(0, 64, negative).test(part) && Math.abs(parseFloat(part)) <= 64); }
function borderWidth(value: string) { return PX(0, 4).test(value) && parseFloat(value) <= 4; }
function borderStyle(value: string) { return ['none', 'solid', 'dashed', 'dotted'].includes(value); }
function dimension(value: string) { return /^(?:auto|100%|[1-9][0-9]?%|[1-9][0-9]{0,3}px)$/.test(value); }

export function sanitizeBlockStyle(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const declarations = value.split(';').map(item => item.trim()).filter(Boolean), accepted: [string, string][] = [];
  for (const declaration of declarations) {
    const separator = declaration.indexOf(':');
    if (separator < 1) return null;
    const property = declaration.slice(0, separator).trim().toLowerCase(), candidate = declaration.slice(separator + 1).trim().toLowerCase();
    if (!properties[property]?.(candidate) || /(?:url|var|calc|expression|!important|[{}\\])/.test(candidate)) return null;
    accepted.push([property, candidate]);
  }
  return accepted.length ? `${accepted.map(([property, candidate]) => `${property}:${candidate}`).join(';')};` : null;
}
