import { openDb } from './packages/engine/src/db/db.ts';
const db = openDb('./demo/data/associations-demo/state.db');
console.log('=== deferred_associations ===');
console.log(JSON.stringify(db.prepare('SELECT * FROM deferred_associations').all(), null, 2));
console.log('=== watermarks ===');
console.log(JSON.stringify(db.prepare('SELECT * FROM watermarks').all(), null, 2));
const ids = db.prepare("SELECT * FROM identity_map WHERE external_id IN ('c4','co4') OR canonical_id IN (SELECT canonical_id FROM identity_map WHERE external_id IN ('c4','co4'))").all();
console.log('=== identity_map for c4/co4 ===');
console.log(JSON.stringify(ids, null, 2));
