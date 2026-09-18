// Shared resolution of uco's bundled artifact sources — the `vendor/`
// directory staged into the tgz (`npm run stage-vendor`) and the dev
// workspace fallback. Both `uco install` and `uco update` resolve sources
// with the same priority so an install and its later refresh can never come
// from different bundles.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { UCO_UNITY_PACKAGE_ID } from './manifest.js';

/** Absolute path of the uco package's bundled `vendor/` directory. */
export function resolveVendorRoot(): string {
  // <this file> → ../../vendor — src/devops/utils/vendor.ts and
  // dist/devops/utils/vendor.js are both two levels below the package root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'vendor');
}

export function vendorPath(...segments: string[]): string {
  return path.join(resolveVendorRoot(), ...segments);
}

/** True when the tgz bundle carries a staged plugin source. */
export function hasVendorPlugin(): boolean {
  return fs.existsSync(vendorPath('plugin', UCO_UNITY_PACKAGE_ID));
}

/** True when the tgz bundle carries a staged NuGet DLL set. */
export function hasVendorNuget(): boolean {
  return fs.existsSync(vendorPath('nuget'));
}

/**
 * Find the dev workspace root by walking upward from this file until the
 * `uco-plugin` sibling directory appears (the workspace marker).
 * Falls back to `process.cwd()` when no marker is found within 8 levels.
 */
export function findWorkspaceRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'uco-plugin')) && fs.existsSync(path.join(dir, 'cocli'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** The dev workspace's staged NuGet folder (`<workspace>/dist/nuget`). */
export function workspaceNugetPath(): string {
  return path.join(findWorkspaceRoot(), 'dist', 'nuget');
}

/** The dev workspace's plugin package source. */
export function workspacePluginPath(): string {
  return path.join(
    findWorkspaceRoot(),
    'Packages',
    UCO_UNITY_PACKAGE_ID,
  );
}

/** Vendor-first NuGet source; dev workspace fallback. */
export function resolveDefaultNugetSource(): string {
  return hasVendorNuget() ? vendorPath('nuget') : workspaceNugetPath();
}

/** Vendor-first plugin package source; dev workspace fallback. */
export function resolveDefaultPluginSource(): string {
  return hasVendorPlugin() ? vendorPath('plugin', UCO_UNITY_PACKAGE_ID) : workspacePluginPath();
}
