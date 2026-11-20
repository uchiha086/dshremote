// 二维码渲染：只借用 qrcode 包的「矩阵生成」核心（vendored 在 ../vendor/qr/core），
// 不依赖 pngjs / canvas，输出 SVG 字符串，电脑上直接用浏览器打开就能扫。
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const QRCode = require('../vendor/qr/core/qrcode.js')

/**
 * 把文本编码成 SVG 二维码。
 * @param {string} text 要编码的内容（配对链接，纯 ASCII）
 * @param {{scale?: number, margin?: number, ecc?: string}} options
 * @returns {string} 完整 SVG 文档
 */
export function svgOf(text, options = {}) {
  const scale = Math.max(2, Math.floor(options.scale ?? 8))
  const margin = Math.max(0, Math.floor(options.margin ?? 4))
  const ecc = options.ecc ?? 'M'
  const code = QRCode.create(String(text), { errorCorrectionLevel: ecc })
  const size = code.modules.size
  const total = (size + margin * 2) * scale
  const rects = []
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!code.modules.get(row, col)) continue
      const x = (col + margin) * scale
      const y = (row + margin) * scale
      rects.push(`<rect x="${x}" y="${y}" width="${scale}" height="${scale}"/>`)
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`,
    `<rect width="${total}" height="${total}" fill="#ffffff"/>`,
    `<g fill="#000000">${rects.join('')}</g>`,
    '</svg>',
  ].join('')
}

/** 矩阵的 0/1 字符串数组，方便自测与调试。 */
export function matrixOf(text, options = {}) {
  const code = QRCode.create(String(text), { errorCorrectionLevel: options.ecc ?? 'M' })
  const size = code.modules.size
  const rows = []
  for (let row = 0; row < size; row += 1) {
    let line = ''
    for (let col = 0; col < size; col += 1) line += code.modules.get(row, col) ? '1' : '0'
    rows.push(line)
  }
  return rows
}
