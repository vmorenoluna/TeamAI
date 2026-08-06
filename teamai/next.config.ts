import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  turbopack: {
    root: /* turbopackIgnore: true */ __dirname,
  },
};

export default nextConfig;
