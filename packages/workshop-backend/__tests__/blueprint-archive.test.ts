import { describe, expect, it } from 'vitest';
import { buildBlueprintArchiveStream, parseBlueprintArchive } from '../src/blueprint-archive';
import type { BlueprintMetadata } from '@gadgets/workshop-shared/api';

// `.gadget` archives are the publish/import wire format: a 24-byte prefix, JSON metadata, then the
// content. Both ends are streaming, so the interesting failures are not in the happy path but at
// chunk boundaries — a reader that assumes the prefix arrives in one piece works perfectly against
// a one-chunk stream and truncates a real upload.

const PREFIX_BYTES = 24;
const MAGIC = 0xec2e2d3a2300e317n;

function metadata(overrides: Partial<BlueprintMetadata> = {}): BlueprintMetadata {
  return {
    title: 'Spreadsheet',
    description: 'A gadget that does sums.',
    author: { name: 'Wil' },
    created: new Date('2026-01-02T03:04:05.000Z'),
    version: 3,
    lastUpdated: new Date('2026-02-03T04:05:06.000Z'),
    bindings: {},
    ...overrides,
  } as BlueprintMetadata;
}

// Emits `bytes` in fixed-size pieces so tests can force the reader across chunk boundaries.
function streamOf(bytes: Uint8Array, chunkSize = bytes.byteLength || 1): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) return void controller.close();
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function archiveBytes(meta: BlueprintMetadata, content: Uint8Array): Promise<Uint8Array> {
  return collect(buildBlueprintArchiveStream(meta, streamOf(content), content.byteLength));
}

// Builds a well-formed archive and then corrupts one header field, so each rejection test differs
// from a valid archive in exactly the way it claims to.
async function withHeader(mutate: (view: DataView) => void): Promise<ReadableStream<Uint8Array>> {
  const bytes = await archiveBytes(metadata(), new TextEncoder().encode('content'));
  mutate(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return streamOf(bytes);
}

describe('round trip', () => {
  it('recovers the metadata and the content unchanged', async () => {
    const content = crypto.getRandomValues(new Uint8Array(5000));
    const parsed = await parseBlueprintArchive(streamOf(await archiveBytes(metadata(), content)));

    expect(parsed.metadata.title).toBe('Spreadsheet');
    expect(parsed.metadata.version).toBe(3);
    expect(parsed.contentLength).toBe(5000);
    expect(await collect(parsed.content)).toEqual(content);
  });

  it('revives dates as Date objects rather than the strings JSON leaves behind', async () => {
    const parsed = await parseBlueprintArchive(streamOf(await archiveBytes(metadata(), new Uint8Array(0))));
    expect(parsed.metadata.created).toBeInstanceOf(Date);
    expect(parsed.metadata.created.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(parsed.metadata.lastUpdated).toBeInstanceOf(Date);
  });

  it('handles a blueprint with no content at all', async () => {
    const parsed = await parseBlueprintArchive(streamOf(await archiveBytes(metadata(), new Uint8Array(0))));
    expect(parsed.contentLength).toBe(0);
    expect((await collect(parsed.content)).byteLength).toBe(0);
  });

  it('preserves non-ASCII metadata, whose byte length is not its character length', async () => {
    // The prefix records metadata size in *bytes*. Measuring characters instead would truncate the
    // JSON and shift every following byte, so this is worth asserting rather than assuming.
    const meta = metadata({ title: 'Tableur — 表計算 🧮', description: 'accents: éàü' });
    const parsed = await parseBlueprintArchive(streamOf(await archiveBytes(meta, new Uint8Array([1, 2, 3]))));
    expect(parsed.metadata.title).toBe('Tableur — 表計算 🧮');
    expect(await collect(parsed.content)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('reassembles a stream delivered one byte at a time', async () => {
    // The prefix, the metadata and the content each span many chunks here, which is the case a
    // reader that trusts the first chunk gets wrong.
    const content = crypto.getRandomValues(new Uint8Array(300));
    const bytes = await archiveBytes(metadata(), content);
    const parsed = await parseBlueprintArchive(streamOf(bytes, 1));

    expect(parsed.metadata.title).toBe('Spreadsheet');
    expect(await collect(parsed.content)).toEqual(content);
  });

  it('reassembles when a chunk straddles the metadata/content boundary', async () => {
    // The single most likely off-by-one: the chunk holding the last metadata byte also holds the
    // first content bytes, so the reader must hand the remainder back to the content stream.
    const content = crypto.getRandomValues(new Uint8Array(1024));
    const bytes = await archiveBytes(metadata(), content);

    for (const chunkSize of [7, 23, PREFIX_BYTES, PREFIX_BYTES + 1, 100, 512]) {
      const parsed = await parseBlueprintArchive(streamOf(bytes, chunkSize));
      expect(await collect(parsed.content), `chunk size ${chunkSize}`).toEqual(content);
    }
  });
});

describe('rejects malformed archives', () => {
  it('rejects a file that is not a .gadget archive', async () => {
    await expect(parseBlueprintArchive(await withHeader((v) => v.setBigUint64(0, MAGIC + 1n))))
        .rejects.toThrow(/magic number/i);
  });

  it('rejects a version it does not understand', async () => {
    await expect(parseBlueprintArchive(await withHeader((v) => v.setUint32(8, 99))))
        .rejects.toThrow(/version/i);
  });

  it('rejects an archive carrying no metadata', async () => {
    await expect(parseBlueprintArchive(await withHeader((v) => v.setUint32(12, 0))))
        .rejects.toThrow(/missing blueprint metadata/i);
  });

  it('rejects metadata larger than the 64 KiB cap', async () => {
    await expect(parseBlueprintArchive(await withHeader((v) => v.setUint32(12, 64 * 1024 + 1))))
        .rejects.toThrow(/out of range/i);
  });

  it('rejects content larger than the 32 MiB cap without reading it', async () => {
    // Declared, not delivered: the point is that the limit is enforced from the header, so an
    // oversized upload is refused before 32 MiB has been streamed anywhere.
    await expect(parseBlueprintArchive(
        await withHeader((v) => v.setBigUint64(16, BigInt(32 * 1024 * 1024 + 1)))))
        .rejects.toThrow(/too large/i);
  });

  it('rejects a truncated archive rather than returning partial metadata', async () => {
    const bytes = await archiveBytes(metadata(), new TextEncoder().encode('content'));
    await expect(parseBlueprintArchive(streamOf(bytes.subarray(0, PREFIX_BYTES + 4))))
        .rejects.toThrow(/Unexpected end/i);
  });

  it('rejects an empty upload', async () => {
    await expect(parseBlueprintArchive(streamOf(new Uint8Array(0))))
        .rejects.toThrow(/Unexpected end/i);
  });

  it('rejects metadata that is not valid JSON', async () => {
    // Swap the opening '{' for a '[', keeping every declared length correct, so the only fault is
    // the JSON itself.
    const bytes = await archiveBytes(metadata(), new Uint8Array([9]));
    bytes[PREFIX_BYTES] = 0x5b; // '['
    await expect(parseBlueprintArchive(streamOf(bytes))).rejects.toThrow(/not valid JSON/i);
  });
});
