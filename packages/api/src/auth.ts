// HTTP adapter over the shared JWT verification in `@kozou/core/auth`. The
// verification and role-resolution semantics live in core (transport
// neutral); this module maps its KozouAuthError kinds onto the REST error
// contract — 'unauthorized' → 401, 'forbidden' → 403 — so the wire format
// (status codes, error codes, messages) is unchanged. The re-exported
// names below are the same public surface `@kozou/api` has always had.

import {
  createAuthenticator as createCoreAuthenticator,
  signServiceToken as signCoreServiceToken,
  KozouAuthError,
  type AuthConfig,
  type AuthContext,
  type Authenticator,
  type JwtAlgorithm,
  type ServiceTokenOptions,
} from '@kozou/core/auth';
import { unauthorized, forbidden } from './errors.js';

export type { AuthConfig, AuthContext, Authenticator, JwtAlgorithm, ServiceTokenOptions };

/** Validate config (throws a plain Error at startup on misconfiguration)
 *  and return a verifier whose `authenticate` throws a 401 KozouApiError
 *  for any token problem, 403 for a role one. */
export function createAuthenticator(config: AuthConfig): Authenticator {
  const core = createCoreAuthenticator(config, '@kozou/api auth');
  return {
    roleClaim: core.roleClaim,
    claimsGuc: core.claimsGuc,
    async authenticate(header) {
      try {
        return await core.authenticate(header);
      } catch (err) {
        if (err instanceof KozouAuthError) {
          throw err.kind === 'forbidden' ? forbidden(err.message) : unauthorized(err.message);
        }
        throw err;
      }
    },
  };
}

/** Mint an HS256 service token for a trusted same-host caller (the bundled
 *  Admin UI under `kozou dev`). See `signServiceToken` in `@kozou/core/auth`
 *  for the full semantics. */
export function signServiceToken(opts: ServiceTokenOptions): Promise<string> {
  return signCoreServiceToken(opts, '@kozou/api signServiceToken');
}
