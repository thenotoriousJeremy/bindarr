// Extracts the numeric portion of a "Page 3" / "Slot 12" style coordinate string.
export const getPageNum = (str) => parseInt((str || '').replace(/\D/g, ''), 10) || 0;
export const getSlotNum = (str) => parseInt((str || '').replace(/\D/g, ''), 10) || 0;
