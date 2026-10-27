import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { promises as fs } from "node:fs";

const production = process.argv.includes("production");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getNamedImportAliases(contents, exportName, moduleNames) {
  const aliases = new Set([exportName]);
  const importPattern = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
  let match;
  while ((match = importPattern.exec(contents)) !== null) {
    const [, specifiers, moduleName] = match;
    if (!moduleNames.includes(moduleName)) continue;
    for (const specifier of specifiers.split(",")) {
      const parts = specifier.trim().split(/\s+as\s+/);
      if (parts[0] === exportName) aliases.add(parts[1] ?? exportName);
    }
  }
  return [...aliases];
}

/** SDK 用 import.meta.url 定位自己的文件；打成 cjs 后要换成 __filename。做法与 MakerPilot 相同。 */
function patchSdkImportMetaUrl(contents) {
  let patched = contents.replace("createRequire(import.meta.url)", "createRequire(__filename)");
  for (const alias of getNamedImportAliases(patched, "createRequire", ["module", "node:module"])) {
    patched = patched.replace(new RegExp(`\\b${escapeRegExp(alias)}\\(import\\.meta\\.url\\)`, "g"), `${alias}(__filename)`);
  }
  for (const alias of getNamedImportAliases(patched, "fileURLToPath", ["url", "node:url"])) {
    patched = patched.replace(new RegExp(`\\b${escapeRegExp(alias)}\\(import\\.meta\\.url\\)`, "g"), "__filename");
  }
  return patched;
}

const patchSdkImportMeta = {
  name: "patch-sdk-import-meta",
  setup(build) {
    build.onLoad(
      { filter: /[\\/]node_modules[\\/](?:@anthropic-ai[\\/]claude-agent-sdk[\\/](?:sdk|core(?:-[A-Za-z0-9]+)?)\.mjs)$/ },
      async (args) => ({ contents: patchSdkImportMetaUrl(await fs.readFile(args.path, "utf8")), loader: "js" })
    );
  }
};

/** SDK 的 /core 入口只在 createSdkMcpServer 里用到 zod 与 MCP peer，我们不用，标成无副作用让 esbuild 丢掉。 */
const omitUnusedClaudeSdkPeers = {
  name: "omit-unused-claude-sdk-peers",
  setup(build) {
    build.onResolve({ filter: /^(?:zod|@modelcontextprotocol\/sdk)(?:\/|$)/ }, async (args) => {
      if (args.pluginData?.omitUnusedClaudeSdkPeers) return undefined;
      if (!/[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-agent-sdk[\\/]/.test(args.importer)) return undefined;
      const result = await build.resolve(args.path, {
        importer: args.importer,
        kind: args.kind,
        pluginData: { omitUnusedClaudeSdkPeers: true },
        resolveDir: args.resolveDir
      });
      return result.errors.length > 0 ? result : { ...result, sideEffects: false };
    });
  }
};

/** Obsidian 渲染进程里的 setTimeout 返回数字，没有 unref；SDK 内部的 timer.unref() 会炸，改成可选调用。 */
const guardTimerUnref = {
  name: "guard-timer-unref",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      const file = "main.js";
      const source = await fs.readFile(file, "utf8");
      const patched = source.replace(/\.unref\(\)/g, ".unref?.()");
      if (patched !== source) await fs.writeFile(file, patched, "utf8");
    });
  }
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtinModules, "node:*"],
  format: "cjs",
  target: "es2022",
  platform: "node",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  loader: { ".wasm": "binary" },
  plugins: [patchSdkImportMeta, omitUnusedClaudeSdkPeers, guardTimerUnref],
  outfile: "main.js"
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
