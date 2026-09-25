import type { NextConfig } from "next";

const modelFiles = [
  "./models/mobilenet_v2_100_224/**/*",
  "./node_modules/@tensorflow/tfjs-backend-wasm/dist/*.wasm",
];

const nextConfig: NextConfig = {
  agentRules: false,
  // Loaded with Node's own require at runtime instead of being bundled:
  // the model weights ship as large JS modules and the wasm backend reads
  // its .wasm files from disk.
  serverExternalPackages: [
    "@tensorflow/tfjs",
    "@tensorflow/tfjs-backend-wasm",
    "@tensorflow-models/mobilenet",
    "nsfwjs",
    "sharp",
  ],
  outputFileTracingIncludes: {
    "/api/queues/moderation": modelFiles,
    "/api/cron/sweep": modelFiles,
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
