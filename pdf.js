// Tiny PDF writer, no packages: pages of monospaced text (Courier), A4.
// lines: array of strings, or { text, bold, size } objects. Lines that start with '\f' begin a new page.
function textPdf(lines, o = {}) {
  const land = !!o.landscape, W = land ? 842 : 595, H = land ? 595 : 842, M = 36, base = o.size || 9;
  const clean = s => String(s).replace(/₂/g, '2').replace(/[–—]/g, '-').replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/[\\()]/g, '\\$&');
  const pages = [[]]; let y = H - M;
  for (let l of lines) {
    if (typeof l === 'string') l = { text: l };
    let text = String(l.text);
    if (text.startsWith('\f')) { if (pages[pages.length - 1].length) pages.push([]); y = H - M; text = text.slice(1); }
    const size = l.size || base, lead = size * 1.3;
    if (y - lead < M) { pages.push([]); y = H - M; }
    y -= lead;
    pages[pages.length - 1].push(`BT /${l.bold ? 'F2' : 'F1'} ${size} Tf ${M} ${y.toFixed(1)} Td (${clean(text)}) Tj ET`);
  }
  if (o.footer) pages.forEach((p, i) => p.push(`BT /F1 7 Tf ${M} ${M / 2} Td (${clean(o.footer + '   page ' + (i + 1) + ' of ' + pages.length)}) Tj ET`));
  const objs = [], add = s => { objs.push(s); return objs.length; };
  const cat = add(''), pagesId = add(''), f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'),
        f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>');
  const kids = pages.map(p => {
    const body = p.join('\n'), cs = add(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cs} 0 R >>`);
  });
  objs[cat - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n', offs = [];
  objs.forEach((s, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${s}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
module.exports = { textPdf };
