/**
 * Extract files from messages array (OpenAI multimodal format).
 * Scans backwards from second-to-last message; stops at first message
 * without file/image content parts.
 *
 * Supports:
 *   - content array with { type: 'image_url', image_url: { url: 'data:<mime>;base64,...' } }
 *   - content array with { type: 'file', file: { file_data: 'data:<mime>;base64,...', filename: '...' } }
 *
 * @param {Array} messages - OpenAI-format messages
 * @returns {Array<{ filename: string, data: Buffer, size: number }>}
 */
function extractFiles(messages) {
  if (messages.length < 2) return []

  const files = []

  for (let i = messages.length - 2; i >= 0; i--) {
    const msg = messages[i]
    const content = msg.content
    if (!Array.isArray(content)) break

    let found = false
    for (const part of content) {
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
          })
          found = true
        }
      } else if (part.type === 'file' && part.file?.file_data?.startsWith('data:')) {
        const match = part.file.file_data.match(/^data:([^;]*);base64,(.+)$/)
        if (match) {
          const data = Buffer.from(match[2], 'base64')
          files.push({
            filename: part.file.filename || `file_${Date.now()}_${files.length}`,
            data,
            size: data.length,
          })
          found = true
        }
      }
    }

    if (!found) break
  }

  return files
}

/**
 * Upload extracted files via a provider's uploadFile method.
 * @param {Array<{ filename: string, data: Buffer, size: number }>} files
 * @param {Function} uploadFn - provider upload method, receives file object: { filename, data, size }
 * @param {string} label - log label (e.g. 'Claude', 'DeepSeek')
 * @returns {Promise<string[]>} array of file IDs
 */
async function uploadExtractedFiles(files, uploadFn, label) {
  if (!files.length) return []

  console.debug(`[${label}] Uploading ${files.length} file(s)...`)
  const ids = []
  for (const file of files) {
    const id = await uploadFn(file)
    ids.push(id)
  }
  return ids
}

module.exports = { extractFiles, uploadExtractedFiles }
