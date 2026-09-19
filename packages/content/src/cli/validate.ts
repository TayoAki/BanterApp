import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkContentIntegrity } from '../integrity.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pdfDir = path.resolve(here, '../../../../handoff/content/source-pdfs');
const report = checkContentIntegrity({ pdfDir });
const failed = report.checks.filter((c) => !c.ok);
if (failed.length > 0) {
  console.error('FAIL');
  for (const f of failed) console.error(` - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
  process.exit(1);
}
console.log(`PASS: ${report.checks.length} content integrity checks (bundled copies + original PDF hashes).`);
console.log('NOT TESTED: curriculum quality, rights review, publication selection, runtime behavior.');
