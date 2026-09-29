export function fenToInput(fen: number): string {
  if (!Number.isInteger(fen) || fen < 0) return '0.00'
  return (fen / 100).toFixed(2)
}

export function fenToCurrency(fen: number): string {
  const safeFen = Number.isFinite(fen) ? Math.round(fen) : 0
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safeFen / 100)
}

export function parseYuanToFen(input: string): number | null {
  const normalized = input.trim().replace(/[,，\s￥¥]/g, '')
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) return null
  const [yuan, decimals = ''] = normalized.split('.')
  const fen = Number(yuan) * 100 + Number(decimals.padEnd(2, '0'))
  return Number.isSafeInteger(fen) && fen >= 0 ? fen : null
}
