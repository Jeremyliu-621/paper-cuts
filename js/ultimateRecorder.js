// Lobby custom ultimate recorder: webcam pose -> doodle skeleton -> doodle-only clip.
(function (global) {
  'use strict';
  const DS = global.DS;
  const D = DS.draw;

  const POSE_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs';
  const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm';
  const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';
  const REC_MS = 2200;
  const STATUS = {
    camera: 'camera needed',
    tracking: 'tracking',
    align: 'align skeleton',
    countdown: 'recording countdown',
    locked: 'skeleton locked',
    recording: 'recording',
    generating: 'generating',
    ready: 'custom ultimate ready',
    unavailable: 'camera unavailable',
    failed: 'failed',
    fallback: 'using default',
  };
  const IDX = {
    nose: 0, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24,
  };
  const REQUIRED_LANDMARKS = [IDX.nose, IDX.lSh, IDX.rSh, IDX.lEl, IDX.rEl, IDX.lWr, IDX.rWr, IDX.lHip, IDX.rHip];
  const SKELETON_EDGES = [
    [IDX.lSh, IDX.rSh], [IDX.lSh, IDX.lHip], [IDX.rSh, IDX.rHip], [IDX.lHip, IDX.rHip],
    [IDX.lSh, IDX.lEl], [IDX.lEl, IDX.lWr], [IDX.rSh, IDX.rEl], [IDX.rEl, IDX.rWr],
  ];
  const GUIDE = { cx: 0.5, shY: 0.3, hipY: 0.58, shoulder: 0.28, hip: 0.2, armDrop: 0.18 };
  const ALIGN_COUNTDOWN_MS = 2600;

  let video = null;
  let stream = null;
  let previewCanvas = null;
  let recordCanvas = null;
  let overlay = null;
  let statusEl = null;
  let actionEl = null;
  let landmarker = null;
  let loadingPose = null;
  let poseWorker = null;
  let workerReady = false;
  let workerBusy = false;
  let workerFailed = false;
  let raf = 0;
  let activePlayer = 0;
  let lastVideoTime = -1;
  let smooth = null;
  let prevWrists = null;
  let currentPose = null;
  let currentLandmarks = null;
  let trackingQuality = null;
  let alignCountdownMs = 0;
  let lastAlignAt = 0;
  let pendingRecord = null;
  let impactT = 0;
  let recording = null;
  const states = [];
  const contexts = {};
  let onChange = null;

  function setState(playerIndex, state, error) {
    const nextError = error || null;
    const prev = states[playerIndex];
    if (prev && prev.state === state && prev.error === nextError) {
      if (statusEl && playerIndex === activePlayer) statusEl.textContent = nextError ? state + ' - ' + nextError : state;
      return;
    }
    states[playerIndex] = { state, error: nextError, updatedAt: new Date().toISOString() };
    if (statusEl && playerIndex === activePlayer) statusEl.textContent = nextError ? state + ' - ' + nextError : state;
    if (onChange) onChange(playerIndex, states[playerIndex]);
  }

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'ultimate-recorder-overlay';
    overlay.hidden = true;
    overlay.innerHTML = [
      '<div class="ultimate-recorder-panel">',
      '  <div class="ultimate-recorder-head">',
      '    <div class="ultimate-recorder-title">Record Ultimate</div>',
      '    <button class="ultimate-recorder-close" type="button" aria-label="Close">x</button>',
      '  </div>',
      '  <canvas class="ultimate-recorder-preview"></canvas>',
      '  <div class="ultimate-recorder-actions">',
      '    <button class="ultimate-recorder-record" type="button">Record</button>',
      '    <div class="ultimate-recorder-status">camera needed</div>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(overlay);
    previewCanvas = overlay.querySelector('.ultimate-recorder-preview');
    recordCanvas = document.createElement('canvas');
    recordCanvas.width = 512; recordCanvas.height = 512;
    statusEl = overlay.querySelector('.ultimate-recorder-status');
    actionEl = overlay.querySelector('.ultimate-recorder-record');
    overlay.querySelector('.ultimate-recorder-close').onclick = hideOverlay;
    actionEl.onclick = () => startRecording(activePlayer);
  }

  function hideOverlay() {
    if (pendingRecord) {
      pendingRecord.reject(new Error('recording cancelled'));
      pendingRecord = null;
    }
    alignCountdownMs = 0;
    lastAlignAt = 0;
    if (overlay) overlay.hidden = true;
  }

  function suppressOpaqueScriptErrors(ms) {
    global.__dsSuppressOpaqueScriptErrorsUntil = Date.now() + (ms || 2500);
  }

  async function loadPoseLandmarker() {
    if (landmarker || loadingPose) return loadingPose || landmarker;
    suppressOpaqueScriptErrors(5000);
    loadingPose = import(POSE_CDN).then(async (vision) => {
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_CDN);
      landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
      return landmarker;
    }).catch((error) => {
      console.warn('Pose Landmarker unavailable; recorder will use idle preview.', error);
      return null;
    });
    return loadingPose;
  }

  function startPoseWorker() {
    if (poseWorker || workerFailed || !global.Worker || !global.Blob || !global.URL) return !!poseWorker;
    const source = `
      let landmarker = null;
      const POSE_CDN = ${JSON.stringify(POSE_CDN)};
      const WASM_CDN = ${JSON.stringify(WASM_CDN)};
      const MODEL_URL = ${JSON.stringify(MODEL_URL)};
      self.addEventListener('error', (event) => {
        self.postMessage({ type: 'error', message: event && event.message ? event.message : 'pose worker script failed' });
        if (event.preventDefault) event.preventDefault();
      });
      self.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        self.postMessage({ type: 'error', message: reason && reason.message ? reason.message : String(reason || 'pose worker promise failed') });
        if (event.preventDefault) event.preventDefault();
      });
      self.onmessage = async (event) => {
        const data = event.data || {};
        if (data.type === 'init') {
          try {
            const vision = await import(POSE_CDN);
            const fileset = await vision.FilesetResolver.forVisionTasks(WASM_CDN);
            landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
              runningMode: 'VIDEO',
              numPoses: 1,
            });
            self.postMessage({ type: 'ready' });
          } catch (error) {
            self.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
          }
          return;
        }
        if (data.type === 'frame') {
          const bitmap = data.bitmap;
          try {
            if (!landmarker || !bitmap) return;
            const result = landmarker.detectForVideo(bitmap, data.timestamp || performance.now());
            const points = result && result.landmarks && result.landmarks[0]
              ? result.landmarks[0].map((p) => ({ x: p.x, y: p.y, z: p.z || 0, visibility: p.visibility == null ? 1 : p.visibility, presence: p.presence == null ? 1 : p.presence }))
              : null;
            if (bitmap.close) bitmap.close();
            self.postMessage({ type: 'landmarks', landmarks: points });
          } catch (error) {
            if (bitmap && bitmap.close) bitmap.close();
            self.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
          }
        }
      };
    `;
    try {
      const blob = new Blob([source], { type: 'text/javascript' });
      suppressOpaqueScriptErrors(5000);
      poseWorker = new Worker(URL.createObjectURL(blob), { type: 'module' });
      poseWorker.onmessage = (event) => {
        const data = event.data || {};
        if (data.type === 'ready') { workerReady = true; return; }
        if (data.type === 'landmarks') {
          workerBusy = false;
          currentLandmarks = data.landmarks && data.landmarks.length ? smoothLandmarks(data.landmarks) : null;
          return;
        }
        if (data.type === 'error') failWorker(data.message);
      };
      poseWorker.onerror = (event) => {
        if (event && event.preventDefault) event.preventDefault();
        failWorker((event && event.message) || 'pose worker failed');
        return true;
      };
      poseWorker.postMessage({ type: 'init' });
      return true;
    } catch (error) {
      failWorker(error && error.message ? error.message : error);
      return false;
    }
  }

  function failWorker(message) {
    workerFailed = true;
    workerReady = false;
    workerBusy = false;
    if (poseWorker) {
      try { poseWorker.terminate(); } catch (_error) {}
      poseWorker = null;
    }
    console.warn('Pose worker unavailable; falling back to main-thread pose tracking.', message);
    loadPoseLandmarker();
  }

  function configurePlayer(playerIndex, context) {
    contexts[playerIndex] = Object.assign({}, contexts[playerIndex] || {}, context || {});
  }

  function requestCameraStream(constraints) {
    const nav = global.navigator || {};
    if (nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function') {
      return nav.mediaDevices.getUserMedia(constraints);
    }
    const legacy = nav.getUserMedia || nav.webkitGetUserMedia || nav.mozGetUserMedia || nav.msGetUserMedia;
    if (typeof legacy === 'function') {
      return new Promise((resolve, reject) => legacy.call(nav, constraints, resolve, reject));
    }
    return Promise.resolve(null);
  }

  async function startCamera(playerIndex) {
    ensureOverlay();
    activePlayer = playerIndex || 0;
    overlay.hidden = false;
    setState(activePlayer, STATUS.camera);
    if (!video) {
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
    }
    try {
      if (!stream) {
        stream = await requestCameraStream({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
        if (!stream) {
          setState(activePlayer, STATUS.unavailable, global.isSecureContext === false ? 'use localhost or https' : 'browser blocked camera API');
          updateActionButton();
          startLoop();
          return false;
        }
        video.srcObject = stream;
      }
      await video.play();
      alignCountdownMs = 0;
      lastAlignAt = 0;
      trackingQuality = null;
      currentLandmarks = null;
      smooth = null;
      setState(activePlayer, STATUS.tracking);
      if (!startPoseWorker()) loadPoseLandmarker();
      startLoop();
      return true;
    } catch (error) {
      const name = error && error.name ? error.name : '';
      const message = name === 'NotAllowedError' || name === 'PermissionDeniedError'
        ? 'permission denied'
        : (error && error.message ? error.message : 'camera unavailable');
      setState(activePlayer, STATUS.unavailable, message);
      updateActionButton();
      startLoop();
      return false;
    }
  }

  function startLoop() {
    if (raf) return;
    const tick = () => {
      raf = global.requestAnimationFrame(tick);
      updatePose();
      render();
    };
    tick();
  }

  function updatePose() {
    if (!video || video.readyState < 2) return;
    if (poseWorker && workerReady && !workerBusy && !workerFailed && global.createImageBitmap && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      workerBusy = true;
      createImageBitmap(video).then((bitmap) => {
        if (!poseWorker || workerFailed) { if (bitmap.close) bitmap.close(); return; }
        poseWorker.postMessage({ type: 'frame', bitmap, timestamp: performance.now() }, [bitmap]);
      }).catch(() => {
        workerBusy = false;
        failWorker('createImageBitmap failed');
      });
    } else if (!poseWorker && landmarker && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      try {
        const result = landmarker.detectForVideo(video, performance.now());
        const lm = result && result.landmarks && result.landmarks[0];
        currentLandmarks = lm && lm.length ? smoothLandmarks(lm) : null;
      } catch (_error) {
        // Keep the latest pose; camera preview should not crash the lobby.
      }
    }
    trackingQuality = assessTracking(currentLandmarks);
    updateAlignmentGate();
    currentPose = poseFromLandmarks(currentLandmarks, contexts[activePlayer] || {});
  }

  function smoothLandmarks(lm) {
    const alpha = 0.36;
    if (!smooth) smooth = lm.map((p) => ({ x: p.x, y: p.y, z: p.z || 0, visibility: p.visibility == null ? 1 : p.visibility, presence: p.presence == null ? 1 : p.presence }));
    for (let i = 0; i < lm.length; i++) {
      smooth[i].x += (lm[i].x - smooth[i].x) * alpha;
      smooth[i].y += (lm[i].y - smooth[i].y) * alpha;
      smooth[i].z += ((lm[i].z || 0) - smooth[i].z) * alpha;
      smooth[i].visibility = lm[i].visibility == null ? 1 : lm[i].visibility;
      smooth[i].presence = lm[i].presence == null ? 1 : lm[i].presence;
    }
    return smooth;
  }

  function mirrored(p) {
    return p ? { x: 1 - p.x, y: p.y, z: p.z || 0 } : null;
  }

  function angle(a, b, facing) {
    if (!a || !b) return 0;
    return Math.atan2((b.x - a.x) * facing, b.y - a.y) * 180 / Math.PI;
  }

  function normDeg(v) {
    while (v > 180) v -= 360;
    while (v < -180) v += 360;
    return Math.max(-160, Math.min(160, v));
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function landmarkVisible(p) {
    if (!p) return false;
    const visibility = p.visibility == null ? 1 : p.visibility;
    const presence = p.presence == null ? 1 : p.presence;
    return visibility >= 0.58 && presence >= 0.58 && p.x > 0.03 && p.x < 0.97 && p.y > 0.03 && p.y < 0.98;
  }

  function guidePoints() {
    const cx = GUIDE.cx, shY = GUIDE.shY, hipY = GUIDE.hipY;
    return {
      nose: { x: cx, y: shY - 0.18 },
      lSh: { x: cx - GUIDE.shoulder / 2, y: shY },
      rSh: { x: cx + GUIDE.shoulder / 2, y: shY },
      lHip: { x: cx - GUIDE.hip / 2, y: hipY },
      rHip: { x: cx + GUIDE.hip / 2, y: hipY },
      lEl: { x: cx - GUIDE.shoulder / 2 - 0.08, y: shY + GUIDE.armDrop },
      rEl: { x: cx + GUIDE.shoulder / 2 + 0.08, y: shY + GUIDE.armDrop },
      lWr: { x: cx - GUIDE.shoulder / 2 - 0.04, y: shY + GUIDE.armDrop * 1.95 },
      rWr: { x: cx + GUIDE.shoulder / 2 + 0.04, y: shY + GUIDE.armDrop * 1.95 },
    };
  }

  function assessTracking(lm) {
    const out = { ok: false, ready: false, score: 0, reason: 'step into the skeleton' };
    if (!lm || !lm.length) { alignCountdownMs = 0; return out; }
    let visible = 0;
    for (const idx of REQUIRED_LANDMARKS) if (landmarkVisible(lm[idx])) visible++;
    out.score = visible / REQUIRED_LANDMARKS.length;
    if (visible < REQUIRED_LANDMARKS.length) {
      out.reason = 'show head, shoulders, elbows, wrists, hips';
      alignCountdownMs = 0;
      return out;
    }
    const lSh = mirrored(lm[IDX.lSh]), rSh = mirrored(lm[IDX.rSh]);
    const lHip = mirrored(lm[IDX.lHip]), rHip = mirrored(lm[IDX.rHip]);
    const nose = mirrored(lm[IDX.nose]);
    const shMid = { x: (lSh.x + rSh.x) / 2, y: (lSh.y + rSh.y) / 2 };
    const hipMid = { x: (lHip.x + rHip.x) / 2, y: (lHip.y + rHip.y) / 2 };
    const bodyCx = (shMid.x + hipMid.x) / 2;
    const bodyCy = (shMid.y + hipMid.y) / 2;
    const shoulderSpan = Math.abs(rSh.x - lSh.x);
    const targetBodyY = (GUIDE.shY + GUIDE.hipY) / 2;
    const centerError = Math.hypot(bodyCx - GUIDE.cx, (bodyCy - targetBodyY) * 1.2);
    const sizeError = Math.abs(shoulderSpan - GUIDE.shoulder);
    if (centerError > 0.09) {
      out.reason = bodyCx < GUIDE.cx ? 'move right into the skeleton' : 'move left into the skeleton';
      alignCountdownMs = 0;
      return out;
    }
    if (sizeError > 0.1) {
      out.reason = shoulderSpan < GUIDE.shoulder ? 'move closer' : 'step back';
      alignCountdownMs = 0;
      return out;
    }
    if (nose && Math.abs(nose.x - GUIDE.cx) > 0.12) {
      out.reason = 'center your head';
      alignCountdownMs = 0;
      return out;
    }
    out.ok = true;
    out.reason = 'hold alignment';
    return out;
  }

  function updateActionButton() {
    if (!actionEl) return;
    const ready = trackingQuality && trackingQuality.ready;
    actionEl.disabled = !!recording || !!pendingRecord || !ready;
    actionEl.textContent = recording ? 'Recording...' : pendingRecord ? 'Countdown...' : ready ? 'Record' : 'Align skeleton';
  }

  function updateAlignmentGate() {
    if (!trackingQuality || recording) { updateActionButton(); return; }
    const now = performance.now();
    const dtMs = lastAlignAt ? Math.min(120, now - lastAlignAt) : 0;
    lastAlignAt = now;
    if (trackingQuality.ok) alignCountdownMs = Math.min(ALIGN_COUNTDOWN_MS, alignCountdownMs + dtMs);
    else { alignCountdownMs = 0; lastAlignAt = 0; }
    trackingQuality.countdownLeftMs = Math.max(0, ALIGN_COUNTDOWN_MS - alignCountdownMs);
    trackingQuality.ready = trackingQuality.ok && alignCountdownMs >= ALIGN_COUNTDOWN_MS;
    if (pendingRecord && trackingQuality.ready) {
      beginRecording();
    } else if (pendingRecord) {
      const seconds = Math.ceil(trackingQuality.countdownLeftMs / 1000);
      setState(activePlayer, trackingQuality.ok ? STATUS.countdown : STATUS.align, trackingQuality.ok ? String(seconds) : trackingQuality.reason);
    } else {
      const state = trackingQuality.ready ? STATUS.locked : trackingQuality.ok ? STATUS.countdown : STATUS.align;
      const detail = trackingQuality.ready ? null : trackingQuality.ok ? String(Math.ceil(trackingQuality.countdownLeftMs / 1000)) : trackingQuality.reason;
      setState(activePlayer, state, detail);
    }
    updateActionButton();
  }

  function poseFromLandmarks(lm, context) {
    const base = (context.character && context.character.actions && context.character.actions.idle && context.character.actions.idle.pose)
      || (DS.Store.data.roster[0] && DS.Store.data.characters[DS.Store.data.roster[0]].actions.idle.pose)
      || DS.data.BASE_POSE;
    const pose = clonePose(base);
    if (!lm) return pose;
    const facing = context.facing || 1;
    const lSh = mirrored(lm[IDX.lSh]), rSh = mirrored(lm[IDX.rSh]);
    const lEl = mirrored(lm[IDX.lEl]), rEl = mirrored(lm[IDX.rEl]);
    const lWr = mirrored(lm[IDX.lWr]), rWr = mirrored(lm[IDX.rWr]);
    const lHip = mirrored(lm[IDX.lHip]), rHip = mirrored(lm[IDX.rHip]);
    const nose = mirrored(lm[IDX.nose]);
    const front = facing > 0 ? { sh: rSh, el: rEl, wr: rWr } : { sh: lSh, el: lEl, wr: lWr };
    const back = facing > 0 ? { sh: lSh, el: lEl, wr: lWr } : { sh: rSh, el: rEl, wr: rWr };
    const fSh = angle(front.sh, front.el, facing);
    const bSh = angle(back.sh, back.el, facing);
    pose.armFront.sh = clamp(fSh, -150, 180);
    pose.armFront.el = normDeg(angle(front.el, front.wr, facing) - fSh);
    pose.armBack.sh = clamp(bSh, -150, 180);
    pose.armBack.el = normDeg(angle(back.el, back.wr, facing) - bSh);
    if (lSh && rSh && lHip && rHip) {
      const shMid = { x: (lSh.x + rSh.x) / 2, y: (lSh.y + rSh.y) / 2 };
      const hipMid = { x: (lHip.x + rHip.x) / 2, y: (lHip.y + rHip.y) / 2 };
      pose.lean = clamp((hipMid.x - shMid.x) * 130 * facing, -24, 24);
      if (nose) {
        pose.headX = clamp((nose.x - shMid.x) * 85 * facing, -9, 9);
        pose.headY = clamp((nose.y - shMid.y + 0.18) * 44, -9, 8);
      }
    }
    const speed = wristSpeed(lWr, rWr);
    if (speed > 0.85) impactT = 0.18;
    if (impactT > 0) {
      pose.squash = 0.88;
      impactT -= 1 / 60;
    }
    return pose;
  }

  function wristSpeed(lWr, rWr) {
    const now = performance.now();
    if (!lWr || !rWr) return 0;
    const wrists = [{ x: lWr.x, y: lWr.y }, { x: rWr.x, y: rWr.y }];
    if (!prevWrists) {
      prevWrists = { t: now, wrists, max: 0, impactAtMs: null };
      return 0;
    }
    const dt = Math.max(16, now - prevWrists.t) / 1000;
    const sp = Math.max(
      Math.hypot(wrists[0].x - prevWrists.wrists[0].x, wrists[0].y - prevWrists.wrists[0].y) / dt,
      Math.hypot(wrists[1].x - prevWrists.wrists[1].x, wrists[1].y - prevWrists.wrists[1].y) / dt,
    );
    prevWrists.t = now; prevWrists.wrists = wrists;
    if (sp > prevWrists.max) { prevWrists.max = sp; prevWrists.impactAtMs = recording ? performance.now() - recording.startedAt : null; }
    return sp;
  }

  function clonePose(p) {
    return {
      lean: p.lean || 0, headX: p.headX || 0, headY: p.headY || 0, squash: p.squash || 1,
      armFront: Object.assign({}, p.armFront), armBack: Object.assign({}, p.armBack),
      legFront: Object.assign({}, p.legFront), legBack: Object.assign({}, p.legBack),
    };
  }

  function render() {
    ensureOverlay();
    const pctx = previewCanvas.getContext('2d');
    const lw = 560, lh = 420, dpr = DS.DPR || 1;
    const bw = Math.round(lw * dpr), bh = Math.round(lh * dpr);
    if (previewCanvas.width !== bw || previewCanvas.height !== bh) {
      previewCanvas.width = bw; previewCanvas.height = bh;
      previewCanvas.style.width = lw + 'px'; previewCanvas.style.height = lh + 'px';
    }
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pctx.clearRect(0, 0, lw, lh);
    pctx.fillStyle = D.COL.paperShade;
    pctx.fillRect(0, 0, lw, lh);
    if (video && video.readyState >= 2) {
      pctx.save();
      pctx.translate(lw, 0); pctx.scale(-1, 1);
      pctx.globalAlpha = 0.52;
      pctx.drawImage(video, 0, 0, lw, lh);
      pctx.restore();
    }
    drawGuideSkeleton(pctx, lw, lh);
    drawHumanSkeleton(pctx, lw, lh);
    if (recording) drawTrackedDoodle(pctx, lw, lh, false);
    drawTrackingHud(pctx, lw, lh);

    const rctx = recordCanvas.getContext('2d');
    rctx.setTransform(1, 0, 0, 1, 0, 0);
    rctx.clearRect(0, 0, 512, 512);
    rctx.fillStyle = D.COL.paper;
    rctx.fillRect(0, 0, 512, 512);
    if (D.paperTexture) rctx.drawImage(D.paperTexture(512, 512), 0, 0);
    drawTrackedDoodle(rctx, 512, 512, true);
    captureKeyframe();
  }

  function pointToScreen(p, w, h) {
    return p ? { x: p.x * w, y: p.y * h } : null;
  }

  function landmarkToScreen(p, w, h) {
    return pointToScreen(mirrored(p), w, h);
  }

  function drawGuideSkeleton(ctx, w, h) {
    const g = guidePoints();
    const pts = {
      nose: pointToScreen(g.nose, w, h), lSh: pointToScreen(g.lSh, w, h), rSh: pointToScreen(g.rSh, w, h),
      lEl: pointToScreen(g.lEl, w, h), rEl: pointToScreen(g.rEl, w, h), lWr: pointToScreen(g.lWr, w, h), rWr: pointToScreen(g.rWr, w, h),
      lHip: pointToScreen(g.lHip, w, h), rHip: pointToScreen(g.rHip, w, h),
    };
    const edges = [['lSh', 'rSh'], ['lSh', 'lHip'], ['rSh', 'rHip'], ['lHip', 'rHip'], ['lSh', 'lEl'], ['lEl', 'lWr'], ['rSh', 'rEl'], ['rEl', 'rWr']];
    ctx.save();
    ctx.globalAlpha = 0.72;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = D.COL.paper;
    ctx.lineWidth = 10;
    for (const e of edges) {
      ctx.beginPath(); ctx.moveTo(pts[e[0]].x, pts[e[0]].y); ctx.lineTo(pts[e[1]].x, pts[e[1]].y); ctx.stroke();
    }
    ctx.strokeStyle = D.COL.ink;
    ctx.setLineDash([10, 10]);
    ctx.lineWidth = 4;
    for (const e of edges) {
      ctx.beginPath(); ctx.moveTo(pts[e[0]].x, pts[e[0]].y); ctx.lineTo(pts[e[1]].x, pts[e[1]].y); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = D.COL.paper;
    ctx.strokeStyle = D.COL.ink;
    ctx.lineWidth = 3;
    Object.keys(pts).forEach((key) => {
      const r = key === 'nose' ? 8 : 7;
      ctx.beginPath(); ctx.arc(pts[key].x, pts[key].y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
    ctx.restore();
  }

  function drawHumanSkeleton(ctx, w, h) {
    if (!currentLandmarks) return;
    const ready = trackingQuality && trackingQuality.ready;
    const ok = trackingQuality && trackingQuality.ok;
    const color = ready || ok ? '#22863a' : '#b3402a';
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const edge of SKELETON_EDGES) {
      const a = landmarkToScreen(currentLandmarks[edge[0]], w, h);
      const b = landmarkToScreen(currentLandmarks[edge[1]], w, h);
      if (!a || !b) continue;
      ctx.strokeStyle = D.COL.paper;
      ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (const idx of REQUIRED_LANDMARKS) {
      const p = landmarkToScreen(currentLandmarks[idx], w, h);
      if (!p) continue;
      ctx.fillStyle = landmarkVisible(currentLandmarks[idx]) ? color : '#b3402a';
      ctx.strokeStyle = D.COL.paper;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, 6.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  function drawTrackingHud(ctx, w, h) {
    const q = trackingQuality;
    const leftMs = q && q.countdownLeftMs != null ? q.countdownLeftMs : ALIGN_COUNTDOWN_MS;
    const progress = q && q.ok ? 1 - (leftMs / ALIGN_COUNTDOWN_MS) : 0;
    const label = recording
      ? 'Recording doodle puppet'
      : q && q.ready
        ? 'Skeleton locked'
        : q && q.ok
          ? 'Hold alignment ' + Math.ceil(leftMs / 1000)
          : q && q.reason
            ? q.reason
            : 'Loading pose tracker';
    ctx.save();
    D.roundedRect(ctx, 14, 14, Math.min(330, w - 28), 56, 8, { width: 3, color: D.COL.ink, fill: D.COL.paper, rnd: DS.makeRng(84), passes: 1 });
    ctx.fillStyle = D.COL.ink;
    ctx.textBaseline = 'middle';
    ctx.font = "18px 'Patrick Hand', sans-serif";
    ctx.fillText(label, 30, 36);
    ctx.fillStyle = q && (q.ready || q.ok) ? '#22863a' : '#b3402a';
    ctx.fillRect(30, 55, 230 * clamp(progress, 0, 1), 7);
    ctx.strokeStyle = D.COL.ink;
    ctx.lineWidth = 2;
    ctx.strokeRect(30, 55, 230, 7);
    ctx.restore();
  }

  function drawTrackedDoodle(ctx, w, h, recordingCanvas) {
    const context = contexts[activePlayer] || {};
    const ch = context.character || resolveCharacter(activePlayer);
    const pose = currentPose || (ch.actions && ch.actions.idle && ch.actions.idle.pose);
    const facing = context.facing || 1;
    let x = w / 2, y = h * 0.67, scale = recordingCanvas ? 4.2 : 3.65;
    if (!recordingCanvas && currentLandmarks) {
      const lSh = mirrored(currentLandmarks[IDX.lSh]), rSh = mirrored(currentLandmarks[IDX.rSh]), lHip = mirrored(currentLandmarks[IDX.lHip]), rHip = mirrored(currentLandmarks[IDX.rHip]);
      if (lSh && rSh && lHip && rHip) {
        const shDist = Math.abs(rSh.x - lSh.x) * w;
        x = ((lSh.x + rSh.x + lHip.x + rHip.x) / 4) * w;
        y = ((lSh.y + rSh.y + lHip.y + rHip.y) / 4) * h + 76;
        scale = clamp(shDist / 18, 2.7, 5.2);
      }
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    DS.character.drawFighter(ctx, ch, pose, { facing, seed: 1200 + activePlayer * 97 });
    ctx.restore();
  }

  function resolveCharacter(playerIndex) {
    const data = DS.Store && DS.Store.data;
    const name = data && data.roster && (data.roster[playerIndex] || data.roster[0]);
    return name && data.characters[name] ? data.characters[name] : data.characters[Object.keys(data.characters)[0]];
  }

  function captureKeyframe(force) {
    if (!recording) return;
    const now = performance.now();
    if (!force && recording.keyframes.length && now - recording.lastKeyframeAt < 420) return;
    if (recording.keyframes.length >= 5) return;
    recording.lastKeyframeAt = now;
    recording.keyframes.push(recordCanvas.toDataURL('image/png'));
  }

  async function startRecording(playerIndex) {
    if (recording) return recording.promise;
    activePlayer = playerIndex || activePlayer || 0;
    if (!stream) {
      const ok = await startCamera(activePlayer);
      if (!ok) return null;
    }
    if (!trackingQuality || !trackingQuality.ready) {
      setState(activePlayer, STATUS.align, trackingQuality && trackingQuality.reason ? trackingQuality.reason : 'step into the skeleton');
      updateActionButton();
      return new Promise((resolve, reject) => {
        pendingRecord = { playerIndex: activePlayer, resolve, reject };
      });
    }
    return beginRecording();
  }

  function beginRecording() {
    if (recording) return recording.promise;
    const waiting = pendingRecord;
    pendingRecord = null;
    setState(activePlayer, STATUS.recording);
    updateActionButton();
    const chunks = [];
    const recStream = recordCanvas.captureStream ? recordCanvas.captureStream(30) : null;
    let recorder = null;
    if (recStream && global.MediaRecorder) {
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      recorder = new MediaRecorder(recStream, { mimeType: mime });
      recorder.ondataavailable = (event) => { if (event.data && event.data.size) chunks.push(event.data); };
    }
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    recording = {
      playerIndex: activePlayer,
      startedAt: performance.now(),
      lastKeyframeAt: 0,
      keyframes: [],
      chunks,
      recorder,
      promise,
      resolve: (value) => {
        resolve(value);
        if (waiting) waiting.resolve(value);
      },
      clipDataUrl: null,
    };
    captureKeyframe(true);
    if (recorder) {
      recorder.onstop = finishRecording;
      recorder.start();
    }
    global.setTimeout(() => stopRecording(), REC_MS);
    return promise;
  }

  async function stopRecording() {
    if (!recording) return null;
    captureKeyframe(true);
    if (recording.recorder && recording.recorder.state !== 'inactive') {
      recording.recorder.stop();
      return recording.promise;
    }
    return finishRecording();
  }

  function finishRecording() {
    if (!recording) return null;
    const rec = recording;
    const elapsed = performance.now() - rec.startedAt;
    const finish = (dataUrl) => {
      rec.clipDataUrl = dataUrl;
      rec.summary = {
        durationMs: Math.round(elapsed),
        keyframeCount: rec.keyframes.length,
        maxWristSpeed: prevWrists ? Number((prevWrists.max || 0).toFixed(3)) : 0,
        impactAtMs: prevWrists && prevWrists.impactAtMs != null ? Math.round(prevWrists.impactAtMs) : null,
        source: 'mediapipe_pose_landmarker_video',
      };
      recording = null;
      lastClip = dataUrl;
      lastKeyframes = rec.keyframes.slice();
      lastSummary = rec.summary;
      setState(rec.playerIndex, STATUS.generating);
      updateActionButton();
      rec.resolve(dataUrl);
      return dataUrl;
    };
    if (!rec.chunks.length) return finish(null);
    const blob = new Blob(rec.chunks, { type: rec.chunks[0].type || 'video/webm' });
    const reader = new FileReader();
    reader.onload = () => finish(String(reader.result || ''));
    reader.onerror = () => finish(null);
    reader.readAsDataURL(blob);
    return rec.promise;
  }

  let lastClip = null;
  let lastKeyframes = [];
  let lastSummary = null;

  function setJobState(playerIndex, state, error) {
    setState(playerIndex, state, error);
  }

  DS.UltimateRecorder = {
    STATUS,
    configurePlayer,
    set onChange(fn) { onChange = fn; },
    get onChange() { return onChange; },
    startCamera,
    startRecording,
    stopRecording,
    getMotionClip() { return recording ? recording.clipDataUrl : lastClip; },
    getKeyframes() { return recording ? recording.keyframes.slice() : lastKeyframes.slice(); },
    getMotionSummary() { return recording ? null : lastSummary; },
    getState(playerIndex) { return states[playerIndex] || { state: STATUS.camera, error: null }; },
    setJobState,
    hide: hideOverlay,
  };
})(window);
