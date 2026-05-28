import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * Build a gzipped tar archive of the workspace directory in pure Node.
 * Skips: node_modules, .git, *.tmp, anything > 5 MiB per file, total cap 32 MiB.
 *
 * Tar format used is `ustar` (POSIX 1003.1-1988). Zero runtime deps \u2014 the
 * stdlib provides everything (fs + zlib).
 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

export async function buildWorkspaceTarball(workspaceDir: string): Promise<Buffer> {
  const records: Buffer[] = [];
  let total = 0;

  async function walk(rel: string): Promise<void> {
    const abs = path.join(workspaceDir, rel);
    let entries: string[];
    try { entries = await fs.readdir(abs); }
    catch { return; }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      if (name.endsWith('.tmp')) continue;
      const entryRel = rel ? `${rel}/${name}` : name;
      const entryAbs = path.join(workspaceDir, entryRel);
      const stat = await fs.stat(entryAbs);
      if (stat.isDirectory()) {
        await walk(entryRel);
      } else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) continue;
        if (total + stat.size > MAX_TOTAL_BYTES) continue;
        const body = await fs.readFile(entryAbs);
        records.push(tarHeader(entryRel, body.length, stat.mtimeMs / 1000));
        records.push(body);
        // pad to 512-byte boundary
        const pad = (512 - (body.length % 512)) % 512;
        if (pad > 0) records.push(Buffer.alloc(pad));
        total += body.length;
      }
    }
  }

  await walk('');
  // tar end-of-archive: two empty 512-byte blocks
  records.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(records));
}

/** Build a POSIX ustar header for one file. */
function tarHeader(filename: string, size: number, mtime: number): Buffer {
  const header = Buffer.alloc(512);
  // Filename truncation: ustar supports 100-char name + 155-char prefix, but
  // for simplicity we cap at 100 here. Long paths get truncated rather than
  // failing the whole archive.
  const safeName = filename.length > 100 ? filename.slice(0, 100) : filename;
  header.write(safeName, 0, 100, 'utf8');
  header.write('000644 \0', 100, 8, 'utf8');           // mode
  header.write('0000000\0', 108, 8, 'utf8');           // uid
  header.write('0000000\0', 116, 8, 'utf8');           // gid
  header.write(padOctal(size, 11) + '\0', 124, 12, 'utf8');
  header.write(padOctal(Math.floor(mtime), 11) + '\0', 136, 12, 'utf8');
  // checksum placeholder (8 spaces)
  header.write('        ', 148, 8, 'utf8');
  header.write('0', 156, 1, 'utf8');                    // typeflag: regular file
  header.write('ustar\0', 257, 6, 'utf8');              // magic
  header.write('00', 263, 2, 'utf8');                   // version
  // compute checksum
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i]!;
  header.write(padOctal(sum, 6) + '\0 ', 148, 8, 'utf8');
  return header;
}

function padOctal(n: number, width: number): string {
  const s = n.toString(8);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}
