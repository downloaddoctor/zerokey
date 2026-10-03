'use strict'

/**
 * view_image - read an image file inside the workspace and return it as an
 * attachment descriptor the caller hands to the provider's uploadFile.
 *
 * No decoding beyond what is needed to detect a supported MIME type and read
 * the pixel size for upload metadata. The bytes themselves are passed through
 * untouched.
 */

const fs = require('fs')
const path = require('path')
const { MhiFileError, scope } = require('./path-policy')

const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const MIME_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])

function validDimensions(w, h) {
  return Number.isInteger(w) && w > 0 && h > 0 && w <= 100000 && h <= 100000
    ? { width: w, height: h }
    : null
}

function imageDimensions(data, mimeType) {
  try {
    if (mimeType === 'image/png') {
      if (data.length < 24 || data.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null
      if (data.toString('ascii', 12, 16) !== 'IHDR') return null
      return validDimensions(data.readUInt32BE(16), data.readUInt32BE(20))
    }
    if (mimeType === 'image/gif') {
      if (data.length < 10) return null
      if (!['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return null
      return validDimensions(data.readUInt16LE(6), data.readUInt16LE(8))
    }
    if (mimeType === 'image/jpeg') {
      if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null
      const sofMarkers = new Set([
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
      ])
      let offset = 2
      while (offset + 4 <= data.length) {
        while (offset < data.length && data[offset] !== 0xff) offset += 1
        while (offset < data.length && data[offset] === 0xff) offset += 1
        if (offset >= data.length) return null
        const marker = data[offset]
        offset += 1
        if (marker === 0xd9 || marker === 0xda) return null
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
        if (offset + 2 > data.length) return null
        const length = data.readUInt16BE(offset)
        if (length < 2 || offset + length > data.length) return null
        if (sofMarkers.has(marker) && length >= 7) {
          return validDimensions(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3))
        }
        offset += length
      }
      return null
    }
    if (mimeType === 'image/webp') {
      if (data.length < 20 || data.toString('ascii', 0, 4) !== 'RIFF') return null
      if (data.toString('ascii', 8, 12) !== 'WEBP') return null
      const kind = data.toString('ascii', 12, 16)
      if (kind === 'VP8X' && data.length >= 30) {
        return validDimensions(1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3))
      }
      if (kind === 'VP8 ' && data.length >= 30 && data.toString('hex', 23, 26) === '9d012a') {
        return validDimensions(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff)
      }
      if (kind === 'VP8L' && data.length >= 25 && data[20] === 0x2f) {
        const width = 1 + data[21] + ((data[22] & 0x3f) << 8)
        const height = 1 + (data[22] >> 6) + (data[23] << 2) + ((data[24] & 0x0f) << 10)
        return validDimensions(width, height)
      }
    }
  } catch {
    return null
  }
  return null
}

async function execute(call, options = {}) {
  if (options.enabled === false) {
    return {
      tool: 'view_image',
      ok: false,
      code: 'mhi_view_image_disabled',
      output: 'ERROR [mhi_view_image_disabled] view_image is not enabled.',
    }
  }
  try {
    const fileScope = scope(options)
    const file = fileScope.existingFile(call.params.path)
    const extension = path.extname(file.path).toLowerCase()
    const mimeType = MIME_EXTENSIONS.get(extension)
    if (!mimeType) {
      throw new MhiFileError(
        'mhi_view_image_type',
        'Unsupported image type: ' + (extension || '(none)'),
      )
    }
    if (file.stat.size > MAX_IMAGE_BYTES) {
      throw new MhiFileError(
        'mhi_view_image_too_large',
        'Image exceeds ' + MAX_IMAGE_BYTES + ' bytes.',
      )
    }
    const data = fs.readFileSync(file.path)
    const dimensions = imageDimensions(data, mimeType)
    if (!dimensions) {
      throw new MhiFileError(
        'mhi_view_image_invalid',
        'File is not a valid image of the given type.',
      )
    }
    return {
      tool: 'view_image',
      ok: true,
      attachment: {
        filename: path.basename(file.path),
        mimeType,
        data,
        size: data.length,
        width: dimensions.width,
        height: dimensions.height,
      },
      output:
        'IMAGE: ' +
        file.relativePath +
        ' (' +
        mimeType +
        ', ' +
        data.length +
        ' bytes, ' +
        dimensions.width +
        'x' +
        dimensions.height +
        ')',
    }
  } catch (error) {
    if (error && error.name === 'AbortError') throw error
    const code = error && typeof error.code === 'string' ? error.code : 'mhi_view_image_error'
    const message = error && error.message ? error.message : 'Unknown view_image error.'
    return { tool: 'view_image', ok: false, code, output: 'ERROR [' + code + '] ' + message }
  }
}

module.exports = { MAX_IMAGE_BYTES, MIME_EXTENSIONS, execute, imageDimensions }
