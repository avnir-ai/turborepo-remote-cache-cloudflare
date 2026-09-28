# Avnir remote cache

This fork starts at upstream commit `b0aaab5c3063dd5f8d15e38e69398a0c040edcda`.
The `avnir-turbo-cache` Worker stores artifacts in the private R2 bucket of the
same name in Avnir Corp Account. The daily 03:00 UTC cleanup removes artifacts
older than 720 hours (30 days). Do not enable R2 public access.

Production endpoint: <https://avnir-turbo-cache.avnir.workers.dev>.

## Deployment

Use Node from `.nvmrc` and the pinned package manager:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm deploy
```

Provision the R2 bucket once before the first deployment:
`pnpm wrangler r2 bucket create avnir-turbo-cache`.
Set `TURBO_TOKEN` using `pnpm wrangler secret put TURBO_TOKEN`, supplying its
value through the interactive prompt or standard input rather than shell history.
The token must be a strong random bearer token and must never be committed.

GitHub deployment is manual via the **Deploy to Cloudflare Workers** workflow.
It requires the repository variable `CLOUDFLARE_ACCOUNT_ID` and repository
secrets `CLOUDFLARE_API_TOKEN` and `TURBO_TOKEN`. Use a scoped Cloudflare API token
for this Worker and R2 account; do not copy a developer's Wrangler OAuth token.
The workflow fails before building if any required setting is missing. Upstream
documentation and release workflows are removed from this deployment fork.

## Clients

Avnir loads credentials from its ignored `.secrets/turbo.env`, with shell and CI
variables taking precedence. Keep that file readable only by its owner:

```dotenv
TURBO_API=https://avnir-turbo-cache.avnir.workers.dev
TURBO_TEAM=team_avnir
TURBO_TOKEN=<random-bearer-token>
TURBO_REMOTE_CACHE_SIGNATURE_KEY=<different-random-signing-key>
```

The signing key is shared only by trusted Turbo clients; the Worker does not
need it. Enable `remoteCache.signature` in the client Turbo configuration. The
bearer token grants read and write access and must not be supplied to untrusted
pull requests. Store the API/team as GitHub variables and the token/signing key
as GitHub secrets in the client repository. The cache endpoint requires bearer
authentication for all artifact and management requests.

For token rotation, update the Worker secret and all client secrets together.
For signing key rotation, update trusted clients together; old artifacts will
be rejected and rebuilt. Cache unavailability should fall back to local tasks.
