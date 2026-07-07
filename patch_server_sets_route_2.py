import sys

with open('backend/src/server.js', 'r', encoding='utf-8') as f:
    content = f.read()

target1 = """const collectionRoutes = require('./routes/collection');"""
replacement1 = """const collectionRoutes = require('./routes/collection');
const setsRoutes = require('./routes/sets');"""

target2 = """app.use('/api', collectionRoutes);"""
replacement2 = """app.use('/api', collectionRoutes);
app.use('/api/sets', setsRoutes);"""

if target1 in content and target2 in content:
    content = content.replace(target1, replacement1)
    content = content.replace(target2, replacement2)
    print("Wired up sets route in server.js")
else:
    print("Target not found in server.js")

with open('backend/src/server.js', 'w', encoding='utf-8') as f:
    f.write(content)
