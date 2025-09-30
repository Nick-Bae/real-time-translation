// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  eslint: {
    // optional: lets the production build succeed even if ESLint finds problems
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
