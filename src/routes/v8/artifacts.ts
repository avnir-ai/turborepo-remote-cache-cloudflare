import { vValidator } from '@hono/valibot-validator';
import { FilesError, type Body } from 'files-sdk';
import { HTTPException } from 'hono/http-exception';
import { Hono } from 'hono/tiny';
import * as v from 'valibot';

import type { AppBindings, WaitUntil } from '../../runtime/app-env';

import { bearerAuthFromEnv } from '../auth';

export const DEFAULT_TEAM_ID = 'team_default_team';
const ARTIFACT_CACHE_NAME = 'r2-artifacts';
const ARTIFACT_CACHE_CONTROL = 'max-age=300, stale-while-revalidate=300';
const ARTIFACT_TAG_METADATA_KEY = 'artifacttag';

// Route - /v8/artifacts
export const artifactRouter = new Hono<{ Bindings: AppBindings }>();

artifactRouter.use('*', bearerAuthFromEnv);

const vCoerceNumber = () => v.pipe(v.unknown(), v.transform(Number), v.number());

interface UploadBody {
  body: Body;
  pipe?: Promise<void>;
}

const prepareUploadBody = async (
  body: ReadableStream<Uint8Array> | null,
  contentLength?: number,
  adapterName?: string,
): Promise<UploadBody> => {
  if (!body) return { body: new Uint8Array() };
  if (adapterName !== 'r2-binding') return { body };
  if (contentLength === undefined) {
    throw new HTTPException(411, {
      message: 'Content-Length is required when uploading through an R2 binding',
    });
  }
  if (typeof FixedLengthStream !== 'undefined') {
    // Nitro preserves the Content-Length header, but the Request body it exposes
    // is no longer tagged as a fixed-length stream. R2's native binding requires
    // that tag, so restore it without buffering the artifact.
    const fixedLengthBody = new FixedLengthStream(contentLength);
    return {
      body: fixedLengthBody.readable,
      pipe: body.pipeTo(fixedLengthBody.writable),
    };
  }

  // Nitro's Cloudflare development emulator exposes the R2 binding to Node,
  // where FixedLengthStream is unavailable. Buffer only that local fallback;
  // production Workers take the streaming path above.
  const bufferedBody = await new Response(body).arrayBuffer();
  if (bufferedBody.byteLength !== contentLength) {
    throw new HTTPException(400, { message: 'Content-Length does not match the request body' });
  }
  return { body: bufferedBody };
};

const canUseArtifactCache = (request: Request) =>
  request.method === 'GET' && typeof caches !== 'undefined';

const getCachedArtifactResponse = async (request: Request) => {
  if (!canUseArtifactCache(request)) return undefined;

  const artifactCache = await caches.open(ARTIFACT_CACHE_NAME);
  const cachedResponse = await artifactCache.match(request.url);

  if (!cachedResponse) return undefined;
  return cachedResponse;
};

const cacheArtifactResponse = (waitUntil: WaitUntil, request: Request, response: Response) => {
  if (!canUseArtifactCache(request)) return;

  waitUntil(
    caches
      .open(ARTIFACT_CACHE_NAME)
      .then((artifactCache) => artifactCache.put(request.url, response)),
  );
};

const isNotFound = (error: unknown): boolean =>
  error instanceof FilesError && error.code === 'NotFound';

artifactRouter.post(
  '/',
  vValidator(
    'json',
    v.object({
      hashes: v.array(v.string()),
    }),
  ),
  vValidator('query', v.object({ teamId: v.optional(v.string()), slug: v.optional(v.string()) })),
  (c) => {
    const data = c.req.valid('json');
    const { teamId: teamIdQuery, slug } = c.req.valid('query');
    const teamId = teamIdQuery ?? slug ?? DEFAULT_TEAM_ID;
    void data;
    void teamId;
    // TODO: figure out what this route actually does, the OpenAPI spec is unclear
    return c.json({});
  },
);

artifactRouter.get('/status', (c) => {
  const status: 'disabled' | 'enabled' | 'over_limit' | 'paused' = 'enabled';
  return c.json({ status }, 200);
});

artifactRouter.put(
  '/:artifactId',
  vValidator('param', v.object({ artifactId: v.string() })),
  vValidator('query', v.object({ teamId: v.optional(v.string()), slug: v.optional(v.string()) })),
  vValidator(
    'header',
    v.object({
      'content-type': v.literal('application/octet-stream'),
      'content-length': v.optional(v.pipe(vCoerceNumber(), v.integer(), v.minValue(0))),
      'x-artifact-duration': v.optional(vCoerceNumber()),
      'x-artifact-client-ci': v.optional(v.string()),
      'x-artifact-client-interactive': v.optional(
        v.pipe(vCoerceNumber(), v.minValue(0), v.maxValue(1)),
      ),
      'x-artifact-tag': v.optional(v.string()),
    }),
  ),
  async (c) => {
    const { artifactId } = c.req.valid('param');
    const { teamId: teamIdQuery, slug } = c.req.valid('query');
    const teamId = teamIdQuery ?? slug ?? DEFAULT_TEAM_ID;
    const validatedHeaders = c.req.valid('header');

    const files = c.env.FILES;
    const objectKey = `${teamId}/${artifactId}`;

    const artifactTag = validatedHeaders['x-artifact-tag'];
    if (artifactTag && !files.capabilities.metadata) {
      return c.json(
        { error: 'The configured storage adapter does not support signed caching metadata' },
        501,
      );
    }
    const metadata = files.capabilities.metadata
      ? {
          cachecreatedat: String(Date.now()),
          ...(artifactTag ? { [ARTIFACT_TAG_METADATA_KEY]: artifactTag } : {}),
        }
      : undefined;
    const uploadBody = await prepareUploadBody(
      c.req.raw.body,
      validatedHeaders['content-length'],
      files.adapter.name,
    );
    const upload = files.upload(objectKey, uploadBody.body, {
      contentType: 'application/octet-stream',
      metadata,
    });
    await (uploadBody.pipe ? Promise.all([upload, uploadBody.pipe]) : upload);

    const uploadUrl = new URL(`${artifactId}?teamId=${teamId}`, c.req.raw.url).toString();
    return c.json({ urls: [uploadUrl] }, 202);
  },
);

// Hono router .get() method captures both GET and HEAD requests
artifactRouter.get(
  '/:artifactId',
  vValidator('param', v.object({ artifactId: v.string() })),
  vValidator('query', v.object({ teamId: v.optional(v.string()), slug: v.optional(v.string()) })),
  vValidator(
    'header',
    v.object({
      'x-artifact-client-ci': v.optional(v.string()),
      'x-artifact-client-interactive': v.optional(
        v.pipe(vCoerceNumber(), v.minValue(0), v.maxValue(1)),
      ),
    }),
  ),
  async (c) => {
    const { artifactId } = c.req.valid('param');
    const { teamId: teamIdQuery, slug } = c.req.valid('query');
    const teamId = teamIdQuery ?? slug ?? DEFAULT_TEAM_ID;
    const cachedResponse = await getCachedArtifactResponse(c.req.raw);

    if (cachedResponse) {
      return cachedResponse;
    }

    const files = c.env.FILES;
    const objectKey = `${teamId}/${artifactId}`;

    let storedObject;
    try {
      storedObject =
        c.req.raw.method === 'HEAD'
          ? await files.head(objectKey)
          : await files.download(objectKey, { as: 'stream' });
    } catch (error: unknown) {
      if (isNotFound(error)) return c.json({}, 404);
      throw error;
    }

    const responseHeaders: Record<string, string> = {
      'Cache-Control': ARTIFACT_CACHE_CONTROL,
      'Content-Type': 'application/octet-stream',
    };
    // S3 canonicalizes user-metadata keys to lowercase. Keep the camel-case
    // fallback so artifacts uploaded by earlier R2/KV releases remain valid.
    const artifactTag =
      storedObject.metadata?.[ARTIFACT_TAG_METADATA_KEY] ?? storedObject.metadata?.artifactTag;
    if (artifactTag) {
      responseHeaders['x-artifact-tag'] = artifactTag;
    }
    if (c.req.raw.method === 'HEAD') {
      return c.body(null, 200, responseHeaders);
    }

    let responseData = storedObject.stream();

    if (canUseArtifactCache(c.req.raw)) {
      const [clientData, cacheData] = responseData.tee();
      responseData = clientData;
      cacheArtifactResponse(
        c.env.WAIT_UNTIL,
        c.req.raw,
        new Response(cacheData, { headers: responseHeaders, status: 200 }),
      );
    }

    const response = c.body(responseData, 200, responseHeaders);

    return response;
  },
);

artifactRouter.post(
  '/events',
  vValidator(
    'json',
    v.array(
      v.object({
        sessionId: v.string(),
        source: v.union([v.literal('LOCAL'), v.literal('REMOTE')]),
        event: v.union([v.literal('HIT'), v.literal('MISS')]),
        hash: v.string(),
        duration: v.optional(v.number()),
      }),
    ),
  ),
  vValidator('query', v.object({ teamId: v.optional(v.string()), slug: v.optional(v.string()) })),
  vValidator(
    'header',
    v.object({
      'x-artifact-client-ci': v.optional(v.string()),
      'x-artifact-client-interactive': v.optional(
        v.pipe(vCoerceNumber(), v.minValue(0), v.maxValue(1)),
      ),
    }),
  ),
  (c) => {
    const data = c.req.valid('json');
    const { teamId: teamIdQuery, slug } = c.req.valid('query');
    const teamId = teamIdQuery ?? slug ?? DEFAULT_TEAM_ID;
    // TODO: track these events and store them to query later
    void data;
    void teamId;
    return c.json({});
  },
);
