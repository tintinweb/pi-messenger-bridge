import { defineConfig } from "tsdown";

export default defineConfig({
  format: ["esm"],
  deps: {
    alwaysBundle: [/./],
    neverBundle: [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
      "qrcode-terminal",
    ],
  },
  dts: true,
  sourcemap: true,
  splitting: false,
});
