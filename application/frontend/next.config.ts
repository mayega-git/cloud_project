import type {NextConfig} from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  // Self-contained server output, used by the container image.
  output: 'standalone',
};

export default config;
