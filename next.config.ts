import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Runtime configuration and local media routes must not be prerendered.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
