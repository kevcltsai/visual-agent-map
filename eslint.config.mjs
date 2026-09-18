import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import depend from "eslint-plugin-depend";
import tseslint from "typescript-eslint";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*", "esbuild.config.*", "scripts/*.mjs"]
        }
      }
    }
  },
  {
    files: ["**/*.ts"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      depend,
      obsidianmd
    },
    rules: {
      "@typescript-eslint/no-base-to-string": "warn",
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "depend/ban-dependencies": "warn",
      "obsidianmd/detach-leaves": "warn",
      "obsidianmd/no-static-styles-assignment": "warn",
      "obsidianmd/no-unsupported-api": "warn",
      "obsidianmd/settings-tab/no-manual-html-headings": "warn"
    },
  },
  {
    files: ["package.json"],
    plugins: { depend },
    rules: { "depend/ban-dependencies": "warn" },
  },
  {
    ignores: [
      "main.js",
      "visual-agent-map/main.js",
      "tests/**"
    ]
  }
]);
