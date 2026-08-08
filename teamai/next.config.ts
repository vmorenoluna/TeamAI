import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  // Prevent Turbopack from tracing next.config.ts into the NFT output —
  // it's a build config file, not a runtime dependency.
  outputFileTracingExcludes: {
    '*': ['next.config.*'],
  },
};

export default nextConfig;
