// What trading the app can offer, from where it runs and the member's own choice.
//
// Trades and gifts between members need the server. A phone in device mode
// (apiBase.isDeviceMode) has nobody else on it: its bundled backend answers 501
// for every user-to-user route and serves only the external-deal ones
// (/api/transfers/external*), which are one account's own record. So on a
// phone only deals with people outside Bindarr are offered.
//
// On a server, trading with other members is opt-in per member
// (user.trades_enabled). While it is off the server leaves the member out of
// everyone's member list and refuses their trading writes (403
// trades_disabled), but still answers their own lists, so old offers and
// history stay readable, and still lets them say no: a member who switched
// trading off can decline what was sent to them and withdraw what they sent.

// The server sends the flag as a boolean (share_* are 0/1); a profile stored by
// an earlier build may hold either. Read it by truthiness, so both work.
export const tradesEnabledFor = (user) => !!user?.trades_enabled;

export function tradeAccess({ deviceMode = false, tradesEnabled = false } = {}) {
  const members = !deviceMode;
  const canTrade = members && !!tradesEnabled;
  return {
    // Member trades exist here: offers, their history and recorded past trades load.
    members,
    // ...and can be made: propose, accept, counter, record or confirm a past
    // trade, mark sealed products for trade.
    canTrade,
    // ...and can be turned down, trading on or off: reject an offer or decline a
    // recorded trade sent to you, cancel your own offer or record.
    canDecline: members,
    // A member who has not opted in: say what it is, and offer to turn it on.
    needsOptIn: members && !canTrade,
  };
}

// The Trades area's pages. A phone on its own has no offers to answer.
export const transferPages = (access) => (access.members ? ['new', 'offers', 'history'] : ['new', 'history']);

// The "Propose trade" shortcuts on a card or a sealed unit start an offer to a
// member. Off on a phone; on a server they stay while trading is off, and lead
// to the Trades area, which says how to turn it on.
export const offersTradeShortcuts = ({ deviceMode = false } = {}) => !deviceMode;

// Whether a card's provenance line can open the history it names: deals with
// people outside Bindarr are kept on every device, member trades on the server.
export const canOpenTradeHistory = (type, { deviceMode = false } = {}) => type === 'external' || !deviceMode;
