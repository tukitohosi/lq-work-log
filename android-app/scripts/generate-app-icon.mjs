import { deflateSync } from 'node:zlib'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const assetsDir = path.join(projectRoot, 'assets')
const svgPath = path.join(assetsDir, 'app-icon.svg')
const pngPath = path.join(assetsDir, 'app-icon.png')
const icoPath = path.join(assetsDir, 'app-icon.ico')
const iconSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const sourceSize = 512
const samplesPerAxis = 4

function parseColor(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(value)
  if (!match) throw new Error(`图标只支持 6 位十六进制颜色，收到：${value}`)

  const numeric = Number.parseInt(match[1], 16)
  return {
    red: (numeric >>> 16) & 0xff,
    green: (numeric >>> 8) & 0xff,
    blue: numeric & 0xff,
    alpha: 0xff,
  }
}

function parseSvgRectangles(svg) {
  const viewBox = /viewBox=["']0 0 (\d+) (\d+)["']/.exec(svg)
  if (!viewBox || Number(viewBox[1]) !== sourceSize || Number(viewBox[2]) !== sourceSize) {
    throw new Error(`app-icon.svg 的 viewBox 必须是 0 0 ${sourceSize} ${sourceSize}`)
  }

  const rectangles = []
  for (const match of svg.matchAll(/<rect\s+([^>]*?)\s*\/?>/g)) {
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/([\w:-]+)=["']([^"']+)["']/g)].map((entry) => [entry[1], entry[2]]),
    )
    const rectangle = {
      x: Number(attributes.x),
      y: Number(attributes.y),
      width: Number(attributes.width),
      height: Number(attributes.height),
      radius: Number(attributes.rx ?? 0),
      color: parseColor(attributes.fill),
    }
    if (
      !Object.values(rectangle).every((value) => typeof value === 'object' || Number.isFinite(value)) ||
      rectangle.width <= 0 ||
      rectangle.height <= 0 ||
      rectangle.radius < 0
    ) {
      throw new Error('app-icon.svg 中存在无法解析的矩形')
    }
    rectangles.push(rectangle)
  }

  if (rectangles.length === 0) throw new Error('app-icon.svg 中没有可绘制的矩形')
  return rectangles
}

function isInsideRoundedRectangle(x, y, rectangle) {
  const { width, height } = rectangle
  const radius = Math.min(rectangle.radius, width / 2, height / 2)
  const localX = x - rectangle.x
  const localY = y - rectangle.y
  if (localX < 0 || localY < 0 || localX > width || localY > height) return false
  if (radius === 0) return true

  const nearestX = Math.max(radius, Math.min(width - radius, localX))
  const nearestY = Math.max(radius, Math.min(height - radius, localY))
  const deltaX = localX - nearestX
  const deltaY = localY - nearestY
  return deltaX * deltaX + deltaY * deltaY <= radius * radius
}

function colorAt(x, y, rectangles) {
  let color = null
  for (const rectangle of rectangles) {
    if (isInsideRoundedRectangle(x, y, rectangle)) color = rectangle.color
  }
  return color
}

function rasterize(size, rectangles) {
  const pixels = Buffer.alloc(size * size * 4)
  const sampleCount = samplesPerAxis * samplesPerAxis
  const sourceUnitsPerPixel = sourceSize / size

  for (let pixelY = 0; pixelY < size; pixelY += 1) {
    for (let pixelX = 0; pixelX < size; pixelX += 1) {
      let alphaSum = 0
      let redPremultiplied = 0
      let greenPremultiplied = 0
      let bluePremultiplied = 0

      for (let sampleY = 0; sampleY < samplesPerAxis; sampleY += 1) {
        for (let sampleX = 0; sampleX < samplesPerAxis; sampleX += 1) {
          const x = (pixelX + (sampleX + 0.5) / samplesPerAxis) * sourceUnitsPerPixel
          const y = (pixelY + (sampleY + 0.5) / samplesPerAxis) * sourceUnitsPerPixel
          const color = colorAt(x, y, rectangles)
          if (!color) continue
          alphaSum += color.alpha
          redPremultiplied += color.red * color.alpha
          greenPremultiplied += color.green * color.alpha
          bluePremultiplied += color.blue * color.alpha
        }
      }

      const offset = (pixelY * size + pixelX) * 4
      if (alphaSum > 0) {
        pixels[offset] = Math.round(redPremultiplied / alphaSum)
        pixels[offset + 1] = Math.round(greenPremultiplied / alphaSum)
        pixels[offset + 2] = Math.round(bluePremultiplied / alphaSum)
        pixels[offset + 3] = Math.round(alphaSum / sampleCount)
      }
    }
  }

  return pixels
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

function crc32(buffer) {
  let checksum = 0xffffffff
  for (const byte of buffer) checksum = crcTable[(checksum ^ byte) & 0xff] ^ (checksum >>> 8)
  return (checksum ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  typeBuffer.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length)
  return chunk
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6

  const rowLength = size * 4
  const scanlines = Buffer.alloc((rowLength + 1) * size)
  for (let row = 0; row < size; row += 1) {
    const scanlineOffset = row * (rowLength + 1)
    scanlines[scanlineOffset] = 0
    pixels.copy(scanlines, scanlineOffset + 1, row * rowLength, (row + 1) * rowLength)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function encodeIco(images) {
  const directory = Buffer.alloc(6 + images.length * 16)
  directory.writeUInt16LE(0, 0)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(images.length, 4)

  let imageOffset = directory.length
  images.forEach(({ size, png }, index) => {
    const offset = 6 + index * 16
    directory[offset] = size === 256 ? 0 : size
    directory[offset + 1] = size === 256 ? 0 : size
    directory[offset + 2] = 0
    directory[offset + 3] = 0
    directory.writeUInt16LE(1, offset + 4)
    directory.writeUInt16LE(32, offset + 6)
    directory.writeUInt32LE(png.length, offset + 8)
    directory.writeUInt32LE(imageOffset, offset + 12)
    imageOffset += png.length
  })

  return Buffer.concat([directory, ...images.map(({ png }) => png)])
}

const svg = await readFile(svgPath, 'utf8')
const rectangles = parseSvgRectangles(svg)
const images = iconSizes.map((size) => ({
  size,
  png: encodePng(size, rasterize(size, rectangles)),
}))
const preview = encodePng(sourceSize, rasterize(sourceSize, rectangles))

await mkdir(assetsDir, { recursive: true })
await Promise.all([writeFile(pngPath, preview), writeFile(icoPath, encodeIco(images))])

console.log(`已生成 ${path.relative(projectRoot, pngPath)}（${sourceSize}x${sourceSize}）`)
console.log(`已生成 ${path.relative(projectRoot, icoPath)}（${iconSizes.join(', ')} 像素）`)
