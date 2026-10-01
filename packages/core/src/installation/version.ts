import pkg from "../../package.json" with { type: "json" }

declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

// Release builds bake OPENCODE_VERSION via --define. In source checkouts the
// package version is the true version — providers like OpenCode Zen reject
// "local" as a User-Agent, so fall back to it instead of "local".
export const InstallationVersion =
  process.env.OPENCODE_VERSION ?? (typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : pkg.version)
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
