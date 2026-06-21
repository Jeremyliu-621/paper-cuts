import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.addInitScript(() => {
    localStorage.removeItem('magicboard:worlds:v1')
  })
  await page.goto('file://' + path.resolve('index.html') + '?backend=http://localhost:8000#library')
  await page.waitForFunction(() => window.DS && window.DS.WorldLibrary && window.MagicBoardGame && window.DS.Store?.data)

  const shell = await page.evaluate(() => ({
    title: document.querySelector('#library-overlay h1')?.textContent,
    libraryHidden: document.querySelector('#library-overlay')?.hidden,
    hasOpenDraw: !!document.querySelector('#level-preview-draw'),
    hasApply: !!document.querySelector('#level-preview-apply'),
    facade: typeof window.MagicBoardGame.applyPatch,
  }))
  assert.deepEqual(shell, {
    title: 'Game Library',
    libraryHidden: false,
    hasOpenDraw: true,
    hasApply: true,
    facade: 'function',
  })

  const selectionPosts = []
  await page.evaluate(() => {
    window.__magicBoardSelectionPosts = []
    window.fetch = async (input, init = {}) => {
      const url = String(input)
      if (url.includes('/selection/current') && init.method === 'POST') {
        window.__magicBoardSelectionPosts.push(JSON.parse(init.body))
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/rooms/') && url.includes('/capture')) {
        return new Response(JSON.stringify({ roomId: 'smoke-room', version: 0, capture: null, projection: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/selection/current') && init.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
  })
  await page.getByRole('button', { name: 'Create your first game' }).click()
  await page.getByText('Edit Level').first().click()
  await page.waitForFunction(() => window.DS?.LevelPreview?.state?.enabled === true)
  selectionPosts.push(...await page.evaluate(() => window.__magicBoardSelectionPosts))
  assert.equal(pageErrors.some((message) => message.includes('setPreviewRejectState')), false)
  assert.equal(selectionPosts.length, 1)
  assert.equal(selectionPosts[0].roomId.startsWith('world-untitled-1-'), true)
  assert.equal(Array.isArray(selectionPosts[0].stageReference.platforms), true)

  const apply = await page.evaluate(() => {
    localStorage.removeItem(window.DS.WorldLibrary.KEY)
    const world = window.DS.WorldLibrary.createWorld()
    const initialCustomPlatformCount = window.DS.Maps.stageFor(window.DS.Store.data, world.mapId).platforms.length
    const draft = {
      roomId: world.roomId,
      worldId: world.id,
      captureVersion: 1,
      candidates: [
        {
          status: 'confirmed',
          roomId: world.roomId,
          worldId: world.id,
          captureVersion: 1,
          candidateId: 'candidate-smoke',
          geometryHash: 'hash-smoke',
          sourceIds: ['shape-smoke'],
          geometry: { x: 220, y: 660, w: 360, h: 42 },
          answer: { role: 'platform', behavior: 'pass' },
        },
      ],
    }
    const patch = window.MagicBoardGame.buildPatchFromSemanticDraft(draft, {
      worldId: world.id,
      roomId: world.roomId,
      mapId: world.mapId,
    })
    const result = window.MagicBoardGame.applyPatch(patch)
    const stage = window.DS.Maps.stageFor(window.DS.Store.data, world.mapId)
    const updated = window.DS.WorldLibrary.updateWorld(world.id, {
      mapId: world.mapId,
      draft: {
        platforms: patch.operations.map((operation) => operation.platform),
        spawns: stage.spawns.slice(0, 2),
        characters: window.DS.Store.data.roster.slice(0, 2),
      },
    })
    return {
      result,
      ready: window.DS.WorldLibrary.isReady(updated),
      status: window.DS.WorldLibrary.statusFor(updated).id,
      generatedPlatform: stage.platforms.find((platform) => platform.source?.candidateId === 'candidate-smoke'),
      initialCustomPlatformCount,
      customPlatformCount: stage.platforms.length,
    }
  })

  assert.equal(apply.result.ok, true)
  assert.equal(apply.result.applied, 1)
  assert.equal(apply.ready, true)
  assert.equal(apply.status, 'ready to play')
  assert.equal(apply.generatedPlatform.kind, 'float')
  assert.equal(apply.generatedPlatform.pass, true)
  assert.equal(apply.generatedPlatform.source.kind, 'magicboard_agent')
  assert.equal(apply.initialCustomPlatformCount, 0)
  assert.equal(apply.customPlatformCount, 1)

  console.log('Desktop browser smoke tests passed')
} finally {
  await browser.close()
}
