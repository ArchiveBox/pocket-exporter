/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Ignore the articles folder from webpack watching
  webpack: (config, { isServer, dev }) => {
    if (dev) {
      config.watchOptions = {
        poll: false,
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.next/**',
          '**/articles/**',
          '**/.env',
          '**/.fetch_state.json',
        ],
      }
    }
    return config
  },
  // Experimental features
  experimental: {
    // This helps reduce the watched files
    optimizePackageImports: ['@radix-ui/react-*'],
  },
  // Disable Fast Refresh for certain routes
  onDemandEntries: {
    // Period (in ms) where the server will keep pages in the buffer
    maxInactiveAge: 25 * 1000,
    // Number of pages that should be kept simultaneously without being disposed
    pagesBufferLength: 2,
  },
}

export default nextConfig