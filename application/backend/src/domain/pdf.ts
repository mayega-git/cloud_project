// Minimal PDF writer: plain text in Helvetica, A4, no external dependency.
// Characters above U+00FF are replaced by "?" (WinAnsi agrees with Latin-1 up to U+00FF).

const LINE_WIDTH = 90;
const LINES_PER_PAGE = 50;

function wrap(text: string): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
    let rest = paragraph;
    if (rest.length === 0) lines.push('');
    while (rest.length > 0) {
      if (rest.length <= LINE_WIDTH) { lines.push(rest); break; }
      let cut = rest.lastIndexOf(' ', LINE_WIDTH);
      if (cut <= 0) cut = LINE_WIDTH;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ /, '');
    }
  }
  return lines;
}

function escapeLine(line: string): string {
  return line.replace(/[^\u0000-ÿ]/g, '?').replace(/[\\()]/g, (char) => `\\${char}`);
}

export function textToPdf(text: string): Buffer {
  const lines = wrap(text);
  const pages: string[][] = [];
  for (let index = 0; index < lines.length; index += LINES_PER_PAGE) pages.push(lines.slice(index, index + LINES_PER_PAGE));
  if (pages.length === 0) pages.push([]);

  // Objects: 1 catalog, 2 page tree, 3 font, then (page, content) pairs.
  const objects: Buffer[] = [];
  const pageObjectIds = pages.map((_page, index) => 4 + index * 2);
  objects.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'));
  objects.push(Buffer.from(
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`, 'latin1'));
  objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1'));
  pages.forEach((pageLines, index) => {
    const contentId = 5 + index * 2;
    objects.push(Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      'latin1'));
    const stream = Buffer.from(
      `BT /F1 11 Tf 14 TL 50 800 Td\n${pageLines.map((line) => `(${escapeLine(line)}) Tj T*`).join('\n')}\nET`, 'latin1');
    objects.push(Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream', 'latin1'),
    ]));
  });

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let position = chunks[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(position);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(chunk);
    position += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)].join('');
  chunks.push(Buffer.from(
    `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}
