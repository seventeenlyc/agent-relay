import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { MigrationEngine } from '../../packages/installer/src/migration.ts';

test('migration: reports current schema version v1', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  try {
    const engine = new MigrationEngine();
    assert.strictEqual(engine.getCurrentVersion(db), '1');
    const comp = engine.checkCompatibility(db);
    assert.strictEqual(comp.compatible, true);
    assert.strictEqual(comp.readOnlyRequired, false);
  } finally {
    db.close();
  }
});

test('migration: flags readOnlyRequired when encountering unknown future schema version', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  try {
    // Simulate future schema version 99
    db.exec("UPDATE schema_meta SET value = '99' WHERE key = 'schema_version'");
    const engine = new MigrationEngine();
    const comp = engine.checkCompatibility(db);
    assert.strictEqual(comp.compatible, false);
    assert.strictEqual(comp.readOnlyRequired, true);
    assert.match(comp.reason!, /higher than supported/i);
  } finally {
    db.close();
  }
});

test('migration: getCurrentVersion returns 0 when schema_meta has no schema_version row', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  try {
    db.exec("DELETE FROM schema_meta WHERE key = 'schema_version'");
    const engine = new MigrationEngine();
    assert.strictEqual(engine.getCurrentVersion(db), '0');
  } finally {
    db.close();
  }
});

test('migration: migrate returns from/to when compatible', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  try {
    const engine = new MigrationEngine();
    const result = engine.migrate(db);
    assert.strictEqual(result.from, '1');
    assert.strictEqual(result.to, '1');
  } finally {
    db.close();
  }
});

test('migration: migrate throws when readOnlyRequired', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  try {
    db.exec("UPDATE schema_meta SET value = '99' WHERE key = 'schema_version'");
    const engine = new MigrationEngine();
    assert.throws(() => engine.migrate(db), /Cannot migrate/);
  } finally {
    db.close();
  }
});

test('migration: migrate accepts explicit target version', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  try {
    const engine = new MigrationEngine();
    const result = engine.migrate(db, '1');
    assert.strictEqual(result.from, '1');
    assert.strictEqual(result.to, '1');
  } finally {
    db.close();
  }
});

test('migration: checkCompatibility includes currentVersion and maxSupportedVersion', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  try {
    const engine = new MigrationEngine();
    const comp = engine.checkCompatibility(db);
    assert.strictEqual(comp.currentVersion, '1');
    assert.strictEqual(comp.maxSupportedVersion, '1');
  } finally {
    db.close();
  }
});

test('migration: checkCompatibility flags NaN version as incompatible', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  try {
    db.exec("UPDATE schema_meta SET value = 'garbage' WHERE key = 'schema_version'");
    const engine = new MigrationEngine();
    const comp = engine.checkCompatibility(db);
    assert.strictEqual(comp.compatible, false);
    assert.strictEqual(comp.readOnlyRequired, true);
    assert.match(comp.reason!, /higher than supported/i);
  } finally {
    db.close();
  }
});
