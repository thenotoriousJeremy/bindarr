import sys

with open('backend/src/server.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = """// Initialize Database on startup
db.initDb()
  .then(() => {
    console.log('Database tables verified/created successfully.');
    // Schedule a weekly price update (every 7 days)"""

replacement = """// Initialize Database on startup
db.initDb()
  .then(async () => {
    console.log('Database tables verified/created successfully.');
    // Sync sets on startup
    await tcgApi.fetchAndCacheSets();
    
    // Schedule a weekly price update (every 7 days)"""

if target in content:
    content = content.replace(target, replacement)
    print("Replaced target in server.js")
else:
    print("Target not found")

with open('backend/src/server.js', 'w', encoding='utf-8') as f:
    f.write(content)
