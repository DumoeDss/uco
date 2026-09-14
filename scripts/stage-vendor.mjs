#!/usr/bin/env node
// stage-vendor.mjs — 把运行时产物拷进 cocli/vendor/，使 npm 打出的 tgz 自包含。
//
// 打包者在 cocli/ 目录下跑：npm run stage-vendor
// 依赖父级 unity-copilot/ 下已存在的构建产物：
//   - dist/nuget/                  (stage-nuget-dlls.ps1 产出，插件依赖 DLL + .meta)
//   - uco-plugin/uco-unity-project/Packages/com.atelierai.unity.copilot/  (Unity 插件源)
//
// Node server (cocli/src/server/) 编译进 cocli/dist/server/ 由 tsc 处理，
// 通过 package.json 的 files 字段直接打入 tgz —— 无需 vendor 暂存。
//
// 产物布局（会被 package.json 的 files 字段打进 tgz）：
//   cocli/vendor/nuget/
//   cocli/vendor/plugin/com.atelierai.unity.copilot/

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'com.atelierai.unity.copilot';

const here = path.dirname(fileURLToPath(import.meta.url));
const cocliRoot = path.resolve(here, '..');            // cocli/
const workspaceRoot = path.resolve(here, '..', '..');  // unity-copilot/
const vendorRoot = path.join(cocliRoot, 'vendor');

const sources = [
  {
    name: 'nuget',
    src: path.join(workspaceRoot, 'dist', 'nuget'),
    dst: path.join(vendorRoot, 'nuget'),
    missingHint: 'Run scripts/stage-nuget-dlls.ps1 in unity-copilot/ first.',
  },
  {
    name: `plugin/${PLUGIN_ID}`,
    src: path.join(workspaceRoot, 'uco-plugin', 'uco-unity-project', 'Packages', PLUGIN_ID),
    dst: path.join(vendorRoot, 'plugin', PLUGIN_ID),
    missingHint: `Plugin source package not found under uco-plugin/uco-unity-project/Packages/${PLUGIN_ID}/.`,
  },
];

function dirStat(p) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) {
        files++;
        bytes += fs.statSync(f).size;
      }
    }
  };
  walk(p);
  return { files, bytes };
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// 1. 校验所有源存在 —— 缺任一立即报错，避免打出残缺包。
const missing = sources.filter((s) => !fs.existsSync(s.src));
if (missing.length > 0) {
  console.error('\n✗ stage-vendor: 缺失源产物，无法打包自包含 cocli：');
  for (const m of missing) {
    console.error(`  • ${m.name}`);
    console.error(`      期望: ${m.src}`);
    console.error(`      → ${m.missingHint}`);
  }
  console.error(`\n(workspaceRoot 解析为 ${workspaceRoot})`);
  process.exit(1);
}

// 2. 清空旧 vendor/，保证不会有残留过时文件混进新包。
if (fs.existsSync(vendorRoot)) {
  fs.rmSync(vendorRoot, { recursive: true, force: true });
}
fs.mkdirSync(vendorRoot, { recursive: true });

// 3. 递归拷贝并报告每个产物的大小/文件数，便于肉眼校验完整性。
console.log(`Staging vendor/ at ${vendorRoot}\n`);
for (const s of sources) {
  fs.mkdirSync(path.dirname(s.dst), { recursive: true });
  fs.cpSync(s.src, s.dst, { recursive: true });
  const stat = dirStat(s.dst);
  console.log(
    `  ✓ ${s.name.padEnd(40)} ${String(stat.files).padStart(5)} files  ${humanBytes(stat.bytes).padStart(10)}`,
  );
}
console.log('\n✓ vendor/ ready. 现在可以跑 `npm pack` 生成自包含 tgz。');
