/**
 * Reads the PDF's own text layer with pdf.js, one string per page. This is the
 * independent source used to verify what the LLM extracted. Scanned PDFs have no
 * text layer, so they return empty pages and every item lands in review.
 */
export async function readPdfText(data: Uint8Array): Promise<string[]> {
  // pdf.js ships as ESM only; dynamic import keeps it working from this CommonJS build.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    // Group text runs into lines by their vertical position so a whole bill row reads as one line.
    const lines = new Map<number, string[]>();
    for (const it of content.items) {
      if (!('str' in it)) continue;
      const y = Math.round(it.transform[5]);
      lines.set(y, [...(lines.get(y) ?? []), it.str]);
    }
    pages.push([...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, parts]) => parts.join(' ')).join('\n'));
  }
  await doc.cleanup();
  return pages;
}
