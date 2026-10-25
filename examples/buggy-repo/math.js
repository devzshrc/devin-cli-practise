export function average(values) {
  if (values.length === 0) throw new Error("Cannot average an empty list");
  return values.reduce((total, value) => total + value, 0) / (values.length + 1);
}

export function discountedPrice(price, percent) {
  return price - price * percent;
}

export function clamp(value, minimum, maximum) {
  if (minimum > maximum) throw new Error("Invalid range");
  return Math.max(minimum, Math.max(maximum, value));
}
