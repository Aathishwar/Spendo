/**
 * Spendo - writing a real .xlsx, by hand
 *
 * The backup was a JSON dump, which is honest and useless: nobody opens their year of
 * spending in a text editor. This writes a spreadsheet the phone can hand to Excel,
 * Google Sheets or WPS, with the columns already typed - dates that sort as dates and
 * amounts that add up.
 *
 * No library. Every runtime dependency in this app is vendored and the page's CSP is
 * `script-src 'self'`, so pulling SheetJS off a CDN is not an option and vendoring
 * most of a megabyte of it to write three tables is not a trade worth making. An
 * .xlsx is a ZIP of XML, and both halves of that are small when you only ever write
 * and never read.
 *
 * What is deliberately NOT here: a shared string table (each cell carries its own
 * text - a larger file, a far simpler writer), compression, charts, and formulas.
 */

/* -------------------------------------------------------------------- zip */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A ZIP whose entries are stored rather than deflated.
 *
 * "Stored" is a real compression method, not a shortcut around one: the reader is
 * told method 0 and takes the bytes as they are. It costs file size and saves an
 * entire DEFLATE implementation, and a year of expenses is a few tens of kilobytes
 * either way.
 */
function zip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

  for (const file of files) {
    const name = encoder.encode(file.name);
    const body = encoder.encode(file.body);
    const sum = crc32(body);

    // A fixed 1980-01-01 stamp, the earliest a ZIP can express. A real one would make
    // two exports of identical data differ, and nothing reads it.
    const header = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(33),
      ...u32(sum), ...u32(body.length), ...u32(body.length),
      ...u16(name.length), ...u16(0)
    ];

    chunks.push(new Uint8Array(header), name, body);

    central.push({
      name,
      entry: [
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
        ...u16(0), ...u16(33),
        ...u32(sum), ...u32(body.length), ...u32(body.length),
        ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(0), ...u32(offset)
      ]
    });

    offset += header.length + name.length + body.length;
  }

  const dirStart = offset;
  let dirSize = 0;
  for (const item of central) {
    chunks.push(new Uint8Array(item.entry), item.name);
    dirSize += item.entry.length + item.name.length;
  }

  chunks.push(new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(central.length), ...u16(central.length),
    ...u32(dirSize), ...u32(dirStart), ...u16(0)
  ]));

  return new Blob(chunks, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}

/* -------------------------------------------------------------------- xml */

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
));

/*
 * Excel treats a control character in a cell as a corrupt file rather than as text,
 * so they go. A description typed on a phone should never hold one, but a paste from
 * another app can, and "your backup will not open" is the worst moment to find out.
 */
function clean(value) {
  let out = '';
  for (const ch of String(value ?? '')) {
    const code = ch.codePointAt(0);
    // Tab, newline and carriage return are legal inside a cell. The rest of C0 is
    // not, and no keyboard writes one.
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) continue;
    out += ch;
  }
  return out;
}

/** A1, B1 ... Z1, AA1. Columns are 1-based, as everything in this format is. */
function ref(col, row) {
  let name = '';
  let n = col;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name + row;
}

/**
 * A date as Excel counts them: days since 1899-12-30, which is where its deliberate
 * 1900 leap-year bug leaves the epoch.
 *
 * Built from the parts of the YYYY-MM-DD string rather than from a Date, so no
 * timezone can move an expense to the day before - the same rule the rest of the app
 * follows about a date being a string from end to end.
 */
function excelDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000) + 25569;
}

const STYLE = { plain: 0, header: 1, date: 2, money: 3 };

function cell(col, row, value, type) {
  const at = ref(col, row);
  if (value === null || value === undefined || value === '') return '';

  if (type === 'date') {
    const serial = excelDate(value);
    if (serial === null) return `<c r="${at}" t="inlineStr"><is><t>${esc(clean(value))}</t></is></c>`;
    return `<c r="${at}" s="${STYLE.date}"><v>${serial}</v></c>`;
  }
  if (type === 'money' || type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return `<c r="${at}"${type === 'money' ? ` s="${STYLE.money}"` : ''}><v>${n}</v></c>`;
  }
  const style = type === 'header' ? ` s="${STYLE.header}"` : '';
  return `<c r="${at}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(clean(value))}</t></is></c>`;
}

/**
 * One worksheet.
 *
 * The header row is frozen and carries a filter, because the first thing anyone does
 * with a year of transactions is sort it by amount and then wonder where the headings
 * went.
 */
function sheetXml({ columns, rows }) {
  const width = columns.length;
  const last = Math.max(rows.length + 1, 1);

  const head = `<row r="1">${columns
    .map((c, i) => cell(i + 1, 1, c.label, 'header'))
    .join('')}</row>`;

  const body = rows.map((row, r) => {
    const cells = columns
      .map((c, i) => cell(i + 1, r + 2, row[c.key], c.type))
      .join('');
    return `<row r="${r + 2}">${cells}</row>`;
  }).join('');

  const cols = columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`)
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${ref(width, last)}"/>
<sheetViews><sheetView workbookViewId="0">
<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${head}${body}</sheetData>
<autoFilter ref="A1:${ref(width, last)}"/>
</worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
<numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>
<numFmt numFmtId="165" formatCode="#,##0.00"/>
</numFmts>
<fonts count="2">
<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="2">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * A workbook, as a Blob ready to be handed to a download.
 *
 * `sheets` is [{ name, columns: [{ key, label, type, width }], rows }], where `type`
 * is 'text' (the default), 'date', 'money' or 'number'.
 */
export function workbook(sheets) {
  const named = sheets.map((sheet, i) => ({
    ...sheet,
    // Excel refuses these characters in a tab name - and refuses the whole file
    // rather than the name.
    name: String(sheet.name).replace(/[\\/*?:[\]]/g, ' ').slice(0, 31) || `Sheet${i + 1}`,
    file: `sheet${i + 1}.xml`,
    id: i + 1
  }));

  const files = [
    {
      name: '[Content_Types].xml',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${named.map((s) => `<Override PartName="/xl/worksheets/${s.file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`
    },
    {
      name: '_rels/.rels',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
    },
    {
      name: 'xl/workbook.xml',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${named.map((s) => `<sheet name="${esc(s.name)}" sheetId="${s.id}" r:id="rId${s.id}"/>`).join('')}</sheets>
</workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((s) => `<Relationship Id="rId${s.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${s.file}"/>`).join('\n')}
<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
    },
    { name: 'xl/styles.xml', body: STYLES_XML },
    ...named.map((s) => ({ name: `xl/worksheets/${s.file}`, body: sheetXml(s) }))
  ];

  return zip(files);
}
