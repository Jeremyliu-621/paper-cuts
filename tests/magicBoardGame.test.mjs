import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

function loadFacade() {
  const saves = []
  const data = {
    stage: {
      platforms: [
        { x: 0, y: 900, w: 500, h: 40, kind: 'ground', pass: false },
        {
          x: 100,
          y: 700,
          w: 200,
          h: 32,
          kind: 'drawn',
          pass: false,
          source: { kind: 'magicboard_agent', candidateId: 'old-generated' },
        },
      ],
      spawns: [],
    },
  }
  const window = {
    DS: {
      Store: {
        data,
        save() {
          saves.push(JSON.parse(JSON.stringify(data)))
        },
      },
      Maps: {
        list() {
          return [{ id: 'meadow' }]
        },
        stageFor(storeData, mapId) {
          if (mapId !== 'meadow') throw new Error('unexpected map')
          return storeData.stage
        },
      },
    },
  }
  const context = vm.createContext({ window, globalThis: window })
  const source = fs.readFileSync(new URL('../js/magicBoardGame.js', import.meta.url), 'utf8')
  vm.runInContext(source, context)
  return { api: window.MagicBoardGame, data, saves }
}

function confirmedCandidate(overrides = {}) {
  return {
    status: 'confirmed',
    roomId: 'room-1',
    worldId: 'world-1',
    captureVersion: 3,
    candidateId: 'candidate-1',
    geometryHash: 'hash-1',
    sourceIds: ['shape-1'],
    geometry: { x: 120, y: 640, w: 260, h: 36 },
    answer: { role: 'platform', behavior: 'bounce' },
    ...overrides,
  }
}

{
  const { api } = loadFacade()
  const patch = api.buildPatchFromSemanticDraft(
    { roomId: 'room-1', worldId: 'world-1', captureVersion: 3, candidates: [confirmedCandidate()] },
    { mapId: 'meadow' },
  )

  assert.equal(patch.type, 'magicboard_world_patch')
  assert.equal(patch.operations.length, 1)
  assert.equal(patch.operations[0].platform.kind, 'trampoline')
  assert.equal(patch.operations[0].platform.bounce, 1200)
}

{
  const { api } = loadFacade()
  const invalid = api.validatePatch({
    type: 'magicboard_world_patch',
    version: 1,
    target: { mapId: 'missing' },
    operations: [{ type: 'run_javascript', code: 'alert(1)' }],
  })

  assert.equal(invalid.ok, false)
  assert.match(invalid.errors.join('\n'), /unknown mapId missing/)
  assert.match(invalid.errors.join('\n'), /unsupported type/)
}

{
  const { api, data, saves } = loadFacade()
  const patch = {
    type: 'magicboard_world_patch',
    version: 1,
    target: { mapId: 'meadow' },
    operations: [
      {
        type: 'add_platform',
        platform: {
          x: 200,
          y: 500,
          w: 300,
          h: 42,
          kind: 'float',
          pass: true,
          source: { kind: 'magicboard_agent', candidateId: 'candidate-new' },
        },
      },
      {
        type: 'add_platform',
        platform: {
          x: 240,
          y: 440,
          w: 180,
          h: 30,
          kind: 'crystal',
          pass: false,
          source: { kind: 'magicboard_agent', candidateId: 'old-generated' },
        },
      },
      { type: 'set_spawns', spawns: [{ x: 300, y: 760 }, { x: 500, y: 760 }] },
    ],
  }

  const result = api.applyPatch(patch)

  assert.equal(result.ok, true)
  assert.equal(result.applied, 3)
  assert.equal(saves.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(data.stage.spawns)), [{ x: 300, y: 760 }, { x: 500, y: 760 }])
  assert.equal(data.stage.platforms.length, 3)
  assert.equal(data.stage.platforms[0].kind, 'ground')
  assert.equal(data.stage.platforms.some((platform) => platform.source?.candidateId === 'old-generated' && platform.x === 100), false)
  assert.equal(data.stage.platforms.some((platform) => platform.source?.candidateId === 'candidate-new'), true)
  assert.equal(data.stage.platforms.some((platform) => platform.source?.candidateId === 'old-generated' && platform.kind === 'crystal'), true)
}

console.log('MagicBoardGame facade tests passed')
