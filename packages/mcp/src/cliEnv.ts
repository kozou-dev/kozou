// Environment → rebinding-guard options for the `kozou-mcp` bin.
//
// Its own module because cli.ts runs `main()` at import time, so nothing there
// can be unit-tested. The mapping is the part worth asserting: this CLI reads no
// config file, so the environment is the only place the reachable address and
// any extra Host names can be stated, and a deployment behind a tunnel or a
// `Host`-preserving proxy is refused on every request without them.

/** The `advertisedUrl` / `allowedHosts` options named by the environment, with
 *  absent and whitespace-only values read as unset (both shipped Compose stacks
 *  forward these as `${VAR:-}`, so an empty value is the ordinary case rather
 *  than a mistake). `allowedHosts` is comma-separated, matching the CLI config
 *  key's own env override. Values are passed through unvalidated: the server
 *  refuses an unusable entry at startup, and duplicating the predicate here
 *  would give it a second place to drift. */
export function guardOptionsFromEnv(env: NodeJS.ProcessEnv): {
  advertisedUrl?: string;
  allowedHosts?: string[];
} {
  const advertisedUrl = env.KOZOU_MCP_HTTP_ADVERTISED_URL?.trim();
  const allowedHosts = (env.KOZOU_MCP_HTTP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return {
    ...(advertisedUrl === undefined || advertisedUrl === '' ? {} : { advertisedUrl }),
    ...(allowedHosts.length === 0 ? {} : { allowedHosts }),
  };
}
