import { useEffect, useState } from 'react';
import { loadNameDictionaries, nameDictionaries, onNameDictionaries } from './nameDictionaries';

const loaded = () => nameDictionaries() !== null;

// True once the card-name dictionaries have arrived, re-rendering the caller when
// they do — they are fetched on first use (see nameDictionaries.js), so a name
// drawn before then is the English one. `wanted` also starts the fetch, for a view
// that knows it will need them; otherwise this only listens. A value memoized from
// a translated name or query should list the result among its dependencies.
export function useNameDictionaries(wanted = false) {
  const [ready, setReady] = useState(loaded);
  useEffect(() => {
    if (ready) return undefined;
    const off = onNameDictionaries(() => setReady(true));
    // A load that finished between render and this effect never calls back.
    if (loaded()) setReady(true);
    else if (wanted) loadNameDictionaries().catch(() => { /* names stay English */ });
    return off;
  }, [ready, wanted]);
  return ready;
}
