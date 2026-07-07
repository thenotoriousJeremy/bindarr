import sys

with open('backend/src/server.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = """    // Sync sets on startup
    await tcgApi.fetchAndCacheSets();"""

replacement = """    // Sync sets on startup
    await tcgApi.fetchAndCacheSets();
    
    // Load sets into compartmentSort memory cache
    const { loadSetsCache } = require('./utils/compartmentSort');
    await loadSetsCache(db);"""

if target in content:
    content = content.replace(target, replacement)
    print("Called loadSetsCache in server.js")
else:
    print("Target not found")

with open('backend/src/server.js', 'w', encoding='utf-8') as f:
    f.write(content)
