// js/campad.js — DS.CamPad: a webcam capture panel to TEST the camera->play loop.
//
// Press 'C' to toggle a little camera panel. Point a webcam at a real object, hit Snap -> the current
// frame is captured, its background is removed in-browser (so just the cut-out object remains on
// transparency), and it drops into the live match through DS.AI.spawnFromImage (recognizer names it,
// CHLOE assigns mechanics, CAELLUM/fal enhance it). This is the camera sibling of the DrawPad sketch
// path; it exercises the exact same DS.AI entry point with a rasterized image.
//
// Background removal uses @imgly/background-removal@1.7.0 loaded as an ESM from esm.sh via a dynamic
// import() — removeBackground(canvasBlob) -> Promise<Blob>. If the lib fails to load or errors, we fall
// back to the raw captured frame so the demo still works without a cutout.
(function (global) {
  'use strict';
  const DS = global.DS;
  const IMGLY_URL = 'https://esm.sh/@imgly/background-removal@1.7.0';
  let panel, video, statusEl, stream = null, open = false, busy = false;

  function btn(txt, fn, bg) {
    const b = document.createElement('button');
    b.textContent = txt; b.onclick = fn;
    b.style.cssText = 'padding:6px 10px;border:2px solid #1a1a1a;border-radius:5px;font-weight:700;cursor:pointer;background:' + (bg || '#eee');
    return b;
  }

  function build() {
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#f7f3e9;border:3px solid #1a1a1a;' +
      'border-radius:10px;padding:10px;font-family:sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);display:none';
    const title = document.createElement('div');
    title.textContent = '📷 Camera  (C to toggle)';
    title.style.cssText = 'font-weight:700;margin-bottom:6px;font-size:13px';
    panel.appendChild(title);

    video = document.createElement('video');
    video.autoplay = true; video.playsInline = true; video.muted = true;
    video.width = 300; video.height = 225;
    video.style.cssText = 'background:#000;border:2px solid #1a1a1a;border-radius:6px;display:block;width:300px;height:225px;object-fit:cover';
    panel.appendChild(video);

    statusEl = document.createElement('div');
    statusEl.style.cssText = 'margin-top:6px;font-size:12px;min-height:16px;color:#555';
    panel.appendChild(statusEl);

    const row = document.createElement('div'); row.style.cssText = 'margin-top:8px;display:flex;gap:6px;align-items:center';
    row.appendChild(btn('Snap 📸', doSnap, '#ffd34d'));
    row.appendChild(btn('Close', function () { if (open) toggle(); }, '#eee'));
    panel.appendChild(row);

    document.body.appendChild(panel);
  }

  function setStatus(t) { if (statusEl) statusEl.textContent = t || ''; }

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('camera not available'); return;
    }
    setStatus('starting camera…');
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .catch(function () { return navigator.mediaDevices.getUserMedia({ video: true }); })
      .then(function (s) {
        stream = s; video.srcObject = s;
        const p = video.play(); if (p && p.catch) p.catch(function () {});
        setStatus('');
      })
      .catch(function (e) { setStatus('camera error: ' + (e && e.message || e)); });
  }

  function stopCamera() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (video) video.srcObject = null;
  }

  // grab the current video frame onto an offscreen canvas, long edge capped to ~512.
  function captureCanvas() {
    const vw = video.videoWidth || 512, vh = video.videoHeight || 512;
    const sc = Math.min(1, 512 / Math.max(vw, vh));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(vw * sc));
    cv.height = Math.max(1, Math.round(vh * sc));
    cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height);
    return cv;
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  function canvasToBlob(cv) {
    return new Promise(function (resolve) { cv.toBlob(function (b) { resolve(b); }, 'image/png'); });
  }

  // remove the background via @imgly (dynamic ESM import); fall back to the raw frame on any failure.
  function cutout(cv) {
    return canvasToBlob(cv).then(function (raw) {
      return import(/* @vite-ignore */ IMGLY_URL)
        .then(function (mod) {
          const removeBackground = mod.removeBackground || (mod.default && mod.default.removeBackground) || mod.default;
          if (typeof removeBackground !== 'function') throw new Error('removeBackground export not found');
          return removeBackground(raw, { output: { format: 'image/png' } });
        })
        .then(function (outBlob) { return blobToDataUrl(outBlob); })
        .catch(function (e) {
          setStatus('cutout unavailable, using raw frame');
          if (global.console) console.warn('CamPad: background removal failed', e);
          return blobToDataUrl(raw);
        });
    });
  }

  function doSnap() {
    if (busy) return;
    if (!stream) { setStatus('camera not ready'); return; }
    if (!DS.AI || !DS.game || DS.game.state !== 'playing') {
      if (global.__showErr) global.__showErr('CamPad: start a match first');
      return;
    }
    busy = true;
    setStatus('removing background… (first run downloads a model)');
    const cv = captureCanvas();
    cutout(cv).then(function (dataUrl) {
      const v = (DS.game && DS.game.view) || { w: 1920, h: 1080 };
      DS.AI.spawnFromImage(dataUrl, null, v.w * 0.5, 150); // null label -> recognizer names it
      setStatus('spawned ▶');
    }).catch(function (e) {
      setStatus('snap failed: ' + (e && e.message || e));
    }).then(function () { busy = false; });
  }

  function toggle() {
    if (!panel) build();
    open = !open;
    panel.style.display = open ? 'block' : 'none';
    if (open) startCamera();
    else { stopCamera(); setStatus(''); }
  }

  DS.CamPad = { toggle: toggle };
  global.addEventListener('keydown', function (e) {
    if (e.code === 'KeyC' && !e.repeat && !(e.target && /INPUT|TEXTAREA/.test(e.target.tagName))) toggle();
  });
})(window);
