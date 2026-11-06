// Mirrors the API's webhook header rules so the form and demo reject the same lists the server does.
export const MAX_WEBHOOK_HEADERS = 10
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/
const RESERVED = /^(?:host|content-length|content-type|content-encoding|transfer-encoding|connection|keep-alive|te|trailer|upgrade|http2-settings|expect|cookie|user-agent|webhook-id|webhook-timestamp|webhook-signature|opensend-test)$|^proxy-/i

function reservedMessage(name: string) {
  if (/^cookie$/i.test(name)) return 'Cookie is not allowed. Use an endpoint token instead.'
  if (/^(?:webhook-|opensend-test$)/i.test(name)) return `${name} is set by OpenSend.`
  return `${name} is reserved for the HTTP connection.`
}

/** Errors keyed like the API's fields: `headers.<index>.name`, `headers.<index>.value` and `headers` for the list. */
export function webhookHeaderErrors(headers: { name: string; value: string }[], requireValues = false) {
  const errors: Record<string, string> = {}
  const seen = new Set<string>()
  headers.forEach(({ name, value }, index) => {
    const at = `headers.${index}`
    if (!name) errors[`${at}.name`] = 'Enter a header name.'
    else if (name.length > 64) errors[`${at}.name`] = 'Use 64 characters or fewer.'
    else if (!TOKEN.test(name)) errors[`${at}.name`] = 'Use letters, numbers and - _ . without spaces or colons.'
    else if (RESERVED.test(name)) errors[`${at}.name`] = reservedMessage(name)
    else if (seen.has(name.toLowerCase())) errors[`${at}.name`] = 'This header is already listed.'
    seen.add(name.toLowerCase())
    if (requireValues && !value) errors[`${at}.value`] = 'Enter a value.'
    else if (value.length > 2048) errors[`${at}.value`] = 'Use 2,048 characters or fewer.'
    else if (/[\r\n]/.test(value)) errors[`${at}.value`] = 'Remove line breaks.'
    else if (!FIELD_VALUE.test(value)) errors[`${at}.value`] = 'Use plain text without control characters or emoji.'
  })
  if (headers.length > MAX_WEBHOOK_HEADERS) errors.headers = `Add up to ${MAX_WEBHOOK_HEADERS} headers.`
  else if (headers.reduce((size, header) => size + header.name.length + new TextEncoder().encode(header.value).length, 0) > 8192) errors.headers = 'Header names and values must total 8 KiB or less.'
  return errors
}

/** The API's masked hint: the last four characters of values longer than eight, otherwise fully masked. */
export const webhookHeaderHint = (value: string) => '••••' + (value.length > 8 ? value.slice(-4) : '')
