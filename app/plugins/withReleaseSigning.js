/**
 * Sign Android release builds with the Imperial Exchange upload key.
 *
 * `expo prebuild` regenerates android/ from a template whose release build
 * is signed with the DEBUG key. This plugin adds a `release` signing config
 * that reads four Gradle project properties and makes the release build use
 * it whenever they are set:
 *
 *   IMPERIALEXCHANGE_UPLOAD_STORE_FILE, IMPERIALEXCHANGE_UPLOAD_STORE_PASSWORD,
 *   IMPERIALEXCHANGE_UPLOAD_KEY_ALIAS, IMPERIALEXCHANGE_UPLOAD_KEY_PASSWORD
 *
 * scripts/build-android-release.mjs passes them as ORG_GRADLE_PROJECT_*
 * environment variables, read from a signing.properties file kept OUTSIDE
 * the repo (~/imperialexchange-app-signing/). Without them the build falls
 * back to the debug key (fine for a local test build, never for a published
 * APK — the script refuses that).
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const MARK = 'IMPERIALEXCHANGE_UPLOAD_STORE_FILE';

function addReleaseSigning(src) {
  if (src.includes(MARK)) return src;

  const sc = src.indexOf('signingConfigs {');
  if (sc < 0) throw new Error('withReleaseSigning: no signingConfigs block in app/build.gradle');
  const insertAt = sc + 'signingConfigs {'.length;
  const block = `
        release {
            if (project.hasProperty('${MARK}')) {
                storeFile file(project.property('${MARK}'))
                storePassword project.property('IMPERIALEXCHANGE_UPLOAD_STORE_PASSWORD')
                keyAlias project.property('IMPERIALEXCHANGE_UPLOAD_KEY_ALIAS')
                keyPassword project.property('IMPERIALEXCHANGE_UPLOAD_KEY_PASSWORD')
            }
        }`;
  let out = src.slice(0, insertAt) + block + src.slice(insertAt);

  // buildTypes { … release { … signingConfig signingConfigs.debug … } }
  const bt = out.indexOf('buildTypes {');
  const rel = bt < 0 ? -1 : out.indexOf('release {', bt);
  const dbg = rel < 0 ? -1 : out.indexOf('signingConfig signingConfigs.debug', rel);
  if (dbg < 0) throw new Error('withReleaseSigning: release build type signingConfig not found');
  out = out.slice(0, dbg)
    + `signingConfig project.hasProperty('${MARK}') ? signingConfigs.release : signingConfigs.debug`
    + out.slice(dbg + 'signingConfig signingConfigs.debug'.length);
  return out;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = addReleaseSigning(cfg.modResults.contents);
    return cfg;
  });
};
module.exports.addReleaseSigning = addReleaseSigning;
