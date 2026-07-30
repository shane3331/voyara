/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return {
      // The traveller app is a single static file in /public.
      // Serving it at the root keeps it editable without a React rewrite.
      beforeFiles: [{ source: '/', destination: '/app.html' }],
      afterFiles: [],
      fallback: []
    };
  },
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }
      ]
    }];
  }
};
export default nextConfig;
