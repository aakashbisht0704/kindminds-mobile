/**
 * Windows-friendly native artifact setup for llama.rn.
 *
 * llama.rn's postinstall calls GNU tar with Windows drive paths. On Git Bash,
 * tar reads `C:\...` as a remote host and fails. This script patches that one
 * call to use forward slashes plus --force-local, then runs the downloader when
 * the JNI libraries are missing.
 *
 * Run with: bun run setup:native
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const llamaRoot = join(root, 'node_modules', 'llama.rn');
const lib = join(llamaRoot, 'android', 'src', 'main', 'jniLibs', 'x86_64', 'librnllama.so');

if (!existsSync(llamaRoot)) {
  console.error('llama.rn is not installed. Run `bun install` first.');
  process.exit(1);
}

if (existsSync(lib)) {
  console.log('llama.rn native libraries are already installed.');
  process.exit(0);
}

const downloader = join(llamaRoot, 'install', 'download-native-artifacts.js');
if (!existsSync(downloader)) {
  console.error('llama.rn downloader not found. Reinstall llama.rn.');
  process.exit(1);
}

let source = readFileSync(downloader, 'utf8');
source = source.replace(
  "spawnSync('tar', ['-xzf', archivePath, '-C', packageRoot]",
  "spawnSync('tar', ['--force-local', '-xzf', archivePath.replace(/\\\\/g, '/'), '-C', packageRoot.replace(/\\\\/g, '/')]",
);
writeFileSync(downloader, source);

execFileSync(process.execPath, [downloader], { stdio: 'inherit', cwd: root });
console.log('llama.rn native libraries are ready.');
