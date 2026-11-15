function selectionsFromTransferItems(items, availableItems) {
  const selections = {};
  for (const item of items) {
    const type = item.item_type;
    const id = type === 'card' ? item.source_collection_id : item.source_sealed_unit_id;
    if (!id) continue;

    const key = `${type}:${id}`;
    const available = availableItems?.get(key);
    if (availableItems && !available) continue;
    const copies = type === 'card' ? Number(item.quantity) || 1 : 1;
    const quantity = (selections[key]?.quantity || 0) + copies;
    selections[key] = {
      type,
      id,
      quantity: type === 'card' && available
        ? Math.min(quantity, Number(available.quantity) || 1)
        : quantity
    };
  }
  return selections;
}

export function counterSelections(transfer, availableItems) {
  return {
    offered: selectionsFromTransferItems(
      transfer.items.filter(item => item.from_user_id === transfer.recipient_id),
      availableItems
    ),
    requested: selectionsFromTransferItems(
      transfer.items.filter(item => item.from_user_id === transfer.proposer_id)
    )
  };
}
