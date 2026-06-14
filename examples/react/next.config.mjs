/** @type {import('next').NextConfig} */
const nextConfig = {
  // `pg` is a server-only dependency pulled in by @kozou/introspect for the
  // schema introspection pass. Keep it external so the server bundler does
  // not try to statically bundle its optional/native requires.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
