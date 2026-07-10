import { Files } from 'files-sdk';
import { memory } from 'files-sdk/memory';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { app } from '~/routes';
import { DEFAULT_TEAM_ID } from '~/routes/v8/artifacts';

import { createTestAppContext, withAuthorization, type TestAppContext } from '../../helpers/app';

describe('v8 Artifacts API', () => {
  let artifactContent: string;
  let artifactId: string;
  let artifactTag: string;
  let context: TestAppContext;
  let teamId: string;

  beforeEach(() => {
    context = createTestAppContext();
    artifactId = `artifact-${crypto.randomUUID()}`;
    artifactTag = `tag-${crypto.randomUUID()}`;
    teamId = `team-${crypto.randomUUID()}`;
    artifactContent = '🎉😄😇';
  });

  afterEach(async () => {
    await context.waitForBackgroundWork();
  });

  const artifactUrl = (query = `teamId=${teamId}`) =>
    `http://localhost/v8/artifacts/${artifactId}${query ? `?${query}` : ''}`;

  const getArtifact = (query?: string) =>
    app.fetch(
      new Request(artifactUrl(query), {
        headers: withAuthorization(),
      }),
      context.bindings,
    );

  const headArtifact = (query?: string) =>
    app.fetch(
      new Request(artifactUrl(query), {
        headers: withAuthorization(),
        method: 'HEAD',
      }),
      context.bindings,
    );

  const putArtifact = (query?: string, tag?: string) =>
    app.fetch(
      new Request(artifactUrl(query), {
        body: artifactContent,
        headers: withAuthorization({
          'Content-Type': 'application/octet-stream',
          ...(tag ? { 'x-artifact-tag': tag } : {}),
        }),
        method: 'PUT',
      }),
      context.bindings,
    );

  describe('authentication', () => {
    test.each(['GET', 'HEAD'])('rejects an unauthenticated %s request', async (method) => {
      const response = await app.fetch(
        new Request(artifactUrl(), {
          method,
        }),
        context.bindings,
      );

      expect(response.status).toBe(401);
    });

    test('rejects an unauthenticated PUT request', async () => {
      const response = await app.fetch(
        new Request(artifactUrl(), {
          body: artifactContent,
          headers: { 'Content-Type': 'application/octet-stream' },
          method: 'PUT',
        }),
        context.bindings,
      );

      expect(response.status).toBe(401);
    });

    test('does not let an unauthenticated request read a cached artifact', async () => {
      await context.files.upload(`${teamId}/${artifactId}`, artifactContent);
      expect((await getArtifact()).status).toBe(200);
      await context.waitForBackgroundWork();

      const response = await app.fetch(new Request(artifactUrl()), context.bindings);
      expect(response.status).toBe(401);
    });
  });

  describe('GET artifact endpoint', () => {
    beforeEach(async () => {
      await context.files.upload(`${teamId}/${artifactId}`, artifactContent, {
        contentType: 'application/octet-stream',
        metadata: { artifactTag },
      });
    });

    test('uses the legacy default team ID when no team is provided', async () => {
      expect((await getArtifact('')).status).toBe(404);

      await context.files.upload(`${DEFAULT_TEAM_ID}/${artifactId}`, artifactContent);

      expect((await getArtifact('')).status).toBe(200);
    });

    test('returns 404 when the artifact does not exist', async () => {
      const response = await app.fetch(
        new Request(`${artifactUrl()}-missing`, { headers: withAuthorization() }),
        context.bindings,
      );

      expect(response.status).toBe(404);
    });

    test.each(['teamId', 'slug'])('accepts the %s team selector', async (selector) => {
      expect((await getArtifact(`${selector}=${teamId}`)).status).toBe(200);
    });

    test('returns content, signed-cache metadata, and cache headers', async () => {
      const response = await getArtifact();

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(response.headers.get('x-artifact-tag')).toBe(artifactTag);
      expect(response.headers.get('Cache-Control')).toBe('max-age=300, stale-while-revalidate=300');
      expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(artifactContent);
    });

    test('caches authorized artifact responses for subsequent reads', async () => {
      const response = await getArtifact();
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      await context.waitForBackgroundWork();

      await context.files.delete(`${teamId}/${artifactId}`);
      const cachedResponse = await getArtifact();

      expect(cachedResponse.status).toBe(200);
      expect(new TextDecoder().decode(await cachedResponse.arrayBuffer())).toBe(artifactContent);
    });
  });

  describe('PUT artifact endpoint', () => {
    test('stores an artifact under the default team ID', async () => {
      const response = await putArtifact('');

      expect(response.status).toBe(202);
      expect(await (await context.files.download(`${DEFAULT_TEAM_ID}/${artifactId}`)).text()).toBe(
        artifactContent,
      );
    });

    test.each(['teamId', 'slug'])('stores an artifact selected by %s', async (selector) => {
      const response = await putArtifact(`${selector}=${teamId}`);

      expect(response.status).toBe(202);
      expect(await (await context.files.download(`${teamId}/${artifactId}`)).text()).toBe(
        artifactContent,
      );
    });

    test('persists an artifact tag through Files SDK metadata', async () => {
      const response = await putArtifact(undefined, artifactTag);

      expect(response.status).toBe(202);
      const artifact = await context.files.head(`${teamId}/${artifactId}`);
      expect(artifact.metadata).toMatchObject({ artifacttag: artifactTag });
      expect(Number(artifact.metadata?.cachecreatedat)).toEqual(expect.any(Number));
    });

    test('fails signed caching explicitly when the adapter lacks metadata support', async () => {
      const adapter = memory();
      Object.defineProperty(adapter, 'supportsMetadata', { value: false });
      context = createTestAppContext();
      context.bindings.FILES = new Files({ adapter });

      const response = await putArtifact(undefined, artifactTag);

      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({
        error: 'The configured storage adapter does not support signed caching metadata',
      });
    });

    test('rejects a request without the Turborepo artifact content type', async () => {
      const response = await app.fetch(
        new Request(artifactUrl(), {
          body: artifactContent,
          headers: withAuthorization(),
          method: 'PUT',
        }),
        context.bindings,
      );

      expect(response.status).toBe(400);
    });

    test('requires a known length for native R2 uploads', async () => {
      Object.defineProperty(context.adapter, 'name', { value: 'r2-binding' });

      const response = await putArtifact();

      expect(response.status).toBe(411);
      expect(await response.text()).toContain('Content-Length is required');
    });

    test('streams a known-length upload through the native R2 path', async () => {
      Object.defineProperty(context.adapter, 'name', { value: 'r2-binding' });
      const response = await app.fetch(
        new Request(artifactUrl(), {
          body: artifactContent,
          headers: withAuthorization({
            'Content-Length': String(new TextEncoder().encode(artifactContent).byteLength),
            'Content-Type': 'application/octet-stream',
          }),
          method: 'PUT',
        }),
        context.bindings,
      );

      expect(response.status).toBe(202);
      expect(await (await context.files.download(`${teamId}/${artifactId}`)).text()).toBe(
        artifactContent,
      );
    });
  });

  describe('HEAD artifact endpoint', () => {
    beforeEach(async () => {
      await context.files.upload(`${teamId}/${artifactId}`, artifactContent, {
        metadata: { artifactTag },
      });
    });

    test('uses the default team ID when no team is provided', async () => {
      expect((await headArtifact('')).status).toBe(404);
      await context.files.upload(`${DEFAULT_TEAM_ID}/${artifactId}`, artifactContent);
      expect((await headArtifact('')).status).toBe(200);
    });

    test('returns 404 without a body when the artifact does not exist', async () => {
      const response = await app.fetch(
        new Request(`${artifactUrl()}-missing`, {
          headers: withAuthorization(),
          method: 'HEAD',
        }),
        context.bindings,
      );

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    });

    test.each(['teamId', 'slug'])(
      'checks an artifact selected by %s without downloading a body',
      async (selector) => {
        const response = await headArtifact(`${selector}=${teamId}`);

        expect(response.status).toBe(200);
        expect(response.headers.get('x-artifact-tag')).toBe(artifactTag);
        expect(await response.text()).toBe('');
      },
    );
  });

  describe('Artifact events endpoint', () => {
    test('accepts a valid Turborepo event batch', async () => {
      const response = await app.fetch(
        new Request('http://localhost/v8/artifacts/events', {
          body: JSON.stringify([
            {
              duration: 400,
              event: 'HIT',
              hash: '12HKQaOmR5t5Uy6vdcQsNIiZgHGB',
              sessionId: '30fb7fdf-8124-4fce-8121-d525170942a0',
              source: 'LOCAL',
            },
          ]),
          headers: withAuthorization({ 'Content-Type': 'application/json' }),
          method: 'POST',
        }),
        context.bindings,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});
    });
  });
});
