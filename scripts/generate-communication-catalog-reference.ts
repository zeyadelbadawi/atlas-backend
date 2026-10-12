/**
 * B0-MSG-06 — writes the generated notification catalogue reference.
 * Run: npm run docs:communication-catalog
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CATALOG_REFERENCE_PATH,
  renderCatalogReference,
} from '../src/communications/catalog/catalog-reference';

const target = resolve(__dirname, '..', CATALOG_REFERENCE_PATH);
writeFileSync(target, renderCatalogReference());
process.stdout.write(`wrote ${CATALOG_REFERENCE_PATH}\n`);
