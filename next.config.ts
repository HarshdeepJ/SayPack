import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets a verification build run without replacing the .next folder a running server uses.
  distDir: process.env.SAYPACK_DIST_DIR || ".next",
};

export default nextConfig;
