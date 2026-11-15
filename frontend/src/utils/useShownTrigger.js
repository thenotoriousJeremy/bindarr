import { useState } from 'react';

// statsTrigger as a tab should react to it: followed while the tab is shown,
// held while it is hidden, and caught up the moment it is shown again. Tabs stay
// mounted when hidden (App.jsx), and every add or scan bumps statsTrigger, so a
// tab that refetched on each bump re-downloaded data nobody was looking at; one
// that ignores it while hidden would come back stale. Use the result wherever
// statsTrigger was a dependency:
//
//   const shownTrigger = useShownTrigger(statsTrigger, active);
//   useEffect(() => { load(); }, [shownTrigger]);
//
// `active` defaults to true, so a view rendered outside the tab bar behaves as
// before.
export function useShownTrigger(trigger, active = true) {
  const [held, setHeld] = useState(trigger);
  const next = shownTrigger(held, trigger, active);
  // Adjusting state during render: React re-renders at once, before effects run.
  if (next !== held) setHeld(next);
  return next;
}

// The pure half: the value a tab should see, given the value it last saw.
export const shownTrigger = (held, trigger, active = true) => (active ? trigger : held);
