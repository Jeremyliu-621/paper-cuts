import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Tldraw,
  createShapeId,
  getPointsFromDrawSegments,
  getSnapshot,
  loadSnapshot,
  renderPlaintextFromRichText,
  toRichText,
} from 'tldraw'

const DEFAULT_BACKEND_PORT = '8000'
const SYNC_DEBOUNCE_MS = 120
const RECONNECT_DELAY_MS = 1000
const GAME_FRAME = { x: 0, y: 0, w: 1920, h: 1080 }
const FRAME_SHAPE_ID = createShapeId('magicboard-stage-frame')
const EMPTY_STAGE_REFERENCE = { view: { w: GAME_FRAME.w, h: GAME_FRAME.h }, platforms: [], portals: [], spawns: [] }

const SIZE_TO_WIDTH = {
  s: 3,
  m: 6,
  l: 10,
  xl: 16,
}

const COLOR_TO_HEX = {
  black: '#2f2a26',
  grey: '#6b6259',
  lightBlue: '#5b8fcf',
  blue: '#2f6fe0',
  green: '#3f8f86',
  yellow: '#b58a2e',
  orange: '#d4663f',
  red: '#c0603a',
  lightRed: '#f28c78',
  violet: '#9a6cb0',
  purple: '#7c4e92',
  pink: '#d46aa4',
}

function inferredBackendUrlFromPage() {
  const url = new URL(window.location.href)
  url.port = DEFAULT_BACKEND_PORT
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function isLocalHost(hostname) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]'
}

function shouldUseConfiguredBackend(configuredUrl) {
  if (!configuredUrl) return false
  const pageHostIsLocal = isLocalHost(window.location.hostname)
  if (pageHostIsLocal) return true

  try {
    return !isLocalHost(new URL(configuredUrl).hostname)
  } catch (_error) {
    return false
  }
}

function getBackendUrl() {
  const params = new URLSearchParams(window.location.search)
  const urlBackend = params.get('backend')
  if (urlBackend) return urlBackend

  const configuredUrl = import.meta.env.VITE_BACKEND_URL
  if (shouldUseConfiguredBackend(configuredUrl)) return configuredUrl

  return inferredBackendUrlFromPage()
}

function normalizeBackendUrl(rawUrl) {
  const candidate = `${rawUrl || ''}`.trim()
  try {
    return new URL(candidate)
  } catch (_error) {
    try {
      return new URL(`http://${candidate}`)
    } catch (_fallbackError) {
      return new URL(`http://localhost:${DEFAULT_BACKEND_PORT}`)
    }
  }
}

function backendUrlInputValue(backendUrl) {
  return backendUrl.toString().replace(/\/$/, '')
}

function normalizeRoomCode(rawRoomCode) {
  return rawRoomCode
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function healthUrlForBackend(backendUrl) {
  const url = new URL(backendUrl)
  url.pathname = '/health'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function backendUnreachableMessage(backendUrl) {
  return `Could not reach ${backendUrl}. Check the Mac IP, Wi-Fi, backend server, or firewall.`
}

function websocketUrlForRoom(backendUrl, roomId) {
  const url = new URL(backendUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/ws/rooms/${encodeURIComponent(roomId)}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function captureUrlForRoom(backendUrl, roomId) {
  const url = new URL(backendUrl)
  url.pathname = `/rooms/${encodeURIComponent(roomId)}/capture`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function clarificationUrlForRoom(backendUrl, roomId) {
  const url = new URL(backendUrl)
  url.pathname = `/rooms/${encodeURIComponent(roomId)}/clarifications`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function visualObservationUrlForRoom(backendUrl, roomId) {
  const url = new URL(backendUrl)
  url.pathname = `/rooms/${encodeURIComponent(roomId)}/visual-observation`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function selectionWsUrlForBackend(backendUrl) {
  const url = new URL(backendUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws/selection'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function selectionCurrentUrlForBackend(backendUrl) {
  const url = new URL(backendUrl)
  url.pathname = '/selection/current'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function roomSelectionFromUrl() {
  const params = new URLSearchParams(window.location.search)
  const roomId = params.get('room')
  if (!roomId) return null
  return {
    roomId,
    worldId: params.get('world') || roomId,
    worldName: params.get('worldName') || null,
  }
}

function hasStageReference(stageReference) {
  return !!(
    stageReference
    && (
      stageReference.view
      || stageReference.bounds
      || stageReference.platforms?.length
      || stageReference.portals?.length
      || stageReference.spawns?.length
    )
  )
}

function createClientId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID()
  return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function formatTime(value) {
  if (!value) return 'never'
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function colorFor(shape) {
  return COLOR_TO_HEX[shape?.props?.color] || '#d4663f'
}

function widthFor(shape) {
  return SIZE_TO_WIDTH[shape?.props?.size] || 6
}

function toGamePoint(x, y) {
  return {
    x: Math.round((x - GAME_FRAME.x) * 100) / 100,
    y: Math.round((y - GAME_FRAME.y) * 100) / 100,
  }
}

function richTextToPlain(editor, richText) {
  if (!richText) return ''
  try {
    return renderPlaintextFromRichText(editor, richText)
  } catch (_error) {
    return ''
  }
}

function makeProjection(editor, capture) {
  const records = Object.values(capture?.store || {})
  const strokes = []
  const shapes = []
  const labels = []

  for (const record of records) {
    if (record?.typeName !== 'shape' || record?.meta?.magicboardSystem) continue
    const common = {
      id: record.id,
      sourceId: record.id,
      color: colorFor(record),
      opacity: record.opacity ?? 1,
    }
    if (record.type === 'draw') {
      const points = getPointsFromDrawSegments(
        record.props.segments || [],
        record.props.scaleX || record.props.scale || 1,
        record.props.scaleY || record.props.scale || 1,
      ).map((point) => toGamePoint(record.x + point.x, record.y + point.y))
      if (points.length >= 2) {
        strokes.push({
          ...common,
          kind: 'freehand',
          points,
          width: widthFor(record),
        })
      }
    } else if (record.type === 'geo') {
      const x = record.x - GAME_FRAME.x
      const y = record.y - GAME_FRAME.y
      const w = record.props.w || 0
      const h = record.props.h || 0
      shapes.push({
        ...common,
        kind: record.props.geo || 'rectangle',
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        w: Math.round(w * 100) / 100,
        h: Math.round(h * 100) / 100,
        width: widthFor(record),
      })
      const text = richTextToPlain(editor, record.props.richText).trim()
      if (text) {
        labels.push({
          ...common,
          text,
          x: Math.round((x + w / 2) * 100) / 100,
          y: Math.round((y + h / 2) * 100) / 100,
        })
      }
    } else if (record.type === 'text' || record.type === 'note') {
      const text = richTextToPlain(editor, record.props.richText).trim()
      if (text) {
        labels.push({
          ...common,
          text,
          x: Math.round((record.x - GAME_FRAME.x) * 100) / 100,
          y: Math.round((record.y - GAME_FRAME.y) * 100) / 100,
        })
      }
    }
  }

  return {
    type: 'magicboard_projection',
    version: 1,
    coordinateSpace: { type: 'game_view', width: GAME_FRAME.w, height: GAME_FRAME.h },
    strokes,
    shapes,
    labels,
    generatedAt: new Date().toISOString(),
  }
}

function projectionObjectCount(projection) {
  return (projection?.strokes?.length || 0) + (projection?.shapes?.length || 0) + (projection?.labels?.length || 0)
}

function semanticCandidateCount(semanticDraft) {
  return semanticDraft?.candidates?.length || 0
}

function visualObservationLabel(observation) {
  if (!observation) return 'waiting'
  if (observation.status === 'pending') return 'observing'
  if (observation.status === 'ready') return observation.latencyMs ? `ready · ${observation.latencyMs}ms` : 'ready'
  if (observation.status === 'missing_key') return 'missing key'
  if (observation.status === 'stale') return 'stale'
  return 'error'
}

function syncStatusLabel(status) {
  const labels = {
    idle: 'joining',
    waiting: 'joining',
    loading: 'joining',
    connecting: 'joining',
    connected: 'connected',
    disconnected: 'room disconnected',
    error: 'backend unreachable',
  }
  return labels[status] || status
}

function syncStatusClassName(status) {
  if (status === 'connected') return 'connected'
  if (status === 'loading' || status === 'connecting' || status === 'idle' || status === 'waiting') return 'connecting'
  if (status === 'disconnected') return 'disconnected'
  if (status === 'error') return 'error'
  return status
}

function choiceLabel(choice) {
  const labels = {
    yes_platform: 'Solid',
    normal: 'Solid',
    pass_through: 'Pass-through',
    bouncy: 'Bouncy',
    damaging: 'Damaging',
    icy: 'Icy',
    breakable: 'Breakable',
    cannon: 'Cannon',
    decor: 'Decoration',
    no_ignore: 'Ignore',
  }
  return labels[choice?.id] || choice?.label || 'Choose'
}

function compactChoices(choices) {
  const wanted = ['normal', 'spikes', 'cannon', 'portal_pair', 'portal_endpoint', 'decor', 'no_ignore']
  const seen = new Set()
  return wanted
    .map((choiceId) => choices.find((choice) => choice.id === choiceId))
    .filter((choice) => {
      if (!choice || seen.has(choice.role)) return false
      seen.add(choice.role)
      return true
    })
}

function ensureStageFrame(editor) {
  if (!editor.getShape(FRAME_SHAPE_ID)) {
    editor.createShapes([
      {
        id: FRAME_SHAPE_ID,
        type: 'geo',
        x: GAME_FRAME.x,
        y: GAME_FRAME.y,
        isLocked: true,
        opacity: 0.55,
        meta: { magicboardSystem: true },
        props: {
          geo: 'rectangle',
          w: GAME_FRAME.w,
          h: GAME_FRAME.h,
          color: 'orange',
          fill: 'none',
          dash: 'dashed',
          size: 'm',
          font: 'draw',
          align: 'middle',
          verticalAlign: 'middle',
          richText: toRichText(''),
          labelColor: 'orange',
          url: '',
          growY: 0,
          scale: 1,
        },
      },
    ])
  }
  editor.zoomToBounds(GAME_FRAME, { inset: 80, animation: { duration: 120 } })
  editor.setCurrentTool('draw')
}

function platformClassName(platform) {
  const kind = platform.kind || (platform.pass ? 'float' : 'ground')
  return `reference-platform reference-platform-${kind}${platform.pass ? ' reference-platform-pass' : ''}`
}

function PlatformReferenceLayer({ stageReference }) {
  const reference = stageReference || EMPTY_STAGE_REFERENCE
  const view = reference.view || { w: GAME_FRAME.w, h: GAME_FRAME.h }
  const bounds = reference.bounds || { x0: 0, y0: 0, x1: view.w, y1: view.h }
  const platforms = reference.platforms || []
  const portals = reference.portals || []
  const spawns = reference.spawns || []

  return (
    <div
      className="platform-reference-frame"
      data-testid="static-platform-reference"
      aria-hidden="true"
    >
      <svg
        className="platform-reference-svg"
        viewBox={`0 0 ${view.w} ${view.h}`}
        width={view.w}
        height={view.h}
        focusable="false"
      >
        <rect className="reference-view-fill" x="0" y="0" width={view.w} height={view.h} />
        <rect className="reference-bounds" x={bounds.x0 || 0} y={bounds.y0 || 0} width={(bounds.x1 || view.w) - (bounds.x0 || 0)} height={(bounds.y1 || view.h) - (bounds.y0 || 0)} />
        {platforms.map((platform, index) => {
          const radius = Math.min(platform.h / 2, platform.pass ? 16 : 20)
          return (
            <g key={`${platform.x}-${platform.y}-${platform.w}-${platform.h}-${index}`}>
              <rect
                className="reference-platform-shadow"
                x={platform.x + 9}
                y={platform.y + 12}
                width={platform.w}
                height={platform.h}
                rx={radius}
                ry={radius}
              />
              <rect
                className={platformClassName(platform)}
                x={platform.x}
                y={platform.y}
                width={platform.w}
                height={platform.h}
                rx={radius}
                ry={radius}
              />
              <line
                className="reference-platform-topline"
                x1={platform.x + radius}
                y1={platform.y + Math.min(16, platform.h / 2)}
                x2={platform.x + platform.w - radius}
                y2={platform.y + Math.min(16, platform.h / 2)}
              />
            </g>
          )
        })}
        {portals.map((portal, index) => (
          <g key={`portal-${portal.id || index}`}>
            <circle className="reference-portal-fill" cx={portal.x} cy={portal.y} r={portal.r || 44} />
            <circle className="reference-portal-ring" cx={portal.x} cy={portal.y} r={portal.r || 44} />
          </g>
        ))}
        {spawns.map((spawn, index) => (
          <g key={`spawn-${index}`}>
            <circle className="reference-spawn" cx={spawn.x} cy={spawn.y} r="24" />
            <text className="reference-spawn-label" x={spawn.x} y={spawn.y + 8}>{index + 1}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}

function SemanticCandidateLayer({ semanticDraft, selectedCandidateId }) {
  const candidates = semanticDraft?.candidates || []
  if (!candidates.length) return null

  return (
    <svg
      className="semantic-candidate-layer"
      viewBox={`${GAME_FRAME.x} ${GAME_FRAME.y} ${GAME_FRAME.w} ${GAME_FRAME.h}`}
      width={GAME_FRAME.w}
      height={GAME_FRAME.h}
      focusable="false"
      aria-hidden="true"
    >
      {candidates.map((candidate, index) => {
        const geometry = candidate.geometry || {}
        const selected = candidate.candidateId === selectedCandidateId
        const className = [
          'semantic-candidate',
          `semantic-candidate-${candidate.status || 'needs_answer'}`,
          selected ? 'semantic-candidate-selected' : '',
        ].filter(Boolean).join(' ')
        return (
          <g key={candidate.candidateId || `${candidate.geometryHash}-${index}`}>
            <rect
              className={className}
              x={geometry.x}
              y={geometry.y}
              width={geometry.w}
              height={geometry.h}
              rx={Math.min(18, Math.max(4, (geometry.h || 20) / 3))}
              ry={Math.min(18, Math.max(4, (geometry.h || 20) / 3))}
            />
            <text className="semantic-candidate-label" x={(geometry.x || 0) + 12} y={(geometry.y || 0) - 10}>
              {index + 1}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function SemanticPanel({
  semanticDraft,
  selectedCandidateId,
  onSelectCandidate,
  onAnswer,
  error,
  visualObservation,
}) {
  const candidates = semanticDraft?.candidates || []
  const pending = candidates.filter((candidate) => candidate.status === 'needs_answer')
  const current = candidates.find((candidate) => candidate.candidateId === selectedCandidateId)
  const selected = current?.status === 'needs_answer' ? current : pending[0] || current || candidates[0]
  if (!candidates.length) return null
  const question = selected?.question
  const choices = compactChoices(question?.choices || [])
  const pendingCount = pending.length
  const needsManualFallback = visualObservation?.status === 'error' || visualObservation?.status === 'missing_key'

  return (
    <section className="semantic-panel" aria-label="Manual doodle choices">
      <div className="semantic-candidate-strip">
        {candidates.map((candidate, index) => (
          <button
            key={candidate.candidateId}
            className={`semantic-candidate-pill ${candidate.candidateId === selected?.candidateId ? 'active' : ''} status-${candidate.status || 'needs_answer'}`}
            type="button"
            onClick={() => onSelectCandidate(candidate.candidateId)}
          >
            {index + 1}
          </button>
        ))}
      </div>
      {selected ? (
        <div className="semantic-question">
          <div className="semantic-question-head">
            <div>
              <span>{pendingCount ? `Choose type · ${pendingCount} left` : 'Doodle type'}</span>
              <strong>{selected.status === 'needs_answer' ? question?.prompt || 'What should this doodle become?' : selected.answer?.choiceId || selected.status}</strong>
            </div>
            <span>{selected.extractor}</span>
          </div>
          {needsManualFallback && selected.status === 'needs_answer' ? (
            <p className="semantic-answer-state">
              Vision could not decide. Pick a type below.
            </p>
          ) : null}
          {selected.status === 'needs_answer' ? (
            <div className="semantic-choice-grid">
              {choices.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  onClick={() => onAnswer(selected, choice.id)}
                >
                  {choiceLabel(choice)}
                </button>
              ))}
            </div>
          ) : (
            <p className="semantic-answer-state">
              {selected.answer?.role === 'platform' ? `Confirmed: ${selected.answer.behavior}` : selected.status}
            </p>
          )}
          {error ? <p className="semantic-error">{error}</p> : null}
        </div>
      ) : null}
    </section>
  )
}

function VisualObservationPanel({ observation }) {
  if (!observation) return null
  const hints = observation.hints || []
  return (
    <section className={`visual-observation-panel observation-${observation.status}`} aria-label="Visual observation">
      <div className="visual-observation-head">
        <strong>Vision</strong>
        <span>{visualObservationLabel(observation)}</span>
      </div>
      <p>{observation.description || 'Waiting for visual observation.'}</p>
      {hints.length ? (
        <ul>
          {hints.slice(0, 3).map((hint, index) => (
            <li key={`${hint.description}-${index}`}>
              {hint.kind} · {Math.round((hint.confidence || 0) * 100)}%
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function DesktopSelectionPanel({ selection, currentRoomId, onSwitch }) {
  if (!selection?.roomId || selection.roomId === currentRoomId) return null
  return (
    <section className="desktop-selection-panel" aria-label="Desktop selected level">
      <div>
        <strong>Desktop selected</strong>
        <p>{selection.worldName || selection.worldId || selection.roomId}</p>
      </div>
      <button type="button" onClick={() => onSwitch(selection)}>
        Open level
      </button>
    </section>
  )
}

function JoinRoomScreen({
  backendUrl,
  selectionStatus,
  error,
  onJoin,
}) {
  const [roomCode, setRoomCode] = useState('')
  const [backendInput, setBackendInput] = useState(() => backendUrlInputValue(backendUrl))
  const [joinStatus, setJoinStatus] = useState('idle')
  const [joinError, setJoinError] = useState('')
  const normalizedRoom = normalizeRoomCode(roomCode)
  const displayError = joinError || error

  const handleSubmit = async (event) => {
    event.preventDefault()
    setJoinError('')

    if (!normalizedRoom) {
      setJoinError('Enter a room code.')
      return
    }

    const normalizedBackendUrl = normalizeBackendUrl(backendInput)
    const backendValue = backendUrlInputValue(normalizedBackendUrl)
    setBackendInput(backendValue)
    setJoinStatus('joining')

    try {
      const response = await fetch(healthUrlForBackend(normalizedBackendUrl), { cache: 'no-store' })
      if (!response.ok) throw new Error(`Health check failed: ${response.status}`)
      onJoin(normalizedRoom, backendValue)
    } catch (_requestError) {
      setJoinStatus('backend unreachable')
      setJoinError(backendUnreachableMessage(backendValue))
    }
  }

  return (
    <main className="draw-app draw-app-waiting">
      <section className="join-panel" aria-label="Join drawing room">
        <div className="join-panel-head">
          <p className="join-kicker">Magic Board</p>
          <h1>Open a level on the laptop</h1>
        </div>
        <form className="join-form" onSubmit={handleSubmit}>
          <p className="join-hint">
            The iPad will attach automatically when the laptop opens Edit Level.
          </p>
          <label className="join-field">
            <span>Room code</span>
            <input
              type="text"
              value={roomCode}
              onChange={(event) => setRoomCode(event.target.value)}
              inputMode="text"
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="demo"
              aria-describedby="room-code-hint"
            />
          </label>
          <p id="room-code-hint" className="join-hint">
            Manual room entry is available for testing.
          </p>
          <details className="join-advanced">
            <summary>Connection</summary>
            <label className="join-field">
              <span>Backend URL</span>
              <input
                type="url"
                value={backendInput}
                onChange={(event) => setBackendInput(event.target.value)}
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
              />
            </label>
          </details>
          <button className="join-button" type="submit" disabled={joinStatus === 'joining'}>
            {joinStatus === 'joining' ? 'Joining...' : 'Join'}
          </button>
        </form>
        <div className="join-details" aria-label="Connection details">
          <dl>
            <div>
              <dt>Status</dt>
              <dd>{joinStatus === 'idle' ? selectionStatus : joinStatus}</dd>
            </div>
            <div>
              <dt>Backend</dt>
              <dd>{backendInput}</dd>
            </div>
          </dl>
          {displayError ? <p>{displayError}</p> : null}
        </div>
      </section>
    </main>
  )
}

export default function App() {
  const backendUrl = useMemo(
    () => normalizeBackendUrl(getBackendUrl()),
    [],
  )
  const explicitRoom = useMemo(() => roomSelectionFromUrl(), [])
  const [selectedRoom, setSelectedRoom] = useState(explicitRoom)
  const roomId = selectedRoom?.roomId || ''
  const selectionWsUrl = useMemo(
    () => selectionWsUrlForBackend(backendUrl),
    [backendUrl],
  )
  const selectionCurrentUrl = useMemo(
    () => selectionCurrentUrlForBackend(backendUrl),
    [backendUrl],
  )
  const urls = useMemo(
    () => (roomId ? {
      capture: captureUrlForRoom(backendUrl, roomId),
      clarifications: clarificationUrlForRoom(backendUrl, roomId),
      visualObservation: visualObservationUrlForRoom(backendUrl, roomId),
      websocket: websocketUrlForRoom(backendUrl, roomId),
    } : null),
    [backendUrl, roomId],
  )

  const editorRef = useRef(null)
  const socketRef = useRef(null)
  const reconnectTimerRef = useRef(null)
  const sendTimerRef = useRef(null)
  const cleanupStoreListenerRef = useRef(null)
  const mountedRef = useRef(false)
  const mountIdRef = useRef(0)
  const loadingCaptureRef = useRef(false)
  const pendingCaptureRef = useRef(false)
  const localHadUserContentRef = useRef(false)
  const userInteractedRef = useRef(false)
  const clientIdRef = useRef(createClientId())
  const previousSourceIdsRef = useRef(new Set())

  const [status, setStatus] = useState('idle')
  const [backendVersion, setBackendVersion] = useState('unknown')
  const [roomVersion, setRoomVersion] = useState(0)
  const [lastSyncedAt, setLastSyncedAt] = useState(null)
  const [projectionCount, setProjectionCount] = useState(0)
  const [semanticDraft, setSemanticDraft] = useState(null)
  const [visualObservation, setVisualObservation] = useState(null)
  const [selectedCandidateId, setSelectedCandidateId] = useState(null)
  const [semanticError, setSemanticError] = useState('')
  const [error, setError] = useState('')
  const [selectionStatus, setSelectionStatus] = useState(explicitRoom ? 'url room' : 'waiting')
  const [desktopSelection, setDesktopSelection] = useState(null)
  const tldrawComponents = useMemo(
    () => ({
      OnTheCanvas: () => (
        <>
          <PlatformReferenceLayer stageReference={selectedRoom?.stageReference} />
          <SemanticCandidateLayer semanticDraft={semanticDraft} selectedCandidateId={selectedCandidateId} />
        </>
      ),
    }),
    [semanticDraft, selectedCandidateId, selectedRoom?.stageReference],
  )

  const handleJoinRoom = useCallback((nextRoomId, nextBackendUrl) => {
    const params = new URLSearchParams(window.location.search)
    params.set('room', nextRoomId)
    params.set('backend', nextBackendUrl)
    window.location.assign(`/?${params.toString()}`)
  }, [])

  const handleSwitchToSelection = useCallback((selection) => {
    if (!selection?.roomId) return
    const params = new URLSearchParams(window.location.search)
    params.set('room', selection.roomId)
    params.set('backend', backendUrlInputValue(backendUrl))
    params.set('world', selection.worldId || selection.roomId)
    if (selection.worldName) params.set('worldName', selection.worldName)
    else params.delete('worldName')
    window.location.assign(`/?${params.toString()}`)
  }, [backendUrl])

  const mergeSelectedRoomContext = useCallback((room) => {
    if (!room?.roomId || room.roomId !== roomId) return
    setSelectedRoom((current) => {
      if (!current || current.roomId !== room.roomId) return current
      const nextStageReference = hasStageReference(room.stageReference)
        ? room.stageReference
        : current.stageReference
      const nextStageReferenceVersion = room.stageReferenceVersion ?? current.stageReferenceVersion ?? 0
      if (
        current.stageReference === nextStageReference
        && current.stageReferenceVersion === nextStageReferenceVersion
      ) {
        return current
      }
      return {
        ...current,
        stageReference: nextStageReference,
        stageReferenceVersion: nextStageReferenceVersion,
      }
    })
  }, [roomId])

  useEffect(() => {
    const candidates = semanticDraft?.candidates || []
    setSelectedCandidateId((current) => {
      const selected = candidates.find((candidate) => candidate.candidateId === current)
      if (selected?.status === 'needs_answer') return current
      const pending = candidates.find((candidate) => candidate.status === 'needs_answer')
      if (pending) return pending.candidateId
      return selected?.candidateId || candidates[0]?.candidateId || null
    })
  }, [semanticDraft])

  useEffect(() => {
    let cancelled = false
    let socket = null
    let reconnectTimer = 0
    let pollTimer = 0
    let inFlightPoll = null

    const applySelection = (selection, source) => {
      if (cancelled) return
      if (explicitRoom) {
        setSelectionStatus(source ? `url room · ${source}` : 'url room')
        setError('')
        if (selection.roomId && selection.roomId !== explicitRoom.roomId) {
          setDesktopSelection({
            roomId: selection.roomId,
            worldId: selection.worldId || selection.roomId,
            worldName: selection.worldName || null,
            stageReference: selection.stageReference || EMPTY_STAGE_REFERENCE,
            stageReferenceVersion: selection.stageReferenceVersion || 0,
          })
          setSelectedRoom(explicitRoom)
          return
        }
        setDesktopSelection(null)
        setSelectedRoom({
          ...explicitRoom,
          stageReference: selection.roomId === explicitRoom.roomId
            ? selection.stageReference || explicitRoom.stageReference
            : explicitRoom.stageReference,
          stageReferenceVersion: selection.roomId === explicitRoom.roomId
            ? selection.stageReferenceVersion || explicitRoom.stageReferenceVersion || 0
            : explicitRoom.stageReferenceVersion || 0,
        })
        return
      }
      if (selection.roomId) {
        setSelectionStatus(source || 'ready')
        setError('')
        setDesktopSelection(null)
        setSelectedRoom((current) => {
          if (current?.roomId && current.roomId !== selection.roomId) {
            window.location.reload()
            return current
          }
          if (
            current?.roomId === selection.roomId
            && current?.worldId === selection.worldId
            && current?.worldName === selection.worldName
            && JSON.stringify(current?.stageReference || null) === JSON.stringify(selection.stageReference || null)
          ) {
            return current
          }
          return {
            roomId: selection.roomId,
            worldId: selection.worldId || selection.roomId,
            worldName: selection.worldName || null,
            stageReference: selection.stageReference || EMPTY_STAGE_REFERENCE,
            stageReferenceVersion: selection.stageReferenceVersion || 0,
          }
        })
      } else {
        setSelectionStatus('waiting')
        setError('')
        setDesktopSelection(null)
        setSelectedRoom((current) => {
          if (current?.roomId) {
            window.location.reload()
            return current
          }
          return null
        })
      }
    }

    const pollSelection = async () => {
      if (cancelled) return
      inFlightPoll?.abort()
      inFlightPoll = new AbortController()
      try {
        const response = await fetch(selectionCurrentUrl, { signal: inFlightPoll.signal })
        if (!response.ok) throw new Error(`selection ${response.status}`)
        applySelection(await response.json(), 'polling')
      } catch (pollError) {
        if (!cancelled && pollError?.name !== 'AbortError') {
          setSelectionStatus('backend unreachable')
          setError(backendUnreachableMessage(backendUrlInputValue(backendUrl)))
        }
      } finally {
        if (!cancelled) pollTimer = window.setTimeout(pollSelection, 1600)
      }
    }

    const connectSelectionSocket = () => {
      if (cancelled) return
      window.clearTimeout(reconnectTimer)
      setSelectionStatus((current) => (current === 'waiting' ? current : 'connecting'))
      socket = new WebSocket(selectionWsUrl)
      let opened = false

      socket.addEventListener('open', () => {
        if (!cancelled) {
          opened = true
          setSelectionStatus('listening')
          setError('')
        }
      })

      socket.addEventListener('message', (event) => {
        let message
        try {
          message = JSON.parse(event.data)
        } catch (_error) {
          return
        }
        if (message.type === 'selection_hello' || message.type === 'selection_updated') {
          applySelection(message, message.type === 'selection_updated' ? 'updated' : 'listening')
        }
      })

      socket.addEventListener('close', () => {
        if (cancelled) return
        setSelectionStatus(opened ? 'reconnecting' : 'backend unreachable')
        if (!opened) setError(backendUnreachableMessage(backendUrlInputValue(backendUrl)))
        reconnectTimer = window.setTimeout(connectSelectionSocket, RECONNECT_DELAY_MS)
      })

      socket.addEventListener('error', () => {
        if (!cancelled) {
          setSelectionStatus('backend unreachable')
          setError(backendUnreachableMessage(backendUrlInputValue(backendUrl)))
        }
      })
    }

    pollSelection()
    connectSelectionSocket()
    return () => {
      cancelled = true
      window.clearTimeout(reconnectTimer)
      window.clearTimeout(pollTimer)
      inFlightPoll?.abort()
      socket?.close()
    }
  }, [backendUrl, explicitRoom, selectionCurrentUrl, selectionWsUrl])

  useEffect(() => {
    setStatus(roomId ? 'idle' : 'waiting')
    setBackendVersion('unknown')
    setRoomVersion(0)
    setLastSyncedAt(null)
    setProjectionCount(0)
    setSemanticDraft(null)
    setVisualObservation(null)
    setSelectedCandidateId(null)
    setSemanticError('')
    localHadUserContentRef.current = false
    userInteractedRef.current = false
    previousSourceIdsRef.current = new Set()
  }, [roomId])

  const sendCaptureNow = useCallback(() => {
    const editor = editorRef.current
    const socket = socketRef.current
    if (!editor) return

    const { document } = getSnapshot(editor.store)
    const projection = makeProjection(editor, document)
    const objectCount = projectionObjectCount(projection)
    const sourceIds = new Set([
      ...(projection.strokes || []).map((item) => item.sourceId),
      ...(projection.shapes || []).map((item) => item.sourceId),
      ...(projection.labels || []).map((item) => item.sourceId),
    ].filter(Boolean))
    const changedSourceIds = [...sourceIds].filter((sourceId) => !previousSourceIdsRef.current.has(sourceId))
    previousSourceIdsRef.current = sourceIds
    setProjectionCount(objectCount)

    if (objectCount > 0) localHadUserContentRef.current = true
    if (objectCount === 0 && !localHadUserContentRef.current) {
      pendingCaptureRef.current = false
      return
    }

    if (!socket || socket.readyState !== WebSocket.OPEN) return

    pendingCaptureRef.current = false
    socket.send(
      JSON.stringify({
        type: 'canvas_capture',
        capture: document,
        projection,
        changedSourceIds,
        worldId: selectedRoom?.worldId || roomId,
        clientId: clientIdRef.current,
        sentAt: new Date().toISOString(),
      }),
    )
  }, [roomId, selectedRoom?.worldId])

  const sendClarificationAnswer = useCallback(async (candidate, choiceId) => {
    if (!candidate || !choiceId || !urls) return
    const payload = {
      type: 'clarification_answer',
      questionId: candidate.questionId,
      candidateId: candidate.candidateId,
      choiceId,
      captureVersion: candidate.captureVersion,
      sourceIds: candidate.sourceIds,
      geometryHash: candidate.geometryHash,
      worldId: selectedRoom?.worldId || roomId,
      clientId: clientIdRef.current,
    }
    setSemanticError('')
    const socket = socketRef.current
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload))
      return
    }
    try {
      const response = await fetch(urls.clarifications, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.detail || `Clarification failed: ${response.status}`)
      }
      setSemanticDraft(await response.json())
    } catch (requestError) {
      setSemanticError(requestError.message || 'Clarification failed.')
    }
  }, [roomId, selectedRoom?.worldId, urls])

  const scheduleCaptureSend = useCallback(() => {
    if (loadingCaptureRef.current) return
    if (!userInteractedRef.current) return
    pendingCaptureRef.current = true
    window.clearTimeout(sendTimerRef.current)
    sendTimerRef.current = window.setTimeout(sendCaptureNow, SYNC_DEBOUNCE_MS)
  }, [sendCaptureNow])

  const connectWebSocket = useCallback((mountId) => {
    window.clearTimeout(reconnectTimerRef.current)
    if (!mountedRef.current || mountIdRef.current !== mountId || !urls) return

    setStatus('connecting')
    const socket = new WebSocket(urls.websocket)
    let opened = false
    socketRef.current = socket

    socket.addEventListener('open', () => {
      if (socketRef.current !== socket || mountIdRef.current !== mountId) return
      opened = true
      setStatus('connected')
      setError('')
      if (pendingCaptureRef.current) sendCaptureNow()
    })

    socket.addEventListener('message', (event) => {
      if (socketRef.current !== socket || mountIdRef.current !== mountId) return
      let message
      try {
        message = JSON.parse(event.data)
      } catch (_error) {
        return
      }

      if (message.type === 'hello') {
        setStatus('connected')
        setBackendVersion(message.backendVersion || 'unknown')
        setRoomVersion(message.version ?? 0)
        setSemanticDraft(message.semanticDraft || null)
        setVisualObservation(message.visualObservation || null)
        mergeSelectedRoomContext(message)
      } else if (message.type === 'projection_updated') {
        setStatus('connected')
        setRoomVersion(message.version ?? 0)
        setLastSyncedAt(message.updatedAt || new Date().toISOString())
        setSemanticDraft(message.semanticDraft || null)
        setVisualObservation(message.visualObservation || null)
        mergeSelectedRoomContext(message)
      } else if (message.type === 'semantic_draft_updated') {
        setStatus('connected')
        setRoomVersion(message.version ?? 0)
        setSemanticDraft(message.semanticDraft || null)
      } else if (message.type === 'visual_observation_updated') {
        setStatus('connected')
        setRoomVersion(message.version ?? 0)
        setVisualObservation(message.visualObservation || null)
        if (message.semanticDraft) setSemanticDraft(message.semanticDraft)
      } else if (message.type === 'error') {
        setError(message.message || 'Backend rejected a message.')
        setSemanticError(message.message || 'Backend rejected a message.')
      }
    })

    socket.addEventListener('close', () => {
      if (socketRef.current !== socket || mountIdRef.current !== mountId) return
      socketRef.current = null
      if (!mountedRef.current || mountIdRef.current !== mountId) return
      setStatus(opened ? 'disconnected' : 'error')
      if (!opened) setError(backendUnreachableMessage(backendUrlInputValue(backendUrl)))
      reconnectTimerRef.current = window.setTimeout(() => connectWebSocket(mountId), RECONNECT_DELAY_MS)
    })

    socket.addEventListener('error', () => {
      if (socketRef.current !== socket || mountIdRef.current !== mountId) return
      setStatus('error')
      setError(backendUnreachableMessage(backendUrlInputValue(backendUrl)))
    })
  }, [backendUrl, mergeSelectedRoomContext, sendCaptureNow, urls])

  const handleMount = useCallback(
    (editor) => {
      if (!urls) return undefined
      const mountId = mountIdRef.current + 1
      mountIdRef.current = mountId
      mountedRef.current = true
      editorRef.current = editor
      setStatus('loading')

      const loadInitialCapture = async () => {
        loadingCaptureRef.current = true
        try {
          const response = await fetch(urls.capture)
          if (!mountedRef.current || mountIdRef.current !== mountId) return
          if (!response.ok) throw new Error(`Capture request failed: ${response.status}`)
          const room = await response.json()
          if (!mountedRef.current || mountIdRef.current !== mountId) return
          setRoomVersion(room.version ?? 0)
          setSemanticDraft(room.semanticDraft || null)
          setVisualObservation(room.visualObservation || null)
          mergeSelectedRoomContext(room)
          localHadUserContentRef.current = projectionObjectCount(room.projection) > 0

          if (room.capture) {
            loadSnapshot(editor.store, { document: room.capture })
          }
          ensureStageFrame(editor)
        } catch (requestError) {
          ensureStageFrame(editor)
          setError(
            requestError instanceof TypeError
              ? backendUnreachableMessage(backendUrlInputValue(backendUrl))
              : requestError.message || 'Could not load backend capture.',
          )
        } finally {
          if (!mountedRef.current || mountIdRef.current !== mountId) return
          loadingCaptureRef.current = false
          connectWebSocket(mountId)
        }
      }

      loadInitialCapture()

      cleanupStoreListenerRef.current = editor.store.listen(
        () => {
          scheduleCaptureSend()
        },
        { source: 'user', scope: 'document' },
      )

      return () => {
        mountedRef.current = false
        mountIdRef.current += 1
        window.clearTimeout(sendTimerRef.current)
        window.clearTimeout(reconnectTimerRef.current)
        pendingCaptureRef.current = false
        cleanupStoreListenerRef.current?.()
        cleanupStoreListenerRef.current = null
        socketRef.current?.close()
        socketRef.current = null
        editorRef.current = null
      }
    },
    [backendUrl, connectWebSocket, mergeSelectedRoomContext, scheduleCaptureSend, urls],
  )

  if (!roomId) {
    return (
      <JoinRoomScreen
        backendUrl={backendUrl}
        selectionStatus={selectionStatus}
        error={error}
        onJoin={handleJoinRoom}
      />
    )
  }

  return (
    <main
      className="draw-app"
      onPointerDownCapture={() => { userInteractedRef.current = true }}
      onKeyDownCapture={() => { userInteractedRef.current = true }}
    >
      <Tldraw key={roomId} onMount={handleMount} components={tldrawComponents} />
      <aside className="editor-chrome" aria-label="Magic Board editor tools">
        <div className="editor-chrome-scroll">
          <DesktopSelectionPanel
            selection={desktopSelection}
            currentRoomId={roomId}
            onSwitch={handleSwitchToSelection}
          />
          <SemanticPanel
            semanticDraft={semanticDraft}
            selectedCandidateId={selectedCandidateId}
            onSelectCandidate={setSelectedCandidateId}
            onAnswer={sendClarificationAnswer}
            error={semanticError}
            visualObservation={visualObservation}
          />
          <details className="details-drawer">
            <summary>Details</summary>
            <VisualObservationPanel observation={visualObservation} />
            <section className="debug-panel" aria-label="Sync status">
              <div className={`status-dot status-${syncStatusClassName(status)}`} />
              <dl>
                <div>
                  <dt>Status</dt>
                  <dd>{syncStatusLabel(status)}</dd>
                </div>
                <div>
                  <dt>Room</dt>
                  <dd>{roomId}</dd>
                </div>
                <div>
                  <dt>Endpoint</dt>
                  <dd>{backendUrlInputValue(backendUrl)}</dd>
                </div>
                <div>
                  <dt>World</dt>
                  <dd>{selectedRoom?.worldName || selectedRoom?.worldId || 'selected'}</dd>
                </div>
                <div>
                  <dt>Reference</dt>
                  <dd>{`${selectedRoom?.stageReference?.platforms?.length || 0} platforms · ${selectedRoom?.stageReference?.portals?.length || 0} portals`}</dd>
                </div>
                <div>
                  <dt>Backend</dt>
                  <dd>{backendVersion}</dd>
                </div>
                <div>
                  <dt>Version</dt>
                  <dd>{roomVersion}</dd>
                </div>
                <div>
                  <dt>Objects</dt>
                  <dd>{projectionCount}</dd>
                </div>
                <div>
                  <dt>Draft</dt>
                  <dd>{semanticCandidateCount(semanticDraft)}</dd>
                </div>
                <div>
                  <dt>Vision</dt>
                  <dd>{visualObservationLabel(visualObservation)}</dd>
                </div>
                <div>
                  <dt>Synced</dt>
                  <dd>{formatTime(lastSyncedAt)}</dd>
                </div>
              </dl>
              {error ? <p>{error}</p> : null}
            </section>
          </details>
        </div>
      </aside>
    </main>
  )
}
