/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Google APIs node client is only ever imported from server-side modules
  // (route handlers / server actions). Keeping it external avoids bundling the
  // whole SDK — and its optional deps — into the serverless output.
  experimental: {
    serverActions: {
      // Next caps Server Action bodies at 1 MB by default, which is under the
      // 4 MB the logo uploader already advertises — so a 2 MB logo failed with a
      // body-size error rather than the uploader's own message. Reference
      // templates are full-size posters and hit the same wall harder.
      bodySizeLimit: '8mb',
    },
    // `@resvg/resvg-js` ships a platform-specific `.node` addon, which webpack
    // cannot bundle — it has to be required at runtime from node_modules.
    serverComponentsExternalPackages: [
      'googleapis',
      'google-auth-library',
      '@resvg/resvg-js',
    ],
  },
};

export default nextConfig;
