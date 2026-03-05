// src/migrate.js
// Dijalankan sekali saat deploy untuk setup database
// Railway akan otomatis set DATABASE_URL

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  console.log('[migrate] Connecting to database...');

  try {
    // Baca schema.sql
    const schemaPath = path.join(__dirname, '../database/schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    console.log('[migrate] Running schema migration...');
    await pool.query(schema);
    console.log('[migrate] ✓ Migration complete');
  } catch (err) {
    // Ignore "already exists" errors — idempotent
    if (err.message.includes('already exists')) {
      console.log('[migrate] ✓ Tables already exist, skipping');
    } else {
      console.error('[migrate] ✗ Migration failed:', err.message);
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

migrate();
