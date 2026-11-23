/*
 * Package format and LZ4 decoding adapted from elysia395/dsh-wallpaper-engine (MIT).
 * Copyright (c) 2026 elysia395
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';

const indexCache = new Map();
const maxIndexBytes = 64 * 1024 * 1024;
const maxBlockBytes = 64 * 1024 * 1024;

export class PkgFormatError extends Error {}
class ShortIndexError extends PkgFormatError {}

function parseIndex(head, fileSize) {
  let cursor = 0;
  function take(length) {
    const start = cursor;
    cursor += length;
    if (cursor > head.length) throw new ShortIndexError('Truncated PKG index');
    return head.subarray(start, cursor);
  }

  function uint32() {
    return take(4).readUInt32LE();
  }

  function string(maxLength) {
    const length = uint32();
    if (length === 0 || length > maxLength) throw new PkgFormatError('Invalid PKG string length');
    return take(length).toString('utf8');
  }

  if (!/^PKGV\d{4}$/.test(string(32))) throw new PkgFormatError('Invalid PKG magic');
  const count = uint32();
  if (count > 1_048_576 || count * 13 > fileSize - cursor) {
    throw new PkgFormatError('Invalid PKG entry count');
  }

  const entries = new Map();
  for (let index = 0; index < count; index++) {
    const path = string(1024).replaceAll('\\', '/');
    const offset = uint32();
    const length = uint32();
    const key = path.toLowerCase();
    if (!entries.has(key)) entries.set(key, { path, offset, length });
    if (offset + length > fileSize) throw new PkgFormatError('PKG entry exceeds file size');
  }
  for (const entry of entries.values()) {
    entry.offset += cursor;
    if (entry.offset + entry.length > fileSize) throw new PkgFormatError('PKG entry exceeds file size');
  }
  return entries;
}

async function readAt(file, position, length) {
  const bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await file.read(bytes, read, length - read, position + read);
    if (!bytesRead) throw new PkgFormatError('Unexpected end of PKG file');
    read += bytesRead;
  }
  return bytes;
}

async function readIndex(file, size) {
  const limit = Math.min(size, maxIndexBytes);
  let length = Math.min(limit, 64 * 1024);
  while (true) {
    const head = await readAt(file, 0, length);
    try {
      return parseIndex(head, size);
    } catch (error) {
      if (!(error instanceof ShortIndexError) || length === limit) throw error;
      length = Math.min(length * 4, limit);
    }
  }
}

export async function openPkg(filePath) {
  const file = await open(filePath, 'r');
  try {
    const stats = await file.stat({ bigint: true });
    const stamp = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
    const cached = indexCache.get(filePath);
    const entries = cached?.stamp === stamp
      ? cached.entries : await readIndex(file, Number(stats.size));
    indexCache.delete(filePath);
    indexCache.set(filePath, { stamp, entries });
    if (indexCache.size > 24) indexCache.delete(indexCache.keys().next().value);
    return { file, entries };
  } catch (error) {
    await file.close();
    throw error;
  }
}

function decodeLz4(src, size) {
  const output = Buffer.allocUnsafe(size);
  let inputOffset = 0;
  let outputOffset = 0;

  function lengthFrom(nibble) {
    if (nibble < 15) return nibble;
    let length = nibble;
    let next;
    do {
      if (inputOffset >= src.length) throw new PkgFormatError('Truncated LZ4 length');
      next = src[inputOffset++];
      length += next;
    } while (next === 255);
    return length;
  }

  while (inputOffset < src.length) {
    const token = src[inputOffset++];
    const literals = lengthFrom(token >> 4);
    if (inputOffset + literals > src.length || outputOffset + literals > size) {
      throw new PkgFormatError('LZ4 literal extends past block');
    }
    src.copy(output, outputOffset, inputOffset, inputOffset + literals);
    inputOffset += literals;
    outputOffset += literals;
    if (inputOffset === src.length) break;

    if (inputOffset + 2 > src.length) throw new PkgFormatError('Truncated LZ4 distance');
    const distance = src.readUInt16LE(inputOffset);
    inputOffset += 2;
    const matchLength = lengthFrom(token & 15) + 4;
    if (!distance || distance > outputOffset || outputOffset + matchLength > size) {
      throw new PkgFormatError('Invalid LZ4 match');
    }
    const end = outputOffset + matchLength;
    while (outputOffset < end) {
      output[outputOffset] = output[outputOffset - distance];
      outputOffset++;
    }
  }
  if (outputOffset !== size) throw new PkgFormatError('LZ4 block size mismatch');
  return output;
}

// A compressed entry is an original-size prefix followed by LZ4 blocks
// with logical and stored lengths. Check header layout before treating it as compressed.
async function compressedLayout(file, { offset, length }) {
  if (length < 16) return null;
  const size = Number((await readAt(file, offset, 8)).readBigUInt64LE());
  if (size <= length || size > 0x7fffffff) return null;
  const blocks = [];
  let stored = 8;
  let logical = 0;
  while (stored + 8 <= length && logical < size) {
    const header = await readAt(file, offset + stored, 8);
    const size = header.readUInt32LE(0);
    const length = header.readUInt32LE(4);
    if (!size || !length) return null;
    blocks.push({ offset: offset + stored + 8, start: logical, size, length });
    stored += 8 + length;
    logical += size;
  }
  return stored === length && logical === size ? { size, blocks } : null;
}

export async function pkgEntryPayload(file, entry) {
  const layout = await compressedLayout(file, entry);
  if (!layout) {
    return {
      size: entry.length,
      stream: (start, end) => file.createReadStream({
        start: entry.offset + start, end: entry.offset + end, autoClose: false,
      }),
    };
  }

  async function* readBlocks(start, end) {
    for (const block of layout.blocks) {
      if (block.start > end) break;
      if (block.start + block.size <= start) continue;
      const data = await readAt(file, block.offset, block.length);
      const decoded = decodeLz4(data, block.size);
      yield decoded.subarray(Math.max(0, start - block.start), end - block.start + 1);
    }
  }

  if (layout.blocks.some((block) => Math.max(block.size, block.length) > maxBlockBytes)) {
    throw new PkgFormatError('PKG compression block exceeds size limit');
  }
  return { size: layout.size, stream: (start, end) => Readable.from(readBlocks(start, end), { objectMode: false }) };
}
