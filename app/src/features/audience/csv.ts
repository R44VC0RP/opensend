export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false, endedQuote = false
  const input = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') { cell += '"'; i++ } else { quoted = false; endedQuote = true }
      } else cell += char
      continue
    }
    if (char === '"') {
      if (cell || endedQuote) throw new Error('Unexpected quote in the CSV. Quote the entire field and double any quotes inside it.')
      quoted = true
    } else if (char === ',') { row.push(cell); cell = ''; endedQuote = false }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++
      row.push(cell)
      if (row.some(value => value.trim())) rows.push(row)
      row = []; cell = ''; endedQuote = false
    } else if (endedQuote) {
      if (char !== ' ' && char !== '\t') throw new Error('Unexpected text after a quoted CSV field.')
    } else cell += char
  }
  if (quoted) throw new Error('An opening quote in the CSV has no closing quote.')
  row.push(cell)
  if (row.some(value => value.trim())) rows.push(row)
  if (rows.length < 2) throw new Error('Choose a CSV with a header and at least one contact row.')
  return rows
}
