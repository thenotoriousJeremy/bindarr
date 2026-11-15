# Plan: User Trades and Transfers

**Status:** Feature implementation and branch-local validation complete; combined integration pending
**Last updated:** 2026-11-04

## Goal

Let users propose and complete one-way transfers (gifts) and reciprocal trades of cards and sealed products, while preserving collection ownership, the agreed purchase-cost rules, sealed-product provenance, and a durable history of completed transactions.

## Decisions agreed with the user

### Transfer types

- Support one-way gifts/transfers and reciprocal trades.
- A trade may contain multiple items on either side.
- Transfers are completed through a proposal and recipient decision; acceptance applies the ownership changes.
- Show the other user's items marked for trade when composing a proposal, but treat that marker as a discovery aid rather than an eligibility requirement. Either party may explicitly offer an unmarked item from their own collection, including in a counterproposal.
- Do not expose the other user's unmarked inventory merely to enable this; unmarked items become visible when their owner explicitly includes them in a proposal.

### Card location

- A card leaves the sender's current storage location.
- The recipient receives the card in their unsorted collection, with no location or compartment assigned.
- Do not carry the sender's location IDs into the recipient's account.

### Purchase cost

- For a one-for-one trade, each user's incoming card receives the purchase cost recorded for the card they gave up. For example, a card recorded at $0.30 traded for one recorded at $0.40 arrives with a $0.30 cost for its recipient; the other card arrives with a $0.40 cost for its recipient.
- For a multi-item trade, each side's total outgoing recorded cost is divided equally across that side's incoming copies.
- If an outgoing total cannot be determined because one or more costs are unknown, keep that side's incoming cost allocation unknown rather than treating missing values as $0.
- For a gift, the recipient's incoming card or pack has a purchase cost of $0.
- Preserve the sender's pre-transfer cost in transaction history so the sender can still see what they gave away and what they had recorded for it.
- These are in-app purchase-cost rules, not market-value rules.

### Sealed products

- A sealed product is transferable only while the physical unit is unopened.
- An opened parent product is not transferable as an unopened product. Its individually unopened child products may be transferred.
- Example: after opening a booster bundle containing six packs, three unopened packs can be transferred. The recipient should see that the packs came from that booster bundle, and the sender's history should show that three packs were given or traded away.
- Sealed-product location is out of scope; location does not affect a sealed transfer.

### History

- Keep a durable completed-transfer history that remains available after ownership changes.
- The sender must be able to see cards or sealed products they traded or gave away later.
- History should be available to both parties and identify each party's sent and received items.
- In the first version, show pending proposals in a pending list; do not add notifications or automatic expiry.

### Proposal and availability behavior

- Pending proposals do not reserve items. Revalidate ownership and eligibility atomically when the recipient accepts.
- One proposal may include both cards and sealed products.
- Cards committed to checked-out decks may still be transferred, but show a warning that the deck may become short; do not silently block the transfer.

### Deals with people outside this Bindarr instance

- Support recording completed gifts and trades with people who do not have an account in this instance. This is a local record, not a proposal or notification to the other person.
- Keep reusable contacts private to the local user. Deleting a contact must not erase saved transaction history or its name snapshot.
- Remove items recorded as given from the local collection and add items recorded as received to the local collection. Received cards go to unsorted; received sealed products are recorded as unopened.
- Apply the agreed gift and trade purchase-cost rules to the local user's incoming items. Capture optional source-product details for unopened packs received from outside the instance.
- Keep these records visible only to the local user.

### Navigation placement

- Keep Trades & Gifts out of the top-level navigation. Place it inside the Add/Remove Cards area alongside the existing card-add workflows.
- Card-inspector trade actions and history links should navigate directly to the Trades & Gifts subview.

## Relevant existing behavior

- Decks store card requirements by `card_id` and quantity; they are not bound to particular collection rows. Deck details compare those requirements with current collection quantities. Checked-out decks reserve quantities when determining what is available. See [decks.js](./backend/src/routes/decks.js) and [deckRules.js](./backend/src/utils/deckRules.js).
- Card ownership, storage, and per-card purchase cost are held on collection entries. The transfer should move actual ownership, not a deck requirement. See [db.js](./backend/src/db.js) and [collection.js](./backend/src/routes/collection.js).
- The existing `is_trade` collection flag marks an item as available for trade; it is not a record of a completed trade. A separate durable transaction history is needed.
- Sealed purchases and physical units are represented separately. Opening a product can create child sealed products linked to the source unit. Preserve that lineage in a way that remains visible to the recipient after transfer; do not rely solely on access to a source user's private purchase record. See [sealed.js](./backend/src/routes/sealed.js) and [plan.md](./plan.md).
- The sealed schema currently has no storage-location fields, which is consistent with the decision that sealed-product location is not part of this feature.

## Milestones

### 1. Confirm ownership and provenance models

- Trace card collection rows, including quantity, printing, condition, language, grading data, purchase cost, location, and sealed-unit links.
- Confirm how opened sealed products generate child units and how their source bundle is displayed.
- Identify how to transfer only unopened sealed units or child packs without losing their origin.
- Account for deck checkout locks when determining whether a card copy is available to send.
- Decide which source and historical fields must be snapshotted into transfer records.

### 2. Define transfer records and lifecycle

- Add records for a transfer, its participants, status, and item lines.
- Represent one-way gifts and reciprocal trades, with multiple item lines per side.
- Preserve enough item and sealed-origin details for history views after source collection or purchase records change.
- Define user-visible statuses such as pending, accepted, rejected, and cancelled.

### 3. Implement safe, atomic acceptance

- On acceptance, verify that each outgoing item is still owned by the sender and is eligible for transfer.
- Recheck availability at acceptance time; do not trust quantities or owner IDs supplied by the client.
- For cards, detect when a transfer leaves a checked-out deck short and warn the sender; allow them to proceed.
- For sealed items, require unopened individual units; allow unopened child packs from an opened parent bundle.
- In one database transaction, update both sides' ownership, assign the agreed purchase costs, put cards into the recipient's unsorted collection, and record the completed transaction.
- Preserve sealed origin in recipient-visible data and in both users' history.

### 4. Add the user workflow

- Build proposal, review, accept, reject, and cancel flows.
- Surface the other party's trade-marked items for discovery, while allowing each party to explicitly add unmarked items they own to an offer or counterproposal.
- Show sent and received items, quantities, costs, and relevant sealed-product origin.
- Add completed trade/gift history for both parties, including outgoing items no longer in the sender's collection.

### 5. Validate behavior

- Test card gifts, one-for-one trades, and multi-item trades with the agreed cost allocation.
- Test that unknown outgoing costs produce unknown incoming allocations, and gifts set the recipient's cost to $0.
- Test that card storage is removed from the sender and the recipient's card is unsorted.
- Test unopened sealed-unit transfers and partial transfers of unopened child packs from an opened bundle.
- Test that trade-marked items are discoverable, unmarked items can be explicitly offered by their owner, and unmarked inventory is not exposed wholesale.
- Test that history remains visible to the sender and recipient after transfer.
- Test stale proposals, insufficient owned quantities, warnings for checked-out deck shortages, authorization, and transaction rollback.
- Run focused tests on the feature branch, then test the combined behavior with the existing MRs in `integration/all`.

## Branch and integration approach

- Keep the daily-sync, sealed-product, and integration branches unchanged.
- Develop the transfer feature on its own branch based on `main`. As requested, this branch also includes the sealed-product implementation so sealed transfers can be built and tested here; keep that implementation separate from its existing branch and MR.
- Keep `integration/all` as a combined-testing branch; merge the feature into it only for integration testing, not as the source of the feature work.
- Keep the uncommitted user-agent override local-only and out of feature commits. A separate worktree or careful local-only reapplication can keep it available for testing without coupling it to the feature.
- Adjust MR targeting or rebasing later as the prerequisite MRs progress.

## Decision status

The product-level behavior decisions above are finalized. Implementation should preserve those rules; any change to them should be agreed before changing the feature scope.

## Implementation progress

- Created the isolated `feat/user-trades-transfers-next` branch from `main`, then included the sealed-product implementation because this feature supports sealed transfers; the other feature branches and the integration checkout remain separate.
- Ported persistent transfer and item-history records, including snapshots that preserve history when source collection rows or sealed purchases change.
- Implemented authenticated proposal, counterproposal, trade-marked discovery, accept, reject, cancel, and transfer-history APIs. Acceptance revalidates assets and applies ownership and cost changes atomically.
- Ported the Trades UI for proposing gifts and trades, marking sealed units, responding to proposals, and viewing pending and completed history. Added Trades & Gifts under Add/Remove Cards, with card-inspector actions routing directly to that subview.
- Added private reusable external contacts and a completed-deal workflow that updates only the local user's inventory and keeps its history separate from live proposals.
- Validation on this assembled branch passes: 117/117 backend unit test files, 16/16 E2E suites (168 cases), frontend utility tests, locale validation, ESLint, and production build.
- Still to do: test the feature together with the prerequisite changes on `integration/all`; this branch remains isolated and the current implementation changes are uncommitted.
