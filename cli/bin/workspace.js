import { opendir } from 'node:fs/promises';
import { join } from 'node:path';

/** Count Markdown files without invoking a shell or following symlinks. */
export async function countMarkdownFiles(root, { maxEntries = 100_000 } = {}) {
  if (typeof root !== 'string' || root.length === 0) return 0;
  const pending = [root];
  let count = 0;
  let visited = 0;

  while (pending.length > 0 && visited < maxEntries) {
    const directory = pending.pop();
    let handle;
    try {
      handle = await opendir(directory);
      for await (const entry of handle) {
        visited += 1;
        if (visited > maxEntries) break;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) count += 1;
      }
    } catch {
      // Missing or unreadable paths simply contribute no files.
    }
  }
  return count;
}
