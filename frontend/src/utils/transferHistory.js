function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function groupTransferHistory(transfers) {
  const byId = new Map(transfers.map(transfer => [String(transfer.id), transfer]));
  const groups = new Map();

  for (const transfer of transfers) {
    let root = transfer;
    const visited = new Set([String(root.id)]);
    while (root.response_to_transfer_id != null) {
      const parentId = String(root.response_to_transfer_id);
      if (visited.has(parentId)) break;
      const parent = byId.get(parentId);
      if (!parent) break;
      visited.add(parentId);
      root = parent;
    }

    const key = String(root.id);
    const group = groups.get(key) || { root, transfers: [], lastActivity: 0, hasHistory: false };
    group.transfers.push(transfer);
    if (transfer.status !== 'pending') group.hasHistory = true;
    group.lastActivity = Math.max(
      group.lastActivity,
      timestamp(transfer.updated_at || transfer.created_at)
    );
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter(group => group.hasHistory)
    .map(group => ({
      ...group,
      transfers: group.transfers.sort((a, b) =>
        timestamp(a.created_at || a.updated_at) - timestamp(b.created_at || b.updated_at)
        || Number(a.id) - Number(b.id)
      )
    }))
    .sort((a, b) => b.lastActivity - a.lastActivity || Number(b.root.id) - Number(a.root.id));
}
