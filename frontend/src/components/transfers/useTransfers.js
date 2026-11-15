import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../utils/useApi';
import { fetchJson, sendJson } from '../../utils/request';
import { PagedQuery, emptyPagedList, pageUrl, prependItem, readPage, removeItem, replaceItem } from '../../utils/pagedList';
import { loadCollectionPages } from '../../utils/collectionPages';
import { tradeAccess, tradesEnabledFor } from '../../utils/tradeAccess';
import { withLocationNames } from '../../utils/transferView';
import { useStableCallback } from '../../utils/useStableCallback';

// Everything the Trades area reads and writes, so its components only draw.
//
// Lists are paged (utils/pagedList.js) and loaded once; an action the server
// has answered edits them in place rather than reloading every list, and only
// the inventory an accept or a recorded deal changed is fetched again. The
// inventory is the collection grid's slim rows (fields=grid), under the same
// URL and loader as the Collection tab, so the two share useApi's cached
// answer. Coming back to the tab after it was hidden refreshes the first page
// of the two lists another member can change (offers, recorded past trades).

const CARDS_URL = '/api/collection?list_type=collection&fields=grid';
const loadCards = ({ signal, hasData, push }) => loadCollectionPages(CARDS_URL, { signal, push: hasData ? null : push });
const SEALED_URL = '/api/sealed/units?opened=0';

const isPendingTransfer = (transfer) => transfer.status === 'pending';
const isAwaitingConfirmation = (trade) => trade.status === 'pending_confirmation';
// SQLite's CURRENT_TIMESTAMP form, for a change made here that the server did
// not send back.
const nowUtc = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const ACTION_STATUS = { accept: 'accepted', reject: 'rejected', cancel: 'cancelled' };

function usePagedList(url, field, { enabled, isOpen }) {
  const [state, setState] = useState(emptyPagedList);
  const coreRef = useRef(null);
  if (!coreRef.current) coreRef.current = new PagedQuery(setState, { isOpen });
  const core = coreRef.current;

  const fetchPage = useCallback(async ({ cursor, signal }) => {
    const { data } = await fetchJson(pageUrl(url, { cursor }), { signal });
    return readPage(data, field);
  }, [url, field]);

  useEffect(() => { if (enabled) core.refresh(fetchPage); }, [core, enabled, fetchPage]);
  useEffect(() => () => core.cancel(), [core]);

  return useMemo(() => ({
    ...state,
    enabled,
    refresh: () => (enabled ? core.refresh(fetchPage) : Promise.resolve({ stale: true })),
    loadMore: () => core.loadMore(fetchPage),
    find: (match) => (enabled ? core.find(match, fetchPage) : Promise.resolve(null)),
    edit: (fn) => core.edit(fn),
  }), [state, enabled, core, fetchPage]);
}

export function useTransfers({ user, active = true, deviceMode = false }) {
  const me = user?.id ?? null;
  const optedIn = tradesEnabledFor(user);
  // The server refused a member call with 403 trades_disabled although the
  // stored profile says trading is on (it was turned off on another device):
  // believe the server until the profile is replaced (a settings save, the
  // opt-in's button, the next sign-in).
  const [refused, setRefused] = useState(false);
  const [refusedFor, setRefusedFor] = useState(user);
  if (refusedFor !== user) {
    setRefusedFor(user);
    setRefused(false);
  }
  const access = useMemo(
    () => tradeAccess({ deviceMode, tradesEnabled: optedIn && !refused }),
    [deviceMode, optedIn, refused]
  );
  const markTradesOff = useCallback(() => setRefused(true), []);

  const transfers = usePagedList('/api/transfers', 'transfers', { enabled: access.members, isOpen: isPendingTransfer });
  const historical = usePagedList('/api/transfers/history', 'trades', { enabled: access.members, isOpen: isAwaitingConfirmation });
  const external = usePagedList('/api/transfers/external', 'transactions', { enabled: true });

  // Other members are listed only to a member who trades, and only lists those
  // who do too.
  const usersQuery = useApi(access.canTrade ? '/api/transfers/users' : null);
  const contactsQuery = useApi('/api/transfers/external/contacts');
  const cardsQuery = useApi(CARDS_URL, loadCards);
  const sealedQuery = useApi(SEALED_URL);
  const locationsQuery = useApi('/api/locations');
  const setsQuery = useApi('/api/sets');

  const usersError = usersQuery.error;
  useEffect(() => {
    if (usersError?.body?.code === 'trades_disabled') setRefused(true);
  }, [usersError]);

  const users = useMemo(
    () => (access.canTrade && Array.isArray(usersQuery.data?.users) ? usersQuery.data.users : []),
    [access.canTrade, usersQuery.data]
  );
  const contacts = useMemo(
    () => (Array.isArray(contactsQuery.data?.contacts) ? contactsQuery.data.contacts : []),
    [contactsQuery.data]
  );
  const locationNames = useMemo(
    () => new Map((Array.isArray(locationsQuery.data) ? locationsQuery.data : []).map(location => [location.id, location.name])),
    [locationsQuery.data]
  );
  const cards = useMemo(
    () => withLocationNames(Array.isArray(cardsQuery.data) ? cardsQuery.data : [], locationNames),
    [cardsQuery.data, locationNames]
  );
  const sealed = useMemo(
    () => (Array.isArray(sealedQuery.data?.units) ? sealedQuery.data.units : []),
    [sealedQuery.data]
  );
  const sets = useMemo(() => (Array.isArray(setsQuery.data) ? setsQuery.data : []), [setsQuery.data]);
  const inventoryError = cardsQuery.error || sealedQuery.error;

  // What an accept or a recorded deal moved in or out. Resolves to the fresh
  // lists (null for one that did not come back).
  const reloadInventory = useStableCallback(async () => {
    const [cardsResult, sealedResult] = await Promise.all([cardsQuery.refetch(), sealedQuery.refetch()]);
    return {
      cards: Array.isArray(cardsResult?.data) ? withLocationNames(cardsResult.data, locationNames) : null,
      sealed: Array.isArray(sealedResult?.data?.units) ? sealedResult.data.units : null,
    };
  });

  const refreshOthers = useStableCallback(() => {
    if (!access.members) return;
    transfers.refresh();
    historical.refresh();
  });

  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) refreshOthers();
    wasActive.current = active;
  }, [active, refreshOthers]);

  // --- offers between members -------------------------------------------

  const propose = async (body) => {
    const { data } = await sendJson('/api/transfers', 'POST', body);
    if (data?.transfer) transfers.edit(state => prependItem(state, data.transfer));
    return data;
  };

  const counter = async (original, body) => {
    const { data } = await sendJson(`/api/transfers/${original.id}/counter`, 'POST', body);
    transfers.edit((state) => {
      const answered = replaceItem(state, original.id, item => ({ ...item, status: 'countered', updated_at: nowUtc() }));
      return data?.transfer ? prependItem(answered, data.transfer) : answered;
    });
    return data;
  };

  // accept | reject | cancel. Accepting moves copies both ways.
  const respond = async (transfer, action) => {
    const { data } = await sendJson(`/api/transfers/${transfer.id}/${action}`, 'PUT');
    transfers.edit(state => replaceItem(state, transfer.id, item => data?.transfer
      || { ...item, status: ACTION_STATUS[action], updated_at: nowUtc() }));
    if (action === 'accept') await reloadInventory();
    return data;
  };

  const toggleSealedTrade = async (unit) => {
    const { data } = await sendJson(`/api/transfers/sealed/${unit.id}/trade`, 'PUT', { is_trade: !unit.is_trade });
    const isTrade = data && 'is_trade' in data ? (data.is_trade ? 1 : 0) : (unit.is_trade ? 0 : 1);
    sealedQuery.mutate(current => ({
      ...(current || {}),
      units: (current?.units || []).map(other => (other.id === unit.id ? { ...other, is_trade: isTrade } : other)),
    }));
    return data;
  };

  // --- past trades recorded with members ---------------------------------

  const recordPastTrade = async (payload) => {
    const { data } = await sendJson('/api/transfers/history', 'POST', payload);
    if (data?.trade) historical.edit(state => prependItem(state, data.trade));
    return data;
  };

  const confirmPastTrade = async (tradeId, items) => {
    const { data } = await sendJson(`/api/transfers/history/${tradeId}/confirm`, 'PUT', { items });
    historical.edit(state => replaceItem(state, tradeId, item => data?.trade || { ...item, status: 'confirmed' }));
    await reloadInventory();
    return data;
  };

  // A declined record is hidden from the member who declined it.
  const rejectPastTrade = async (tradeId) => {
    const { data } = await sendJson(`/api/transfers/history/${tradeId}/reject`, 'PUT', {});
    historical.edit(state => removeItem(state, tradeId));
    return data;
  };

  const cancelPastTrade = async (tradeId) => {
    const { data } = await sendJson(`/api/transfers/history/${tradeId}`, 'DELETE');
    historical.edit(state => removeItem(state, tradeId));
    return data;
  };

  // --- deals with people outside Bindarr ----------------------------------

  const addContact = async (name) => {
    const { data } = await sendJson('/api/transfers/external/contacts', 'POST', { name });
    const contact = data?.contact;
    if (contact) {
      contactsQuery.mutate(current => ({
        ...(current || {}),
        contacts: [...(current?.contacts || []).filter(other => other.id !== contact.id), contact]
          .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      }));
    }
    return contact;
  };

  // Given copies leave the collection and received ones join it.
  const saveExternalDeal = async (body) => {
    const { data } = await sendJson('/api/transfers/external', 'POST', body);
    if (data?.transaction) external.edit(state => prependItem(state, data.transaction));
    await reloadInventory();
    return data;
  };

  return {
    me,
    access,
    markTradesOff,
    transfers,
    historical,
    external,
    users,
    usersError,
    contacts,
    cards,
    sealed,
    sets,
    // Waiting for a first answer: neither a (cached) list nor a failure yet.
    inventoryLoading: (cardsQuery.data === undefined || sealedQuery.data === undefined) && !inventoryError,
    inventoryError,
    reloadInventory,
    propose,
    counter,
    respond,
    toggleSealedTrade,
    recordPastTrade,
    confirmPastTrade,
    rejectPastTrade,
    cancelPastTrade,
    addContact,
    saveExternalDeal,
  };
}
