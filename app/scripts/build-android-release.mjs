#!/usr/bin/env node
/**
 * Build the signed Imperial Exchange Android APK.
 *
 *   npm run build:apk
 *
 * 1. `expo prebuild` regenerates android/ (plugins/withReleaseSigning.js
 *    wires the release signing config).
 * 2. Gradle `assembleRelease` for the two ARM ABIs every Android phone uses
 *    (armeabi-v7a, arm64-v8a) — x86 is emulator-only and would double the
 *    download for nobody.
 * 3. Copies the APK to dist/ImperialExchange.apk and writes
 *    dist/latest.json, the manifest the website's /download page reads.
 *
 * Signing: the upload key lives OUTSIDE the repo. Its properties file
 * (IMPERIALEXCHANGE_UPLOAD_STORE_FILE / _STORE_PASSWORD / _KEY_ALIAS /
 * _KEY_PASSWORD) is read from $IMPERIALEXCHANGE_SIGNING_PROPERTIES, else
 * ~/imperialexchange-app-signing/signing.properties, and handed to Gradle as
 * ORG_GRADLE_PROJECT_* variables so no password reaches a command line.
 * Every update must be signed with the SAME key, or phones refuse to install
 * it over the old app — back the key up.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const die = (msg) => { console.error(`\n✖ ${msg}`); process.exit(1); };

const propsFile = process.env.IMPERIALEXCHANGE_SIGNING_PROPERTIES
  || path.join(os.homedir(), 'imperialexchange-app-signing', 'signing.properties');
if (!fs.existsSync(propsFile)) die(`signing properties not found: ${propsFile}`);
const signing = {};
for (const line of fs.readFileSync(propsFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) signing[m[1]] = m[2];
}
for (const k of ['IMPERIALEXCHANGE_UPLOAD_STORE_FILE', 'IMPERIALEXCHANGE_UPLOAD_STORE_PASSWORD', 'IMPERIALEXCHANGE_UPLOAD_KEY_ALIAS', 'IMPERIALEXCHANGE_UPLOAD_KEY_PASSWORD']) {
  if (!signing[k]) die(`${k} missing from ${propsFile}`);
}
if (!fs.existsSync(signing.IMPERIALEXCHANGE_UPLOAD_STORE_FILE)) die(`keystore not found: ${signing.IMPERIALEXCHANGE_UPLOAD_STORE_FILE}`);

const env = { ...process.env, CI: '1', EXPO_NO_GIT_STATUS: '1' };
for (const [k, v] of Object.entries(signing)) env[`ORG_GRADLE_PROJECT_${k}`] = v;

const run = (cmd, args, cwd) => {
  console.log(`\n› ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) die(`${cmd} failed (exit ${r.status})`);
};

run('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], ROOT);
const androidDir = path.join(ROOT, 'android');
run(isWin ? `"${path.join(androidDir, 'gradlew.bat')}"` : './gradlew',
  ['assembleRelease', '-PreactNativeArchitectures=armeabi-v7a,arm64-v8a', '--no-daemon'], androidDir);

const built = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
if (!fs.existsSync(built)) die(`APK not found at ${built}`);

const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')).expo;
const version = appJson.version;
// One stable file name: the website links straight to /downloads/ImperialExchange.apk
// and the version lives in latest.json, so publishing never breaks a link.
const name = 'ImperialExchange.apk';
const dist = path.join(ROOT, 'dist');
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, name);
fs.copyFileSync(built, out);
const bytes = fs.readFileSync(out);
const manifest = {
  version,
  versionCode: appJson.android?.versionCode ?? 1,
  file: `/downloads/${name}`,
  sizeBytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  updatedAt: new Date().toISOString().slice(0, 10),
  minAndroid: '7.0',
};
fs.writeFileSync(path.join(dist, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\n✔ ${out}\n  ${(bytes.length / 1048576).toFixed(1)} MB · sha256 ${manifest.sha256}`);
console.log(`  Version ${version} (versionCode ${manifest.versionCode}) — bump app.json version/versionCode before the next release.`);
console.log('  To publish: copy ImperialExchange.apk and latest.json into client/public/downloads/');
