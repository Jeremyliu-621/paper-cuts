import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto('file://' + path.resolve('index.html') + '#library')
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

  const apply = await page.evaluate(() => {
    localStorage.removeItem(window.DS.WorldLibrary.KEY)
    const world = window.DS.WorldLibrary.createWorld()
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
      mapId: 'meadow',
    })
    const result = window.MagicBoardGame.applyPatch(patch)
    const stage = window.DS.Maps.stageFor(window.DS.Store.data, 'meadow')
    const updated = window.DS.WorldLibrary.updateWorld(world.id, {
      mapId: 'meadow',
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
    }
  })

  assert.equal(apply.result.ok, true)
  assert.equal(apply.result.applied, 1)
  assert.equal(apply.ready, true)
  assert.equal(apply.status, 'ready to play')
  assert.equal(apply.generatedPlatform.kind, 'float')
  assert.equal(apply.generatedPlatform.pass, true)
  assert.equal(apply.generatedPlatform.source.kind, 'magicboard_agent')

  console.log('Desktop browser smoke tests passed')
} finally {
  await browser.close()
}
