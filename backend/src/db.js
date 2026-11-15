// The database: the process's one SQLite connection and the schema it holds.
// Requiring this opens the file (DB_PATH), so set DB_PATH first.
//
// The code lives in db/, and this file re-exports it under the names every
// caller uses:
//
//   db/connection.js  the connection, its transaction lock, and run/get/all,
//                     withTransaction and runExclusive
//   db/schema.js      every CREATE TABLE and CREATE INDEX
//   db/migrations.js  initDb, which creates the schema and brings an older
//                     database up to it, and the helpers it shares with
//                     account creation (orphan adoption, starter storage)
//
// Callers may replace a property here: device mode wraps withTransaction
// (embedded/index.js), and tests wrap run/get/all. The modules in db/ call one
// another directly, so a wrapper sees its callers' statements and never initDb's.
const connection = require('./db/connection');
const migrations = require('./db/migrations');

module.exports = {
  dbConnection: connection.dbConnection,
  dbPath: connection.dbPath,
  run: connection.run,
  get: connection.get,
  all: connection.all,
  withTransaction: connection.withTransaction,
  runExclusive: connection.runExclusive,
  initDb: migrations.initDb,
  splitStackedRows: migrations.splitStackedRows,
  createCompartments: migrations.createCompartments,
  seedStarterLocations: migrations.seedStarterLocations,
  adoptOrphanRows: migrations.adoptOrphanRows,
  hashPassword: migrations.hashPassword,
  // Exported for tests — the rename runs at module load, so it can't be
  // exercised through a normal require.
  resolveDbPath: connection.resolveDbPath,
  DB_FILENAME: connection.DB_FILENAME,
  LEGACY_DB_FILENAME: connection.LEGACY_DB_FILENAME
};
