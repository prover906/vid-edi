// Static sanity check: every named import must be exported by the target module.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
})(path.join(root, 'src'));

const exportsOf = new Map();
function getExports(file) {
  if (exportsOf.has(file)) return exportsOf.get(file);
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g))
    for (const part of m[1].split(',')) {
      const seg = part.trim().split(/\s+as\s+/);
      if (seg[0]) names.add((seg[1] || seg[0]).trim());
    }
  exportsOf.set(file, names);
  return names;
}

let problems = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[2]);
    if (!fs.existsSync(target)) {
      console.log(`${path.relative(root, file)}: missing module ${m[2]}`);
      problems++;
      continue;
    }
    if (!target.endsWith('.js')) continue;
    const ex = getExports(target);
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name && !ex.has(name)) {
        console.log(`${path.relative(root, file)}: '${name}' is not exported by ${m[2]}`);
        problems++;
      }
    }
  }
  for (const m of src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (!fs.existsSync(target)) {
      console.log(`${path.relative(root, file)}: missing module ${m[1]}`);
      problems++;
    }
  }
}
console.log(problems ? `${problems} problem(s)` : `OK: ${files.length} modules checked`);
process.exit(problems ? 1 : 0);
