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
    recording: 'recording',
    generating: 'generating',
    ready: 'custom ultimate ready',
    failed: 'failed',
    fallback: 'using default',
  };
  const IDX = {
    nose: 0, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24,
  };

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
  let impactT = 0;
  let recording = null;
  const states = [];
  const contexts = {};
  let onChange = null;

  function setState(playerIndex, state, error) {
    states[playerIndex] = { state, error: error || null, updatedAt: new Date().toISOString() };
    if (statusEl && playerIndex === activePlayer) statusEl.textContent = error ? state + ' - ' + error : state;
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
              ? result.landmarks[0].map((p) => ({ x: p.x, y: p.y, z: p.z || 0 }))
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
          if (data.landmarks && data.landmarks.length) currentLandmarks = smoothLandmarks(data.landmarks);
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
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
        video.srcObject = stream;
      }
      await video.play();
      setState(activePlayer, STATUS.tracking);
      if (!startPoseWorker()) loadPoseLandmarker();
      startLoop();
      return true;
    } catch (error) {
      setState(activePlayer, STATUS.fallback, 'camera denied');
      throw error;
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
        if (lm && lm.length) currentLandmarks = smoothLandmarks(lm);
      } catch (_error) {
        // Keep the latest pose; camera preview should not crash the lobby.
      }
    }
    currentPose = poseFromLandmarks(currentLandmarks, contexts[activePlayer] || {});
  }

  function smoothLandmarks(lm) {
    const alpha = 0.36;
    if (!smooth) smooth = lm.map((p) => ({ x: p.x, y: p.y, z: p.z || 0 }));
    for (let i = 0; i < lm.length; i++) {
      smooth[i].x += (lm[i].x - smooth[i].x) * alpha;
      smooth[i].y += (lm[i].y - smooth[i].y) * alpha;
      smooth[i].z += ((lm[i].z || 0) - smooth[i].z) * alpha;
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
    drawTrackedDoodle(pctx, lw, lh, false);

    const rctx = recordCanvas.getContext('2d');
    rctx.setTransform(1, 0, 0, 1, 0, 0);
    rctx.clearRect(0, 0, 512, 512);
    rctx.fillStyle = D.COL.paper;
    rctx.fillRect(0, 0, 512, 512);
    if (D.paperTexture) rctx.drawImage(D.paperTexture(512, 512), 0, 0);
    drawTrackedDoodle(rctx, 512, 512, true);
    captureKeyframe();
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
    if (!stream) await startCamera(activePlayer);
    setState(activePlayer, STATUS.recording);
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
      resolve,
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
