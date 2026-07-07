import sys

with open('backend/src/db.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = """    CREATE TABLE IF NOT EXISTS compartment_set_assignments (
      compartment_id INTEGER NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
      set_name TEXT NOT NULL,
      PRIMARY KEY(compartment_id, set_name)
    )"""

replacement = """    CREATE TABLE IF NOT EXISTS compartment_assignments (
      compartment_id INTEGER NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
      filter_value TEXT NOT NULL,
      PRIMARY KEY(compartment_id, filter_value)
    )"""

if target in content:
    content = content.replace(target, replacement)
    print("Updated db.js")
else:
    print("Target not found in db.js")

with open('backend/src/db.js', 'w', encoding='utf-8') as f:
    f.write(content)
