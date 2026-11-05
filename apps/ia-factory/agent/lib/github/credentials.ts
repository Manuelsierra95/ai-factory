import { createSign } from "node:crypto";

/**
 * Credencial de GitHub de la fábrica.
 *
 * @remarks
 * Dos formas, en este orden:
 *
 * 1. `FACTORY_GITHUB_TOKEN`: un PAT fine-grained con permisos solo sobre el
 *    repositorio. Es la opción simple.
 * 2. GitHub App: `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` (PEM) y
 *    `GITHUB_INSTALLATION_ID`. El host firma un JWT y pide un installation
 *    token de corta duración a la API de GitHub. El token se cachea hasta
 *    poco antes de caducar.
 *
 * El token se resuelve por llamada y nunca se expone al modelo: el broker
 * del sandbox lo inyecta en la petición de git (ver `git-remote.ts`) y la
 * extensión de GitHub lo usa como cabecera de autorización.
 */

/** Installation tokens live one hour; refresh well before that. */
const TOKEN_TTL_MS = 45 * 60 * 1000;

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

let cached: CachedToken | undefined;

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Signs the RS256 JWT a GitHub App authenticates with.
 *
 * @remarks
 * The `iat` is backdated by a minute so a small clock skew does not reject
 * the token, and `exp` is the maximum GitHub accepts for an app JWT.
 */
function signAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKeyPem);
  return `${signingInput}.${base64Url(signature)}`;
}

/**
 * Mints an installation token from the GitHub App credentials.
 */
async function mintInstallationToken(): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_INSTALLATION_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !installationId || !privateKey) {
    throw new Error(
      "GitHub App auth needs GITHUB_APP_ID, GITHUB_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY.",
    );
  }

  const jwt = signAppJwt(
    appId,
    privateKey.replace(/\\n/g, "\n"),
  );
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `GitHub App token request failed (${response.status}): ${await response.text()}`,
    );
  }

  const body = (await response.json()) as { token?: string; expires_at?: string };
  if (!body.token) {
    throw new Error("GitHub App token response carries no token.");
  }

  return body.token;
}

/**
 * Resolves the token every GitHub operation uses.
 *
 * @remarks
 * The installation token is cached until shortly before it expires, so a
 * build loop that clones, pushes and opens a pull request mints one token,
 * not three. A PAT needs no caching.
 */
export async function resolveGitHubToken(): Promise<string> {
  const pat = process.env.FACTORY_GITHUB_TOKEN;
  if (pat) {
    return pat;
  }

  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const token = await mintInstallationToken();
  cached = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
  return token;
}

/**
 * Whether any GitHub credential is configured.
 *
 * @remarks
 * Used by the sandbox bootstrap to fail early with an actionable message
 * instead of letting `git clone` fail with an opaque 401.
 */
export function hasGitHubCredential(): boolean {
  return Boolean(
    process.env.FACTORY_GITHUB_TOKEN ||
      (process.env.GITHUB_APP_ID &&
        process.env.GITHUB_INSTALLATION_ID &&
        process.env.GITHUB_APP_PRIVATE_KEY),
  );
}
