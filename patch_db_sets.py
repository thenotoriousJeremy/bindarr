import sys

with open('backend/src/db.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = """  // Create card metadata cache
  await run(`
    CREATE TABLE IF NOT EXISTS card_cache (
      id TEXT PRIMARY KEY,"""

replacement = """  // Create sets table
  await run(`
    CREATE TABLE IF NOT EXISTS sets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      series TEXT,
      printed_total INTEGER,
      total INTEGER,
      release_date TEXT,
      ptcgo_code TEXT,
      symbol_url TEXT,
      logo_url TEXT
    )
  `);

  // Create card metadata cache
  await run(`
    CREATE TABLE IF NOT EXISTS card_cache (
      id TEXT PRIMARY KEY,"""

if target in content:
    content = content.replace(target, replacement)
    print("Added sets table to db.js")
else:
    print("Target not found in db.js")

with open('backend/src/db.js', 'w', encoding='utf-8') as f:
    f.write(content)
