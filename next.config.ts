import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["pg"],
  allowedDevOrigins: ["127.0.0.1"],
  agentRules: false,
};
export default config;
