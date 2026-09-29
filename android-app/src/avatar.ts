const MAX_SOURCE_BYTES = 10 * 1024 * 1024
const MAX_AVATAR_BYTES = 512 * 1024
const MAX_AVATAR_EDGE = 512
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' })
const pictographic = /\p{Extended_Pictographic}/u
const regionalFlag = /^(?:\p{Regional_Indicator}){2}$/u
const keycap = /^[#*0-9]\uFE0F?\u20E3$/u

export function isSingleVisibleEmoji(value: string): boolean {
  const normalized = value.trim()
  if (!normalized || normalized !== value) return false
  const graphemes = [...segmenter.segment(normalized)]
  return graphemes.length === 1
    && graphemes[0]?.segment === normalized
    && (pictographic.test(normalized) || regionalFlag.test(normalized) || keycap.test(normalized))
}

function dataUrlBytes(dataUrl: string): number {
  const encoded = dataUrl.split(',', 2)[1] ?? ''
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  return Math.max(0, (encoded.length * 3) / 4 - padding)
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const source = URL.createObjectURL(file)
    const cleanup = () => URL.revokeObjectURL(source)
    image.onload = () => {
      cleanup()
      resolve(image)
    }
    image.onerror = () => {
      cleanup()
      reject(new Error('无法读取这张图片，请换一张试试。'))
    }
    image.src = source
  })
}

export async function imageFileToAvatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('剪贴板或文件中没有可用图片。')
  if (file.size <= 0 || file.size > MAX_SOURCE_BYTES) throw new Error('原图不能超过 10 MB。')
  const image = await loadImage(file)
  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  if (!sourceWidth || !sourceHeight) throw new Error('图片尺寸无效。')

  let scale = Math.min(1, MAX_AVATAR_EDGE / Math.max(sourceWidth, sourceHeight))
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(sourceWidth * scale))
    canvas.height = Math.max(1, Math.round(sourceHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前环境无法处理头像图片。')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    for (const quality of [0.88, 0.76, 0.64, 0.52]) {
      const result = canvas.toDataURL('image/webp', quality)
      if (/^data:image\/(?:webp|png|jpeg);base64,/i.test(result) && dataUrlBytes(result) <= MAX_AVATAR_BYTES) {
        return result
      }
    }
    scale *= 0.78
  }
  throw new Error('图片处理后仍然过大，请换一张更简单的图片。')
}
