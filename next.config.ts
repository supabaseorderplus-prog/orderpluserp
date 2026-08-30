import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Exclude server-only packages from the client bundle
  serverExternalPackages: [
    'mqtt',
    'bufferutil',
    'utf-8-validate',
    'tesseract.js',
    '@tesseract.js-data/eng',
  ],
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') {
      return [];
    }

    return {
      fallback: [
        {
          source: '/api/:path*',
          destination: 'http://localhost:4000/api/:path*',
        },
      ],
    };
  },
} as NextConfig;

export default nextConfig;
