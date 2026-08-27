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
    // `@resvg/resvg-js` and `sharp` both ship platform-specific `.node` addons,
    // which webpack cannot bundle — they have to be required at runtime from
    // node_modules. For sharp the addon is resolved per-platform out of
    // `@img/sharp-<platform>`, so the lockfile has to carry the linux entries
    // even though it is generated on Windows; see the note in logo-key.ts.
    // `playwright` is here for a different reason from the addons below it: it
    // is pure JS, but it resolves its browser registry, its driver and its
    // injected page scripts from paths computed relative to its own files at
    // runtime. Bundled, those paths point inside the webpack output and the
    // launch fails with a missing-driver error that names a directory nobody
    // wrote.
    serverComponentsExternalPackages: [
      'googleapis',
      'google-auth-library',
      '@resvg/resvg-js',
      'sharp',
      'playwright',
    ],
  },
};

export default nextConfig;
