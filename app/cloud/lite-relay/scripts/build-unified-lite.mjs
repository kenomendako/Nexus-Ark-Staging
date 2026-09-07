import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const relayRoot = path.resolve(here, "..");
const repositoryRoot = path.resolve(relayRoot, "../..");
const sourceRoot = path.join(repositoryRoot, "mobile_app");
const outputOption = process.argv.indexOf("--output-root");
if (outputOption !== -1 && (!process.argv[outputOption + 1] || process.argv[outputOption + 1].startsWith("--"))) {
  throw new Error("--output-rootには出力先が必要です。");
}
const publicRoot = outputOption === -1
  ? path.join(relayRoot, "public")
  : path.resolve(process.argv[outputOption + 1]);
const staticRoot = path.join(publicRoot, "static");

await mkdir(staticRoot, { recursive: true });

const replaceLiteScope = (value) => value
  .replace(
    'function isCloudHostedLite() {\n  return !window.location.pathname.startsWith("/lite");\n}',
    'function isCloudHostedLite() {\n  return true;\n}',
  )
  .replace(
    'if (!window.location.pathname.startsWith("/lite")) {\n    window.location.href = "/lite/";\n  }',
    'if (window.location.pathname !== "/") {\n    window.location.href = "/";\n  }',
  )
  .replaceAll("/lite/", "/")
  .replaceAll('"/lite"', '"/"');

await writeFile(
  path.join(publicRoot, "index.html"),
  replaceLiteScope(await readFile(path.join(sourceRoot, "index.html"), "utf8")),
  "utf8",
);
await writeFile(
  path.join(staticRoot, "app.js"),
  replaceLiteScope(await readFile(path.join(sourceRoot, "static/app.js"), "utf8")),
  "utf8",
);
await copyFile(path.join(sourceRoot, "static/styles.css"), path.join(staticRoot, "styles.css"));
await copyFile(path.join(sourceRoot, "static/pairing-handoff.js"), path.join(staticRoot, "pairing-handoff.js"));
await copyFile(path.join(sourceRoot, "static/lite-continuity-state.js"), path.join(staticRoot, "lite-continuity-state.js"));
await copyFile(path.join(sourceRoot, "static/travel-adapter.js"), path.join(staticRoot, "travel-adapter.js"));
await writeFile(
  path.join(publicRoot, "service-worker.js"),
  replaceLiteScope(await readFile(path.join(sourceRoot, "service-worker.js"), "utf8"))
    .replace(/nexus-ark-lite-v\d+/, "nexus-ark-lite-travel-phase5-v23"),
  "utf8",
);
await writeFile(
  path.join(publicRoot, "manifest.webmanifest"),
  replaceLiteScope(await readFile(path.join(sourceRoot, "manifest.webmanifest"), "utf8")),
  "utf8",
);
for (const name of ["badge.png", "icon.png", "icon-maskable.png"]) {
  await copyFile(path.join(sourceRoot, "badge.png"), path.join(publicRoot, name));
}

process.stdout.write("mobile_app正本からWorker Static Assetsを生成しました。\n");
