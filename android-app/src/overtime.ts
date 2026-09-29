export function formatOvertimeMultiplier(percent: number): string {
  const multiplier = percent / 100
  return `${Number.isInteger(multiplier) ? multiplier.toFixed(0) : multiplier.toFixed(2).replace(/0+$/, '')} 倍`
}
