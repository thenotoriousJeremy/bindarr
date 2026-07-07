import sys

with open('frontend/src/components/LocationManager.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

target_sidebar = """                      onClick={() => {
                        const el = document.getElementById('recommended-spot');
                        if (el) {
                          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
                          el.classList.remove('flash-highlight');
                          void el.offsetWidth;
                          el.classList.add('flash-highlight');
                        }
                      }}"""

replacement_sidebar = """                      onClick={() => {
                        if (rec.location_id !== activeLocationId) {
                          setActiveLocationId(rec.location_id);
                        }
                        if (isBinderType) {
                          const compIdx = compartments.findIndex(c => c.id === rec.compartment_id);
                          if (compIdx !== -1) setActivePageIndex(compIdx);
                        } else {
                          setActiveCompartmentId(rec.compartment_id);
                          const posIdx = Math.floor(rec.position / 1000) - 1;
                          setCoverflowActiveIndex(Math.max(0, posIdx));
                        }
                        let attempts = 0;
                        const tryScroll = () => {
                          const el = document.getElementById('recommended-spot');
                          if (el) {
                            el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
                            el.classList.remove('flash-highlight');
                            void el.offsetWidth;
                            el.classList.add('flash-highlight');
                          } else if (attempts < 10) {
                            attempts++;
                            setTimeout(tryScroll, 100);
                          }
                        };
                        tryScroll();
                      }}"""

if target_sidebar in content:
    content = content.replace(target_sidebar, replacement_sidebar)
    with open('frontend/src/components/LocationManager.jsx', 'w', encoding='utf-8') as f:
        f.write(content)
    print("LocationManager onClick patched.")
else:
    print("Warning: Sidebar target not found!")
