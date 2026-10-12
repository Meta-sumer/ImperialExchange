// Metro config — tuned for this project living inside OneDrive on Windows + Node 24.
//
// Symptom without this file:
//   node:events ... Error: write UNKNOWN (errno -4094) at child_process _send
//   → jest-worker (Metro's transform child process) dies on a Windows IPC write,
//     which then cascades into bogus "Unable to resolve react-native-webview" errors.
//
// Two causes, two fixes:
//   1. OneDrive locks node_modules / cache files mid-sync, and Node 24's IPC is
//      stricter, so the multi-process worker pool crashes. → run transforms IN-BAND
//      (maxWorkers = 1 means Metro requires the worker in the main process; there is
//      no child_process and therefore no IPC pipe that can throw `write UNKNOWN`).
//   2. Keep Metro's cache OFF the OneDrive tree so the sync client can't lock it.
const { getDefaultConfig } = require('expo/metro-config');
const { FileStore } = require('metro-cache');
const os = require('os');
const path = require('path');

const config = getDefaultConfig(__dirname);

// In-band transforms — no worker child processes, no IPC `write UNKNOWN`.
config.maxWorkers = 1;

// Cache in the system temp dir, away from OneDrive's file-sync locks.
config.cacheStores = [
  new FileStore({ root: path.join(os.tmpdir(), 'metro-tradepro-mobile') }),
];

module.exports = config;
