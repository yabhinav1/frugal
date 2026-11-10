// CSV import and export for product catalogues.

/**
 * Parse CSV text into an array of objects keyed by the header row.
 * Blank lines are skipped. Values are strings.
 */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return [];
  const headers = splitLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const row = {};
    headers.forEach((header, i) => {
      row[header] = cells[i] ?? '';
    });
    return row;
  });
}

/** Split one CSV line into cells. */
function splitLine(line) {
  return line.split(',').map((cell) => cell.trim());
}

/**
 * Serialise an array of objects as CSV. Columns come from the first row
 * unless `columns` is given.
 */
export function toCsv(rows, columns) {
  if (rows.length === 0) return '';
  const cols = columns ?? Object.keys(rows[0]);
  const lines = [cols.join(',')];
  for (const row of rows) {
    lines.push(cols.map((col) => String(row[col] ?? '')).join(','));
  }
  return lines.join('\n');
}

/** Convert the price and stock columns of parsed catalogue rows to numbers. */
export function toProducts(rows) {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    price: Number(row.price),
    stock: Number(row.stock ?? 0),
  }));
}
