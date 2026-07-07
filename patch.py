import sys

with open('frontend/src/index.css', 'r', encoding='utf-8') as f:
    content = f.read()

append_str = """
@media (max-width: 768px) {
  .locations-wrapper {
    flex-direction: column !important;
  }
  .locations-sidebar {
    width: 100% !important;
    max-height: 40vh;
    border-right: none !important;
    border-bottom: 1px solid var(--border-glass);
    flex: 0 0 auto !important;
    overflow-y: auto;
  }
}
"""

if "@media (max-width: 768px)" not in content[-500:]:
    with open('frontend/src/index.css', 'a', encoding='utf-8') as f:
        f.write("\n" + append_str)
        print("CSS appended.")
else:
    print("CSS already appended.")
