import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const srcDir = resolve(rootDir, "src");
const outDir = resolve(srcDir, "tui-compiled");
const distTuiDir = resolve(rootDir, "dist", "tui");

mkdirSync(outDir, { recursive: true });
mkdirSync(distTuiDir, { recursive: true });

const { transformSolidSource } = await import(
  resolve(rootDir, "node_modules/@opentui/solid/scripts/solid-transform.js")
);

const resolvePathVirtual = (specifier) => {
  if (specifier === "@opentui/solid") return "opentui:runtime-module:%40opentui%2Fsolid";
  if (specifier === "solid-js") return "opentui:runtime-module:solid-js";
  if (specifier === "solid-js/store") return "opentui:runtime-module:solid-js%2Fstore";
  if (specifier === "@opentui/solid/components") return "opentui:runtime-module:%40opentui%2Fsolid%2Fcomponents";
  if (specifier === "@opentui/solid/jsx-runtime") return "opentui:runtime-module:%40opentui%2Fsolid%2Fjsx-runtime";
  return specifier;
};

const resolvePathDirect = (specifier) => {
  return specifier;
};

// 1. tui.tsx -> tui-compiled/tui.tsx
let tuiCode = readFileSync(resolve(srcDir, "tui.tsx"), "utf8");
tuiCode = tuiCode.replace("./tui/dialogs.js", "./dialogs.js");
tuiCode = tuiCode.replace("./tui/sidebar-widget.js", "./sidebar-widget.js");
tuiCode = tuiCode.replace("./shared/paths.js", "../shared/paths.js");
tuiCode = tuiCode.replace("./manager/index.js", "../manager/index.js");
tuiCode = tuiCode.replace("../vendor/", "../../vendor/");

const tuiVirtual = await transformSolidSource(tuiCode, {
  filename: resolve(outDir, "tui.tsx"),
  moduleName: "opentui:runtime-module:%40opentui%2Fsolid",
  resolvePath: resolvePathVirtual,
});
writeFileSync(resolve(outDir, "tui.tsx"), tuiVirtual, "utf8");

// Also compile dist/tui.js with direct @opentui/solid
let distTuiCode = readFileSync(resolve(srcDir, "tui.tsx"), "utf8");
distTuiCode = distTuiCode.replace("../vendor/", "../../vendor/");
const tuiDirect = await transformSolidSource(distTuiCode, {
  filename: resolve(rootDir, "src/tui.tsx"),
  moduleName: "@opentui/solid",
  resolvePath: resolvePathDirect,
});
writeFileSync(resolve(rootDir, "dist/tui.js"), tuiDirect, "utf8");

// 2. sidebar-widget.tsx -> tui-compiled/sidebar-widget.tsx & dist/tui/sidebar-widget.js
const sidebarCode = readFileSync(resolve(srcDir, "tui/sidebar-widget.tsx"), "utf8");

const sidebarVirtual = await transformSolidSource(sidebarCode, {
  filename: resolve(outDir, "sidebar-widget.tsx"),
  moduleName: "opentui:runtime-module:%40opentui%2Fsolid",
  resolvePath: resolvePathVirtual,
});
writeFileSync(resolve(outDir, "sidebar-widget.tsx"), sidebarVirtual, "utf8");

const sidebarDirect = await transformSolidSource(sidebarCode, {
  filename: resolve(srcDir, "tui/sidebar-widget.tsx"),
  moduleName: "@opentui/solid",
  resolvePath: resolvePathDirect,
});
writeFileSync(resolve(distTuiDir, "sidebar-widget.js"), sidebarDirect, "utf8");

// 3. dialogs.tsx -> tui-compiled/dialogs.tsx & dist/tui/dialogs.js
const dialogsCode = readFileSync(resolve(srcDir, "tui/dialogs.tsx"), "utf8");

const dialogsVirtual = await transformSolidSource(dialogsCode, {
  filename: resolve(outDir, "dialogs.tsx"),
  moduleName: "opentui:runtime-module:%40opentui%2Fsolid",
  resolvePath: resolvePathVirtual,
});
writeFileSync(resolve(outDir, "dialogs.tsx"), dialogsVirtual, "utf8");

const dialogsDirect = await transformSolidSource(dialogsCode, {
  filename: resolve(srcDir, "tui/dialogs.tsx"),
  moduleName: "@opentui/solid",
  resolvePath: resolvePathDirect,
});
writeFileSync(resolve(distTuiDir, "dialogs.js"), dialogsDirect, "utf8");

// 4. wizard-core.ts -> tui-compiled/wizard-core.ts
copyFileSync(resolve(srcDir, "tui/wizard-core.ts"), resolve(outDir, "wizard-core.ts"));

// 5. native.ts -> tui-compiled/native.ts
copyFileSync(resolve(srcDir, "tui/native.ts"), resolve(outDir, "native.ts"));

console.log("[build-tui] Successfully generated reactive Solid bundles in src/tui-compiled/ and dist/tui/");
