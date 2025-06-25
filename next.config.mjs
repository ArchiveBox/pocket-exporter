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
  
  // Speed up builds
  compress: true,
  poweredByHeader: false,
  generateEtags: false,
  // Ignore the articles folder from webpack watching
  webpack: (config, { isServer, dev }) => {
    // Exclude sessions directory from module resolution
    config.resolve.modules = config.resolve.modules.filter(
      (mod) => !mod.includes('sessions')
    );
    
    if (dev && isServer) {
      // Speed up server-side compilation
      config.externals = [...(config.externals || []), 'fs', 'path', 'crypto'];
    }
    
    if (dev) {
      config.watchOptions = {
        poll: false,
        aggregateTimeout: 300,
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.next/**',
          '**/articles/**',
          '**/.env',
          '**/.fetch_state.json',
          "**/sessions/**",
          "**/*.log",
          "**/tmp/**",
          "**/.DS_Store",
          "**/._*",
          "**/Thumbs.db"
        ],
      }
      
      // Reduce module invalidation
      config.cache = {
        type: 'filesystem',
      }
      
      // Optimize rebuilds
      config.optimization = {
        ...config.optimization,
        removeAvailableModules: false,
        removeEmptyChunks: false,
        splitChunks: false,
      }
      
      // Don't watch API routes for changes during requests
      if (config.module?.rules) {
        config.module.rules.push({
          test: /\/(api)\//,
          sideEffects: false,
        })
      }
    }
    return config
  },
  // Experimental features
  experimental: {
    // Optimize all Radix UI imports
    optimizePackageImports: [
      '@radix-ui/react-accordion',
      '@radix-ui/react-alert-dialog',
      '@radix-ui/react-aspect-ratio',
      '@radix-ui/react-avatar',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-collapsible',
      '@radix-ui/react-context-menu',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-hover-card',
      '@radix-ui/react-label',
      '@radix-ui/react-menubar',
      '@radix-ui/react-navigation-menu',
      '@radix-ui/react-popover',
      '@radix-ui/react-progress',
      '@radix-ui/react-radio-group',
      '@radix-ui/react-scroll-area',
      '@radix-ui/react-select',
      '@radix-ui/react-separator',
      '@radix-ui/react-slider',
      '@radix-ui/react-slot',
      '@radix-ui/react-switch',
      '@radix-ui/react-tabs',
      '@radix-ui/react-toast',
      '@radix-ui/react-toggle',
      '@radix-ui/react-toggle-group',
      '@radix-ui/react-tooltip',
      'lucide-react'
    ],
  },
  
  
  // External packages for server components
  serverExternalPackages: ['archiver'],
  
  // Reduce revalidation in dev
  reactStrictMode: false, // Disable double rendering in dev
  // Disable Fast Refresh for certain routes
  onDemandEntries: {
    // Period (in ms) where the server will keep pages in the buffer
    maxInactiveAge: 25 * 1000,
    // Number of pages that should be kept simultaneously without being disposed
    pagesBufferLength: 2,
  },
}

export default nextConfig
