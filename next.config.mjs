/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Google APIs node client is only ever imported from server-side modules
  // (route handlers / server actions). Keeping it external avoids bundling the
  // whole SDK — and its optional deps — into the serverless output.
  experimental: {
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
