import type { NextConfig } from 'next';

const config: NextConfig = {
  // Turbopack would otherwise infer the parent repository (which has its own lockfile) as the root.
  turbopack: { root: import.meta.dirname },
  devIndicators: false,
};

export default config;
