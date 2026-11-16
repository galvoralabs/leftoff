import { readdir } from 'node:fs/promises';
import path from 'node:path';

const MARKERS = new Set([
  '.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod',
  'pubspec.yaml', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'index.html',
]);
const SKIP = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'venv', 'env', '__pycache__', 'vendor', 'coverage',
]);

/**
 * Find project folders under `root`. A folder is a project when it holds a
 * marker file. Projects are not searched further, so nested packages stay
 * part of their parent.
 */
export async function findProjects(root, maxDepth = 3) {
  const found = [];
  async function visit(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => MARKERS.has(e.name))) {
      found.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      await visit(path.join(dir, e.name), depth + 1);
    }
  }
  await visit(path.resolve(root), 0);
  return found;
}

export async function findAll(roots, maxDepth = 3) {
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    for (const p of await findProjects(root, maxDepth)) {
      const key = process.platform === 'win32' ? p.toLowerCase() : p;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}
