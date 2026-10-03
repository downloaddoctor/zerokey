'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const viewImage = require('../../../core/mhi/view-image')

const ROOT = path.resolve(__dirname, '..')
const SCRATCH = path.join(ROOT, 'temp', 'mhi-view-image-scratch')

function makePng() {
  return Buffer.from(
    '89504e470d0a1a0a0000000d494844520000000100000001080200000090' +
      '7753de0000000c4944415408d763f8ffff3f0005fe02fea735c7d4000000' +
      '0049454e44ae426082',
    'hex',
  )
}

function makeGif() {
  return Buffer.from('474946383761010001008000000000ffffff2c00000000010001000002024c01003b', 'hex')
}

function reset() {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
  fs.mkdirSync(SCRATCH, { recursive: true })
  fs.writeFileSync(path.join(SCRATCH, 'pixel.png'), makePng())
  fs.writeFileSync(path.join(SCRATCH, 'pixel.gif'), makeGif())
  fs.writeFileSync(path.join(SCRATCH, 'text.txt'), 'not an image', 'utf8')
  fs.writeFileSync(path.join(SCRATCH, 'fake.png'), 'nope', 'utf8')
}

function ctx() {
  return { context: { rootPath: SCRATCH } }
}

test('view_image returns an attachment for a valid PNG', async () => {
  reset()
  const result = await viewImage.execute(
    { tool: 'view_image', params: { path: path.join(SCRATCH, 'pixel.png') } },
    { ...ctx(), enabled: true },
  )
  assert.equal(result.ok, true)
  assert.equal(result.attachment.mimeType, 'image/png')
  assert.equal(result.attachment.width, 1)
  assert.equal(result.attachment.height, 1)
})

test('view_image returns an attachment for a valid GIF', async () => {
  reset()
  const result = await viewImage.execute(
    { tool: 'view_image', params: { path: path.join(SCRATCH, 'pixel.gif') } },
    { ...ctx(), enabled: true },
  )
  assert.equal(result.ok, true)
  assert.equal(result.attachment.mimeType, 'image/gif')
})

test('view_image refuses an unsupported extension', async () => {
  reset()
  const result = await viewImage.execute(
    { tool: 'view_image', params: { path: path.join(SCRATCH, 'text.txt') } },
    { ...ctx(), enabled: true },
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'mhi_view_image_type')
})

test('view_image refuses a file that is not a valid image', async () => {
  reset()
  const result = await viewImage.execute(
    { tool: 'view_image', params: { path: path.join(SCRATCH, 'fake.png') } },
    { ...ctx(), enabled: true },
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'mhi_view_image_invalid')
})

test('view_image refuses when disabled', async () => {
  reset()
  const result = await viewImage.execute(
    { tool: 'view_image', params: { path: path.join(SCRATCH, 'pixel.png') } },
    { ...ctx(), enabled: false },
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'mhi_view_image_disabled')
})
