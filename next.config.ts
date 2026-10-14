import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets a verification build run without replacing the .next folder a running server uses.
  distDir: process.env.SAYPACK_DIST_DIR || ".next",
  // The Docker build sets this to get a self-contained server.js; `npm start` keeps the normal output.
  output: process.env.SAYPACK_STANDALONE ? "standalone" : undefined,
};

export default nextConfig;
