import assert from 'node:assert/strict';
import test from 'node:test';
import {textToPdf} from './pdf.js';

test('the PDF has a header, escaped text and a trailer', () => {
  const text = textToPdf('Bonjour (monde)\nSecond \\ line').toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.includes('(Bonjour \\(monde\\)) Tj'));
  assert.ok(text.includes('(Second \\\\ line) Tj'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
});

test('xref offsets point at their objects', () => {
  const text = textToPdf(Array.from({length: 120}, (_value, index) => `line ${index}`).join('\n')).toString('latin1');
  const offsets = [...text.matchAll(/(\d{10}) 00000 n /g)].map((match) => Number(match[1]));
  assert.ok(offsets.length >= 9);
  offsets.forEach((offset, index) => assert.ok(text.slice(offset).startsWith(`${index + 1} 0 obj`)));
  assert.equal(Number(text.match(/startxref\n(\d+)/)![1]), text.indexOf('xref\n0 '));
});

test('long text is paginated and long lines are wrapped', () => {
  const pages = (value: string) => (textToPdf(value).toString('latin1').match(/\/Type \/Page /g) ?? []).length;
  assert.equal(pages(''), 1);
  assert.equal(pages(Array.from({length: 120}, (_value, index) => `line ${index}`).join('\n')), 3);
  assert.ok(pages('word '.repeat(2000)) > 1);
});

test('accented Latin-1 characters are kept and other characters are replaced', () => {
  const bytes = textToPdf('café €');
  assert.ok(bytes.includes(Buffer.from('(café ?) Tj', 'latin1')));
});
