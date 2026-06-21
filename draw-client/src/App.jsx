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
import '../../js/stageReferenceData.js'

const DEFAULT_BACKEND_PORT = '8000'
const SYNC_DEBOUNCE_MS = 120
const RECONNECT_DELAY_MS = 1000
const GAME_FRAME = { x: 0, y: 0, w: 1920, h: 1080 }
const FRAME_SHAPE_ID = createShapeId('magicboard-stage-frame')
const STAGE_REFERENCE = globalThis.DS?.stageReference || { view: { w: GAME_FRAME.w, h: GAME_FRAME.h }, platforms: [] }

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

function getBackendUrl() {
  const params = new URLSearchParams(window.location.search)
  const configuredUrl = params.get('backend') || import.meta.env.VITE_BACKEND_URL
  if (configuredUrl) return configuredUrl

  const url = new URL(window.location.href)
  url.port = DEFAULT_BACKEND_PORT
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function normalizeBackendUrl(rawUrl) {
  try {
    return new URL(rawUrl)
  } catch (_error) {
    return new URL(`http://localhost:${DEFAULT_BACKEND_PORT}`)
  }
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

function selectionWsUrlForBackend(backendUrl) {
  const url = new URL(backendUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws/selection'
  url.search = ''
  url.hash = ''
  return url.toString()
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

function PlatformReferenceLayer() {
  const view = STAGE_REFERENCE.view || { w: GAME_FRAME.w, h: GAME_FRAME.h }
  const platforms = STAGE_REFERENCE.platforms || []

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
      </svg>
    </div>
  )
}

export default function App() {
  const backendUrl = useMemo(
    () => normalizeBackendUrl(getBackendUrl()),
    [],
  )
  const [selectedRoom, setSelectedRoom] = useState(null)
  const roomId = selectedRoom?.roomId || ''
  const selectionWsUrl = useMemo(
    () => selectionWsUrlForBackend(backendUrl),
    [backendUrl],
  )
  const urls = useMemo(
    () => (roomId ? {
      capture: captureUrlForRoom(backendUrl, roomId),
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

  const [status, setStatus] = useState('idle')
  const [backendVersion, setBackendVersion] = useState('unknown')
  const [roomVersion, setRoomVersion] = useState(0)
  const [lastSyncedAt, setLastSyncedAt] = useState(null)
  const [projectionCount, setProjectionCount] = useState(0)
  const [error, setError] = useState('')
  const [selectionStatus, setSelectionStatus] = useState('waiting')
  const tldrawComponents = useMemo(
    () => ({
      OnTheCanvas: PlatformReferenceLayer,
    }),
    [],
  )

  useEffect(() => {
    let cancelled = false
    let socket = null
    let reconnectTimer = 0

    const applySelection = (selection, source) => {
      if (cancelled) return
      if (selection.roomId) {
        setSelectionStatus(source || 'ready')
        setError('')
        setSelectedRoom((current) => {
          if (current?.roomId && current.roomId !== selection.roomId) {
            window.location.reload()
            return current
          }
          if (
            current?.roomId === selection.roomId
            && current?.worldId === selection.worldId
            && current?.worldName === selection.worldName
          ) {
            return current
          }
          return {
            roomId: selection.roomId,
            worldId: selection.worldId || selection.roomId,
            worldName: selection.worldName || null,
          }
        })
      } else {
        setSelectionStatus('waiting')
        setSelectedRoom((current) => {
          if (current?.roomId) {
            window.location.reload()
            return current
          }
          return null
        })
      }
    }

    const connectSelectionSocket = () => {
      if (cancelled) return
      window.clearTimeout(reconnectTimer)
      setSelectionStatus((current) => (current === 'waiting' ? current : 'connecting'))
      socket = new WebSocket(selectionWsUrl)

      socket.addEventListener('open', () => {
        if (!cancelled) setSelectionStatus('listening')
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
        setSelectionStatus('reconnecting')
        reconnectTimer = window.setTimeout(connectSelectionSocket, RECONNECT_DELAY_MS)
      })

      socket.addEventListener('error', () => {
        if (!cancelled) setSelectionStatus('selection socket error')
      })
    }

    connectSelectionSocket()
    return () => {
      cancelled = true
      window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [selectionWsUrl])

  useEffect(() => {
    setStatus(roomId ? 'idle' : 'waiting')
    setBackendVersion('unknown')
    setRoomVersion(0)
    setLastSyncedAt(null)
    setProjectionCount(0)
    localHadUserContentRef.current = false
    userInteractedRef.current = false
  }, [roomId])

  const sendCaptureNow = useCallback(() => {
    const editor = editorRef.current
    const socket = socketRef.current
    if (!editor) return

    const { document } = getSnapshot(editor.store)
    const projection = makeProjection(editor, document)
    const objectCount = projectionObjectCount(projection)
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
        clientId: clientIdRef.current,
        sentAt: new Date().toISOString(),
      }),
    )
  }, [])

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
    socketRef.current = socket

    socket.addEventListener('open', () => {
      if (socketRef.current !== socket || mountIdRef.current !== mountId) return
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
      } else if (message.type === 'projection_updated') {
        setStatus('connected')
        setRoomVersion(message.version ?? 0)
        setLastSyncedAt(message.updatedAt || new Date().toISOString())
      } else if (message.type === 'error') {
        setError(message.message || 'Backend rejected a message.')
      }
    })

    socket.addEventListener('close', () => {
      if (socketRef.current !== socket || mountIdRef.current !== mountId) return
      socketRef.current = null
      if (!mountedRef.current || mountIdRef.current !== mountId) return
      setStatus('disconnected')
      reconnectTimerRef.current = window.setTimeout(() => connectWebSocket(mountId), RECONNECT_DELAY_MS)
    })

    socket.addEventListener('error', () => {
      if (socketRef.current !== socket || mountIdRef.current !== mountId) return
      setStatus('error')
    })
  }, [sendCaptureNow, urls])

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
          localHadUserContentRef.current = projectionObjectCount(room.projection) > 0

          if (room.capture) {
            loadSnapshot(editor.store, { document: room.capture })
          }
          ensureStageFrame(editor)
        } catch (requestError) {
          ensureStageFrame(editor)
          setError(requestError.message || 'Could not load backend capture.')
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
    [connectWebSocket, scheduleCaptureSend, urls],
  )

  if (!roomId) {
    return (
      <main className="draw-app draw-app-waiting">
        <section className="selection-wait-panel" aria-label="Desktop room selection">
          <h1>Waiting for desktop selection</h1>
          <p>Open a level on the desktop with Edit Level.</p>
          <dl>
            <div>
              <dt>Status</dt>
              <dd>{selectionStatus}</dd>
            </div>
            <div>
              <dt>Backend</dt>
              <dd>{backendUrl.toString()}</dd>
            </div>
          </dl>
          {error ? <p className="selection-error">{error}</p> : null}
        </section>
      </main>
    )
  }

  return (
    <main
      className="draw-app"
      onPointerDownCapture={() => { userInteractedRef.current = true }}
      onKeyDownCapture={() => { userInteractedRef.current = true }}
    >
      <Tldraw key={roomId} onMount={handleMount} components={tldrawComponents} />
      <section className="debug-panel" aria-label="Sync status">
        <div className={`status-dot status-${status}`} />
        <dl>
          <div>
            <dt>Status</dt>
            <dd>{status}</dd>
          </div>
          <div>
            <dt>Room</dt>
            <dd>{roomId}</dd>
          </div>
          <div>
            <dt>World</dt>
            <dd>{selectedRoom?.worldName || selectedRoom?.worldId || 'selected'}</dd>
          </div>
          <div>
            <dt>Reference</dt>
            <dd>{`${STAGE_REFERENCE.platforms?.length || 0} platforms`}</dd>
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
            <dt>Synced</dt>
            <dd>{formatTime(lastSyncedAt)}</dd>
          </div>
        </dl>
        {error ? <p>{error}</p> : null}
      </section>
    </main>
  )
}
