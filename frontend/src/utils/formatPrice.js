export function formatPrice(p) {
  if (p === null || p === undefined) return '0.00';
  const num = parseFloat(p);
  return isNaN(num) ? '0.00' : num.toFixed(2);
}
