/** @type {import('next').NextConfig} */
const nextConfig = {
  // The traveller app is a static file in /public served through a real
  // route at app/page.tsx. Do NOT reintroduce a rewrite from '/' here:
  // rewrites to a public asset resolve under `next start` locally but not
  // through Vercel's routing layer, which produces a 404 at the root.
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }
      ]
    }];
  },
  // Ensures the traveller app is bundled into the serverless function that
  // renders it, rather than left behind as an untraced asset.
  outputFileTracingIncludes: {
    '/': ['./public/app.html']
  }
};
export default nextConfig;
