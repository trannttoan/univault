import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL("./test/fakes/obsidian.ts", import.meta.url)),
		},
	},
	test: {
		include: ["test/**/*.test.ts"],
		setupFiles: ["test/setup.ts"],
	},
});
