import fs from 'node:fs';

// CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zipStore(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt32LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + e.data.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="word/styles.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>
        <w:color w:val="000000"/>
        <w:sz w:val="24"/>
        <w:szCs w:val="24"/>
        <w:lang w:val="zh-CN" w:eastAsia="zh-CN" w:bidi="ar-SA"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:line="360" w:lineRule="auto" w:after="120"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>

  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:pPr>
      <w:ind w:firstLineChars="200" w:firstLine="480"/>
      <w:spacing w:line="360" w:lineRule="auto" w:after="120"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman"/>
      <w:color w:val="000000"/>
      <w:sz w:val="24"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:pPr>
      <w:jc w:val="center"/>
      <w:spacing w:before="280" w:after="280"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="SimHei" w:eastAsia="黑体" w:hAnsi="SimHei"/>
      <w:b/>
      <w:color w:val="000000"/>
      <w:sz w:val="44"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="Heading 1"/>
    <w:pPr>
      <w:spacing w:before="240" w:after="120"/>
      <w:outlineLvl w:val="0"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="SimHei" w:eastAsia="黑体" w:hAnsi="SimHei"/>
      <w:b/>
      <w:color w:val="000000"/>
      <w:sz w:val="32"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="Heading 2"/>
    <w:pPr>
      <w:spacing w:before="200" w:after="100"/>
      <w:outlineLvl w:val="1"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="SimHei" w:eastAsia="黑体" w:hAnsi="SimHei"/>
      <w:b/>
      <w:color w:val="000000"/>
      <w:sz w:val="28"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="Heading 3"/>
    <w:pPr>
      <w:spacing w:before="160" w:after="80"/>
      <w:outlineLvl w:val="2"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="KaiTi" w:eastAsia="楷体" w:hAnsi="KaiTi"/>
      <w:b/>
      <w:color w:val="000000"/>
      <w:sz w:val="26"/>
    </w:rPr>
  </w:style>
</w:styles>`;

function parseInlineRuns(text, fontOverride = null, colorOverride = '000000') {
  // Parses **bold**, *italic*, and `code`
  const runs = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match;

  const makeRun = (t, b = false, i = false, isCode = false) => {
    let rPr = `<w:color w:val="${colorOverride}"/>`;
    if (b) rPr += '<w:b/>';
    if (i) rPr += '<w:i/>';
    if (isCode) {
      rPr += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:fill="F0F0F2"/>';
    } else if (fontOverride) {
      rPr += `<w:rFonts w:ascii="${fontOverride}" w:eastAsia="${fontOverride}" w:hAnsi="${fontOverride}"/>`;
    }
    return `<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${xmlEscape(t)}</w:t></w:r>`;
  };

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(makeRun(text.slice(lastIndex, match.index)));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      runs.push(makeRun(token.slice(2, -2), true, false, false));
    } else if (token.startsWith('*') && token.endsWith('*')) {
      runs.push(makeRun(token.slice(1, -1), false, true, false));
    } else if (token.startsWith('`') && token.endsWith('`')) {
      runs.push(makeRun(token.slice(1, -1), false, false, true));
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    runs.push(makeRun(text.slice(lastIndex)));
  }

  return runs.length > 0 ? runs.join('') : makeRun('');
}

function renderTable(tableLines) {
  // Parse markdown table
  const rows = [];
  for (const line of tableLines) {
    const trimmed = line.trim();
    if (!trimmed.includes('|')) continue;
    // Skip separator line |---|---|
    if (/^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(trimmed)) continue;
    const cells = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(c => c.trim());
    rows.push(cells);
  }
  if (rows.length === 0) return '';

  const trs = rows.map((cells, rowIdx) => {
    const isHeader = rowIdx === 0;
    const tcs = cells.map(cell => {
      const shd = isHeader ? '<w:shd w:fill="F5F5F7"/>' : '';
      const runs = parseInlineRuns(cell, isHeader ? 'SimHei' : null, '000000');
      return `<w:tc>
        <w:tcPr>
          <w:tcW w:w="0" w:type="auto"/>
          <w:tcMar>
            <w:top w:w="120" w:type="dxa"/>
            <w:left w:w="160" w:type="dxa"/>
            <w:bottom w:w="120" w:type="dxa"/>
            <w:right w:w="160" w:type="dxa"/>
          </w:tcMar>
          ${shd}
        </w:tcPr>
        <w:p>
          <w:pPr>
            <w:spacing w:line="280" w:lineRule="auto" w:after="0"/>
            <w:ind w:firstLine="0" w:firstLineChars="0"/>
            <w:jc w:val="${isHeader ? 'center' : 'left'}"/>
          </w:pPr>
          ${runs}
        </w:p>
      </w:tc>`;
    }).join('');

    return `<w:tr>
      <w:trPr>
        ${isHeader ? '<w:tblHeader/>' : ''}
      </w:trPr>
      ${tcs}
    </w:tr>`;
  }).join('');

  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="5000" w:type="pct"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="8" w:space="0" w:color="CCCCCC"/>
        <w:left w:val="none"/>
        <w:bottom w:val="single" w:sz="8" w:space="0" w:color="CCCCCC"/>
        <w:right w:val="none"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="E0E0E0"/>
        <w:insideV w:val="none"/>
      </w:tblBorders>
      <w:tblCellMar>
        <w:top w:w="120" w:type="dxa"/>
        <w:left w:w="160" w:type="dxa"/>
        <w:bottom w:w="120" w:type="dxa"/>
        <w:right w:w="160" w:type="dxa"/>
      </w:tblCellMar>
    </w:tblPr>
    ${trs}
  </w:tbl>`;
}

export function makeDocx(title, content) {
  const body = [];

  // Title
  body.push(`<w:p>
    <w:pPr>
      <w:pStyle w:val="Title"/>
      <w:ind w:firstLine="0" w:firstLineChars="0"/>
    </w:pPr>
    <w:r>
      <w:rPr>
        <w:rFonts w:ascii="SimHei" w:eastAsia="黑体" w:hAnsi="SimHei"/>
        <w:b/>
        <w:color w:val="000000"/>
        <w:sz w:val="44"/>
      </w:rPr>
      <w:t xml:space="preserve">${xmlEscape(String(title ?? '未命名文档'))}</w:t>
    </w:r>
  </w:p>`);

  const lines = String(content ?? '').split('\n');
  let inCodeBlock = false;
  let codeBuffer = [];
  let tableBuffer = [];

  const flushTable = () => {
    if (tableBuffer.length > 0) {
      body.push(renderTable(tableBuffer));
      tableBuffer = [];
    }
  };

  const flushCode = () => {
    if (codeBuffer.length > 0) {
      for (const cLine of codeBuffer) {
        body.push(`<w:p>
          <w:pPr>
            <w:ind w:left="360" w:right="360" w:firstLine="0" w:firstLineChars="0"/>
            <w:spacing w:line="240" w:lineRule="auto" w:after="0"/>
            <w:shd w:fill="F5F5F7"/>
          </w:pPr>
          <w:r>
            <w:rPr>
              <w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>
              <w:color w:val="000000"/>
              <w:sz w:val="20"/>
            </w:rPr>
            <w:t xml:space="preserve">${xmlEscape(cLine)}</w:t>
          </w:r>
        </w:p>`);
      }
      codeBuffer = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Code block toggle
    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        flushCode();
        inCodeBlock = false;
      } else {
        flushTable();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(rawLine);
      continue;
    }

    // Table row detection
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2) {
      tableBuffer.push(rawLine);
      continue;
    } else {
      flushTable();
    }

    // Empty line -> paragraph gap
    if (trimmed.length === 0) {
      body.push('<w:p><w:pPr><w:spacing w:line="240" w:after="120"/><w:ind w:firstLine="0" w:firstLineChars="0"/></w:pPr></w:p>');
      continue;
    }

    // Heading 1
    if (trimmed.startsWith('# ')) {
      const hText = trimmed.slice(2).trim();
      body.push(`<w:p>
        <w:pPr>
          <w:pStyle w:val="Heading1"/>
          <w:ind w:firstLine="0" w:firstLineChars="0"/>
        </w:pPr>
        ${parseInlineRuns(hText, 'SimHei', '000000')}
      </w:p>`);
      continue;
    }

    // Heading 2
    if (trimmed.startsWith('## ')) {
      const hText = trimmed.slice(3).trim();
      body.push(`<w:p>
        <w:pPr>
          <w:pStyle w:val="Heading2"/>
          <w:ind w:firstLine="0" w:firstLineChars="0"/>
        </w:pPr>
        ${parseInlineRuns(hText, 'SimHei', '000000')}
      </w:p>`);
      continue;
    }

    // Heading 3
    if (trimmed.startsWith('### ')) {
      const hText = trimmed.slice(4).trim();
      body.push(`<w:p>
        <w:pPr>
          <w:pStyle w:val="Heading3"/>
          <w:ind w:firstLine="0" w:firstLineChars="0"/>
        </w:pPr>
        ${parseInlineRuns(hText, 'KaiTi', '000000')}
      </w:p>`);
      continue;
    }

    // Heading 4
    if (trimmed.startsWith('#### ')) {
      const hText = trimmed.slice(5).trim();
      body.push(`<w:p>
        <w:pPr>
          <w:spacing w:before="120" w:after="60"/>
          <w:ind w:firstLine="0" w:firstLineChars="0"/>
        </w:pPr>
        <w:r><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">${xmlEscape(hText)}</w:t></w:r>
      </w:p>`);
      continue;
    }

    // Quote / Abstract block
    if (trimmed.startsWith('>')) {
      const qText = trimmed.replace(/^>\s*/, '');
      body.push(`<w:p>
        <w:pPr>
          <w:ind w:left="400" w:right="400" w:firstLine="0" w:firstLineChars="0"/>
          <w:spacing w:before="120" w:after="120" w:line="320" w:lineRule="auto"/>
          <w:pBdr>
            <w:left w:val="single" w:sz="16" w:space="12" w:color="555555"/>
          </w:pBdr>
        </w:pPr>
        ${parseInlineRuns(qText, 'KaiTi', '000000')}
      </w:p>`);
      continue;
    }

    // Lists (- or * or 1. )
    if (/^[-*]\s+/.test(trimmed)) {
      const itemText = trimmed.replace(/^[-*]\s+/, '');
      body.push(`<w:p>
        <w:pPr>
          <w:ind w:left="400" w:hanging="240" w:firstLine="0" w:firstLineChars="0"/>
          <w:spacing w:line="320" w:lineRule="auto" w:after="80"/>
        </w:pPr>
        <w:r><w:rPr><w:color w:val="000000"/></w:rPr><w:t xml:space="preserve">• </w:t></w:r>
        ${parseInlineRuns(itemText, null, '000000')}
      </w:p>`);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const numMatch = trimmed.match(/^(\d+\.)\s+(.*)/);
      const num = numMatch[1];
      const itemText = numMatch[2];
      body.push(`<w:p>
        <w:pPr>
          <w:ind w:left="400" w:hanging="240" w:firstLine="0" w:firstLineChars="0"/>
          <w:spacing w:line="320" w:lineRule="auto" w:after="80"/>
        </w:pPr>
        <w:r><w:rPr><w:b/><w:color w:val="000000"/></w:rPr><w:t xml:space="preserve">${xmlEscape(num)} </w:t></w:r>
        ${parseInlineRuns(itemText, null, '000000')}
      </w:p>`);
      continue;
    }

    // Standard Prose Paragraph (with first line indent 2 characters)
    body.push(`<w:p>
      <w:pPr>
        <w:pStyle w:val="Normal"/>
        <w:ind w:firstLineChars="200" w:firstLine="480"/>
        <w:spacing w:line="360" w:lineRule="auto" w:after="120"/>
      </w:pPr>
      ${parseInlineRuns(rawLine, null, '000000')}
    </w:p>`);
  }

  flushTable();
  flushCode();

  // Page setup: A4 size, standard 1 inch (1440 dxa) margins
  body.push(`<w:sectPr>
    <w:pgSz w:w="11906" w:h="16838"/>
    <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
  </w:sectPr>`);

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body.join('')}</w:body>
</w:document>`;

  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(STYLES, 'utf8') }
  ]);
}
