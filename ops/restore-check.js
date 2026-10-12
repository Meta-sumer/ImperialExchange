// Compares the copy restored into `restore_check` with the live database,
// collection by collection, then deletes the copy. Candles are not in the
// backup by design, so they are not compared.
const live = db.getSiblingDB('trading_platform');
const copy = db.getSiblingDB('restore_check');
let differ = 0;
print('collection'.padEnd(28) + 'live'.padStart(9) + 'restored'.padStart(10));
for (const c of live.getCollectionNames().sort()) {
  if (c === 'candles') continue;
  const a = live.getCollection(c).countDocuments();
  const b = copy.getCollection(c).countDocuments();
  if (a !== b) differ++;
  print(c.padEnd(28) + String(a).padStart(9) + String(b).padStart(10) + (a === b ? '' : '   <-- differs'));
}
print('candles in the restored copy: ' + copy.getCollection('candles').countDocuments() + ' (expected 0 - not backed up by design)');
print(differ
  ? 'RESTORE CHECK: ' + differ + ' collection(s) differ. A small surplus on the live side = records written after the backup ran.'
  : 'RESTORE CHECK OK: every collection restored with exactly the live document count.');
copy.dropDatabase();
print('scratch copy restore_check deleted');
