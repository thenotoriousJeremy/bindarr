import sys

with open('frontend/src/index.css', 'r', encoding='utf-8') as f:
    content = f.read()

# Add flash-highlight keyframes and class
if '.flash-highlight' not in content:
    content += """
@keyframes pulseHighlight {
  0% { box-shadow: 0 0 0 0 rgba(255, 193, 7, 0.8); }
  70% { box-shadow: 0 0 0 15px rgba(255, 193, 7, 0); }
  100% { box-shadow: 0 0 0 0 rgba(255, 193, 7, 0); }
}
.flash-highlight {
  animation: pulseHighlight 1s ease-out 3;
  border-color: #ffc107 !important;
  z-index: 100 !important;
}
"""
    with open('frontend/src/index.css', 'w', encoding='utf-8') as f:
        f.write(content)
    print("index.css patched.")
else:
    print("index.css already has flash-highlight.")
