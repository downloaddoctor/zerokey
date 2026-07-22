const fs = require('fs')

/**
 * Decode base64 data URIs from a message's content parts.
 * Returns an array of file objects ready for upload.
 *
 * @param {Array} parts - message.content array
 * @returns {Array<{ filename: string, data: Buffer, size: number }>}
 */
function decodeContentParts(parts) {
  if (!Array.isArray(parts)) return []

  const files = []
  for (const part of parts) {
    if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
      const match = part.image_url.url.match(/^data:([^;]*);base64,(.+)$/)
      if (match) {
        const mime = match[1]
        const data = Buffer.from(match[2], 'base64')
        const ext = mime.split('/')[1] || 'png'
        files.push({
          filename: `image_${Date.now()}_${files.length}.${ext}`,
          data,
          size: data.length,
          mimeType: mime,
        })
      }
    } else if (part.type === 'file' && part.file?.file_data?.startsWith('data:')) {
      const match = part.file.file_data.match(/^data:([^;]*);base64,(.+)$/)
      if (match) {
        const mime = match[1]
        const data = Buffer.from(match[2], 'base64')
        files.push({
          filename: part.file.filename || `file_${Date.now()}_${files.length}`,
          data,
          size: data.length,
          mimeType: mime,
        })
      }
    }
  }
  return files
}

module.exports = { decodeContentParts }
