import { useState } from 'react';
import { counterSelections } from '../../utils/transferSelection';
import { itemKey } from '../../utils/transferView';

// What the "New" page's form holds. Kept above the form (TransferManager owns
// it) because the Offers page starts a counter in it and a card's "Propose
// trade" starts an offer in it.
//
//   recipient      'user:<id>' or 'contact:<id>' (utils/transferView parseRecipient)
//   offered        your items, { 'card:12': { type, id, quantity } }
//   requested      the member's items, same shape
//   received       what a contact gave you, for a recorded deal
//   countering     the incoming offer being countered, or null
const EMPTY = Object.freeze({
  recipient: '',
  type: 'gift',
  giftDirection: 'given',
  offered: {},
  requested: {},
  received: [],
  message: '',
  countering: null,
  addingContact: false,
  newContactName: '',
  notice: '',
});

const selection = (item, quantity = 1) => ({ type: item.type, id: item.id, quantity: item.type === 'card' ? quantity : 1 });

export function useComposer() {
  const [state, setState] = useState(EMPTY);
  const patch = (changes) => setState(current => ({ ...current, ...(typeof changes === 'function' ? changes(current) : changes) }));
  const pick = (side) => (item, picked) => patch((current) => {
    const next = { ...current[side] };
    const key = itemKey(item);
    if (picked) next[key] = selection(item, current[side][key]?.quantity || 1);
    else delete next[key];
    return { [side]: next };
  });
  const setQuantity = (side) => (item, quantity) => patch((current) => {
    const key = itemKey(item);
    if (!current[side][key]) return {};
    const value = Math.max(1, Math.min(Number(item.quantity) || 1, Number(quantity) || 1));
    return { [side]: { ...current[side], [key]: { ...current[side][key], quantity: value } } };
  });

  return {
    state,
    patch,
    reset: () => setState(EMPTY),
    // A card's or sealed unit's "Propose trade": a trade offering that one copy.
    startOffer: (type, id) => setState({ ...EMPTY, type: 'trade', offered: { [itemKey({ type, id })]: { type, id, quantity: 1 } } }),
    // An incoming offer answered with one of your own: what they asked of you
    // and still own is offered back, what they offered is asked for.
    startCounter: (transfer, ownItemsByKey) => {
      const selections = counterSelections(transfer, ownItemsByKey);
      setState({
        ...EMPTY,
        recipient: `user:${transfer.proposer_id}`,
        type: 'trade',
        countering: transfer,
        offered: selections.offered,
        requested: selections.requested,
      });
    },
    // A different recipient starts the other side over: what one member marked
    // for trade means nothing for the next.
    setRecipient: (value) => patch(current => (value === current.recipient
      ? { addingContact: false }
      : { recipient: value, requested: {}, received: [], addingContact: false })),
    pickOffered: pick('offered'),
    pickRequested: pick('requested'),
    setOfferedQuantity: setQuantity('offered'),
    setRequestedQuantity: setQuantity('requested'),
    setReceived: (updater) => patch(current => ({ received: typeof updater === 'function' ? updater(current.received) : updater })),
  };
}
