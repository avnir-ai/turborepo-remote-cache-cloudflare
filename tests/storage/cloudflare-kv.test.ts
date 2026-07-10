import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { Files, FilesError, type Body } from 'files-sdk';
import { beforeEach, describe, expect, test } from 'vitest';

import {
  CLOUDFLARE_KV_MAX_VALUE_SIZE,
  cloudflareKv,
  type CloudflareKvAdapter,
  type CloudflareKvMetadata,
} from '~/storage/cloudflare-kv';

const textEncoder = new TextEncoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isKvNamespace = (value: unknown): value is KVNamespace =>
  isRecord(value) &&
  ['delete', 'get', 'getWithMetadata', 'list', 'put'].every(
    (method) => typeof value[method] === 'function',
  );

const getKvNamespace = (): KVNamespace => {
  const binding: unknown = Reflect.get(env, 'KV_STORE');
  if (!isKvNamespace(binding)) throw new Error('Expected KV_STORE to be configured');
  return binding;
};

const expectFilesError = async (
  promise: Promise<unknown>,
  code: 'NotFound' | 'Provider',
  permanent?: boolean,
): Promise<void> => {
  await expect(promise).rejects.toBeInstanceOf(FilesError);
  await expect(promise).rejects.toMatchObject({
    code,
    ...(permanent === undefined ? {} : { permanent }),
  });
};

interface BodyCase {
  body: () => Body;
  expected: Uint8Array;
  expectedType: string;
  name: string;
}

const bodyCases: BodyCase[] = [
  {
    body: () => 'héllo',
    expected: textEncoder.encode('héllo'),
    expectedType: 'text/plain; charset=utf-8',
    name: 'string',
  },
  {
    body: () => Uint8Array.of(1, 2, 3),
    expected: Uint8Array.of(1, 2, 3),
    expectedType: 'application/octet-stream',
    name: 'Uint8Array',
  },
  {
    body: () => Uint8Array.of(4, 5, 6).buffer,
    expected: Uint8Array.of(4, 5, 6),
    expectedType: 'application/octet-stream',
    name: 'ArrayBuffer',
  },
  {
    body: () => new DataView(Uint8Array.of(7, 8, 9).buffer),
    expected: Uint8Array.of(7, 8, 9),
    expectedType: 'application/octet-stream',
    name: 'ArrayBufferView',
  },
  {
    body: () => new Blob(['blob'], { type: 'text/blob' }),
    expected: textEncoder.encode('blob'),
    expectedType: 'text/blob',
    name: 'Blob',
  },
  {
    body: () => new File(['file'], 'artifact.bin', { type: 'text/file' }),
    expected: textEncoder.encode('file'),
    expectedType: 'text/file',
    name: 'File',
  },
  {
    body: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.of(10, 11));
          controller.enqueue(Uint8Array.of(12));
          controller.close();
        },
      }),
    expected: Uint8Array.of(10, 11, 12),
    expectedType: 'application/octet-stream',
    name: 'ReadableStream',
  },
];

describe('cloudflareKv()', () => {
  let adapter: CloudflareKvAdapter;
  let binding: KVNamespace;
  let files: Files<CloudflareKvAdapter>;

  beforeEach(async () => {
    await reset();
    binding = getKvNamespace();
    adapter = cloudflareKv({ binding });
    files = new Files({ adapter });
  });

  test('advertises only the capabilities Workers KV actually supports', () => {
    expect(adapter.name).toBe('cloudflare-kv');
    expect(adapter.raw).toBe(binding);
    expect(files.capabilities).toEqual({
      cacheControl: false,
      delimiter: false,
      metadata: true,
      multipart: false,
      rangeRead: false,
      serverSideCopy: false,
      signedUrl: { supported: false },
      uploadProgress: false,
    });
  });

  test.each(bodyCases)('uploads and downloads a $name body', async (bodyCase) => {
    const key = `body-${bodyCase.name}`;
    const upload = await files.upload(key, bodyCase.body());

    expect(upload).toMatchObject({
      contentType: bodyCase.expectedType,
      key,
      size: bodyCase.expected.byteLength,
    });

    const downloaded = await files.download(key);
    expect(downloaded.type).toBe(bodyCase.expectedType);
    expect(downloaded.size).toBe(bodyCase.expected.byteLength);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bodyCase.expected);
  });

  test('persists metadata needed by download, head, and metadata-only listings', async () => {
    const startedAt = Date.now();
    await files.upload('artifact', 'payload', {
      contentType: 'application/x-tar',
      metadata: { 'x-artifact-tag': 'signed-tag' },
    });

    const rawList = await binding.list<CloudflareKvMetadata>({ prefix: 'artifact' });
    expect(rawList.keys[0]?.metadata).toMatchObject({
      contentType: 'application/x-tar',
      metadata: { 'x-artifact-tag': 'signed-tag' },
      size: 7,
    });
    expect(rawList.keys[0]?.metadata?.createdAt).toBeGreaterThanOrEqual(startedAt);

    const head = await files.head('artifact');
    expect(head).toMatchObject({
      key: 'artifact',
      metadata: { 'x-artifact-tag': 'signed-tag' },
      size: 7,
      type: 'application/x-tar',
    });
    expect(await head.text()).toBe('payload');

    const listed = await files.list({ prefix: 'artifact' });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      key: 'artifact',
      metadata: { 'x-artifact-tag': 'signed-tag' },
      size: 7,
      type: 'application/x-tar',
    });
  });

  test('supports prefix listing and KV cursor pagination', async () => {
    await files.upload('artifact-a', 'a');
    await files.upload('artifact-b', 'b');
    await files.upload('other', 'c');

    const first = await files.list({ limit: 1, prefix: 'artifact-' });
    expect(first.items.map((item) => item.key)).toEqual(['artifact-a']);
    expect(first.cursor).toEqual(expect.any(String));

    const second = await files.list({
      cursor: first.cursor,
      limit: 1,
      prefix: 'artifact-',
    });
    expect(second.items.map((item) => item.key)).toEqual(['artifact-b']);
  });

  test('checks existence without confusing a longer prefixed key for an exact key', async () => {
    await files.upload('artifact-child', 'payload');

    expect(await files.exists('artifact')).toBe(false);
    expect(await files.exists('artifact-child')).toBe(true);
  });

  test('copies bytes and metadata, then deletes objects', async () => {
    await files.upload('source', 'payload', {
      contentType: 'application/x-tar',
      metadata: { 'x-artifact-tag': 'tag' },
    });

    await files.copy('source', 'copy');
    const copied = await files.download('copy');
    expect(await copied.text()).toBe('payload');
    expect(copied).toMatchObject({
      metadata: { 'x-artifact-tag': 'tag' },
      size: 7,
      type: 'application/x-tar',
    });

    await files.delete('source');
    expect(await files.exists('source')).toBe(false);
    expect(await files.exists('copy')).toBe(true);
  });

  test('keeps legacy KV objects readable with an explicit listing-size fallback', async () => {
    const createdAtEpochMilliseconds = Date.now() - 1000;
    await binding.put('legacy', 'legacy-body', {
      metadata: {
        createdAtEpochMilliseconds,
        customMetadata: { 'x-artifact-tag': 'legacy-tag' },
      },
    });

    const listed = await files.list({ prefix: 'legacy' });
    expect(listed.items[0]).toMatchObject({
      key: 'legacy',
      lastModified: createdAtEpochMilliseconds,
      metadata: { 'x-artifact-tag': 'legacy-tag' },
      // Legacy metadata never recorded size. list() intentionally avoids an
      // N+1 body read; the single-key APIs below still report the exact size.
      size: 0,
      type: 'application/octet-stream',
    });

    const head = await files.head('legacy');
    expect(head.size).toBe(11);
    expect(await head.text()).toBe('legacy-body');

    const downloaded = await files.download('legacy');
    expect(downloaded.size).toBe(11);
    expect(downloaded.metadata).toEqual({ 'x-artifact-tag': 'legacy-tag' });
    expect(await downloaded.text()).toBe('legacy-body');
  });

  test('applies a native expiration TTL', async () => {
    const now = Math.floor(Date.now() / 1000);
    files = new Files({ adapter: cloudflareKv({ binding, expirationTtl: 60 }) });

    await files.upload('expiring', 'payload');

    const rawList = await binding.list({ prefix: 'expiring' });
    expect(rawList.keys[0]?.expiration).toBeGreaterThanOrEqual(now + 59);
    expect(rawList.keys[0]?.expiration).toBeLessThanOrEqual(now + 61);
  });

  test('rejects invalid expiration TTL configuration', () => {
    expect(() => cloudflareKv({ binding, expirationTtl: 59 })).toThrowError(
      expect.objectContaining({ code: 'Provider', permanent: true }),
    );
  });

  test('rejects an unknown-length stream above the KV value limit before writing', async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(CLOUDFLARE_KV_MAX_VALUE_SIZE + 1));
        controller.close();
      },
    });

    await expectFilesError(files.upload('oversized', oversized), 'Provider', true);
    expect(await files.exists('oversized')).toBe(false);
  });

  test('rejects metadata above the KV metadata limit before writing', async () => {
    await expectFilesError(
      files.upload('oversized-metadata', 'body', { metadata: { value: 'x'.repeat(1024) } }),
      'Provider',
      true,
    );
    expect(await files.exists('oversized-metadata')).toBe(false);
  });

  test('uses FilesError for missing objects and unsupported URL operations', async () => {
    await expectFilesError(files.download('missing'), 'NotFound');
    await expectFilesError(files.head('missing'), 'NotFound');
    await expectFilesError(files.copy('missing', 'copy'), 'NotFound');
    await expectFilesError(files.url('missing'), 'Provider', true);
    await expectFilesError(files.signedUploadUrl('missing', { expiresIn: 60 }), 'Provider', true);
  });
});
