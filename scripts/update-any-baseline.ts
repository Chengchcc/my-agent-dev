#!/usr/bin/env bun
import { Project } from 'ts-morph';
import { writeFileSync } from 'fs';

const p = new Project({ tsConfigFilePath: 'tsconfig.json' });
let total = 0;
for (const f of p.getSourceFiles('src/**/*.{ts,tsx}')) {
  const m = f.getFullText().match(/\b(as\s+any|:\s*any\b|<any>)/g);
  if (m) total += m.length;
}
writeFileSync('.any-baseline.json', JSON.stringify({ total, updatedAt: new Date().toISOString() }, null, 2));
console.log(`any baseline = ${total}`);
