// Keyboard movement inside an open menu (the WAI-ARIA menu pattern), kept free
// of React and the DOM so node:test can check it. Given the key, the index of
// the focused item (-1 for none) and the item count, returns the index to focus
// next, 'close' to close the menu and put focus back on its button, or null to
// let the key do whatever it normally does.
export function menuKeyTarget(key, index, count) {
  if (key === 'Escape' || key === 'Tab') return 'close';
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown': return index < 0 ? 0 : (index + 1) % count;
    case 'ArrowUp': return index < 0 ? count - 1 : (index - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}
