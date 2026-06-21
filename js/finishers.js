// AI KO finishers: generated MP4 cut-ins are optional cached cosmetics.
// Gameplay remains deterministic canvas doodles; this module only captures official
// in-game renders and asks the backend to generate rare final-KO videos.
(function (global) {
  'use strict';
  const DS = global.DS;
  const D = DS.draw;

  const MODEL = 'pikaffects-v1.5';
  const MOTION_MODEL = 'doodle-keyframes-v1';
  const STYLES = ['Melt', 'Explode', 'Dissolve', 'Squish', 'Tear', 'Crumble', 'Cake-ify'];
  const DEFAULT_BACKEND = 'http://localhost:8000';
  const RENDER_VERSION = 'finisher-render-v1';
  const preloaded = {};

  function backendUrl() {
    const params = new URLSearchParams(global.location.search);
    const raw = params.get('finisherBackend') || params.get('drawBackend') || params.get('backend') || DEFAULT_BACKEND;
    try { return new URL(raw, global.location.href); }
    catch (_error) { return new URL(DEFAULT_BACKEND); }
  }

  function apiUrl(path) {
    const url = backendUrl();
    url.pathname = path;
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  function stable(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }

  function hashText(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function ensure(ch) {
    if (!ch.finisher || typeof ch.finisher !== 'object') ch.finisher = {};
    if (!STYLES.includes(ch.finisher.style)) ch.finisher.style = 'Melt';
    if (!ch.finisher.jobs || typeof ch.finisher.jobs !== 'object') ch.finisher.jobs = {};
    if (!ch.finisher.clips || typeof ch.finisher.clips !== 'object') ch.finisher.clips = {};
    if (!ch.finisher.customUltimates || typeof ch.finisher.customUltimates !== 'object') ch.finisher.customUltimates = {};
    return ch.finisher;
  }

  function victimSkinHash(name, ch) {
    return hashText([name || (ch && ch.name) || 'character', stable(ch && ch.skin ? ch.skin : null), RENDER_VERSION].join('|'));
  }

  function cacheKey(attackerId, style, victimId, skinHash, sourceType, motionHash, finisherKind) {
    return [attackerId, style, victimId, skinHash, sourceType || 'pikaffects_image', finisherKind || '', motionHash || '', MODEL].join('|');
  }

  function customUltimateKey(playerId, characterId, skinHash, motionHash, style) {
    return [playerId, characterId, skinHash || '', motionHash || '', style || 'Melt', MOTION_MODEL].join('|');
  }

  function renderCharacterDataUrl(ch) {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 512;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = D.COL.paper;
    ctx.fillRect(0, 0, 512, 512);
    if (D.paperTexture) ctx.drawImage(D.paperTexture(512, 512), 0, 0);
    const pose = (ch.actions && ch.actions.hurt && ch.actions.hurt.pose)
      || (ch.actions && ch.actions.idle && ch.actions.idle.pose);
    ctx.save();
    ctx.translate(256, 298);
    ctx.scale(4.45, 4.45);
    DS.character.drawFighter(ctx, ch, pose, { facing: 1, expr: 'hurt', seed: 917 });
    ctx.restore();
    return cv.toDataURL('image/png');
  }

  // ---- item-based finisher (the FIRST item a fighter picks up imprints a finisher) -----------------
  // map the item's element -> a Pika canned effect whose motion already reads as the KO + an action line.
  const ITEM_FX = {
    fire: 'Explode', electric: 'Explode', bomb: 'Explode',
    ice: 'Dissolve', water: 'Dissolve', light: 'Dissolve',
    poison: 'Melt', dark: 'Melt',
    plant: 'Crumble', metal: 'Crumble', rock: 'Crumble',
    wind: 'Tear',
  };
  const ITEM_ACTION = {
    fire: 'A fireball engulfs the opponent, who bursts into ash.',
    water: 'A torrent washes over the opponent, who dissolves away.',
    ice: 'A freezing blast shatters the opponent into frost.',
    electric: 'A lightning bolt blows the opponent apart.',
    plant: 'Vines crush the opponent into dust.',
    poison: 'Toxic sludge melts the opponent away.',
    metal: 'A heavy strike smashes the opponent to pieces.',
    rock: 'The opponent is crushed and crumbles to rubble.',
    light: 'A radiant burst disintegrates the opponent.',
    dark: 'Shadow consumes the opponent, who melts away.',
    wind: 'A gale tears the opponent apart.',
  };
  function itemFinisherSpec(element, itemLabel, holderName, victimName, holderSide) {
    const el = (element || '').toLowerCase();
    const style = ITEM_FX[el] || 'Explode';
    const item = itemLabel || el || 'weapon';
    const action = ITEM_ACTION[el] || ('The ' + (holderSide || 'left') + ' fighter finishes the opponent with the ' + item + '.');
    const prompt = 'Two simple hand-drawn black marker doodle fighters on a warm paper background (keep both fighters, keep the scene). '
      + action + ' Keep the marker line art and paper background; do not redesign the characters, do not add realistic detail. Short, dramatic KO finisher.';
    return { style: style, prompt: prompt };
  }

  // snapshot the LIVE game canvas (already shows both fighters + the styled scene) -> data URL for Pika.
  function captureGameScreenshot(game) {
    const src = game && game.canvas;
    if (!src || !src.width || !src.height) return null;
    const scale = Math.min(1, 768 / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = D.COL.paper; ctx.fillRect(0, 0, w, h);
    try { ctx.drawImage(src, 0, 0, w, h); } catch (e) { return null; }
    return cv.toDataURL('image/png');
  }

  // start a background Pika job for "holder uses itemLabel to finish victim", styled to the live scene.
  // Returns the generate() promise ({key, job}). Fire-and-forget from the pickup hook.
  function generateItemFinisher(game, holder, victim, itemLabel, element) {
    if (!holder || !holder.ch || !victim || !victim.ch) return Promise.resolve(null);
    const img = captureGameScreenshot(game);
    if (!img) return Promise.resolve(null);
    const spec = itemFinisherSpec(element, itemLabel, holder.name, victim.name, holder.x <= victim.x ? 'left' : 'right');
    return generate(holder.name, victim.name, {
      style: spec.style, imageDataUrl: img, prompt: spec.prompt,
      finisherKind: 'item', sourceType: 'pikaffects_image',
    });
  }

  // the ready item-finisher clip for a holder (keyed by the cache key stored on the fighter at pickup).
  function findReadyItemClip(holder) {
    if (!holder || !holder.ch || !holder.finisherCacheKey) return null;
    const finisher = ensure(holder.ch);
    const clip = finisher.clips && finisher.clips[holder.finisherCacheKey];
    return clip && clip.videoUrl ? Object.assign({ key: holder.finisherCacheKey }, clip) : null;
  }

  async function submitJob(attackerId, victimId, victimSkinHashValue, style, imageDataUrl, options) {
    options = options || {};
    const response = await fetch(apiUrl('/finishers/jobs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attackerId,
        victimId,
        victimSkinHash: victimSkinHashValue,
        style,
        imageDataUrl,
        sourceType: options.sourceType || 'pikaffects_image',
        motionClipDataUrl: options.motionClipDataUrl || null,
        keyframeDataUrls: options.keyframeDataUrls || [],
        motionSummary: options.motionSummary || null,
        skinHash: options.skinHash || null,
        prompt: options.prompt || null,             // item finisher: tailored two-character prompt
        finisherKind: options.finisherKind || null, // 'item' -> separate cache from ultimate-KO finishers
      }),
    });
    if (!response.ok) throw new Error('finisher job failed: ' + response.status);
    return response.json();
  }

  async function getJob(jobId) {
    const response = await fetch(apiUrl('/finishers/jobs/' + encodeURIComponent(jobId)), { cache: 'no-store' });
    if (!response.ok) throw new Error('finisher status failed: ' + response.status);
    return response.json();
  }

  function storeJob(attackerCh, key, victimId, skinHash, style, job, options) {
    options = options || {};
    const finisher = ensure(attackerCh);
    finisher.jobs[key] = {
      jobId: job.jobId,
      status: job.status,
      error: job.error || null,
      victimId,
      victimSkinHash: skinHash,
      style,
      sourceType: options.sourceType || 'pikaffects_image',
      motionHash: options.motionHash || null,
      playerId: options.playerId || null,
      characterId: options.characterId || null,
      skinHash: options.skinHash || null,
      updatedAt: new Date().toISOString(),
    };
    if (job.status === 'ready' && job.videoUrl) {
      const clip = {
        videoUrl: job.videoUrl,
        jobId: job.jobId,
        victimId,
        victimSkinHash: skinHash,
        style,
        sourceType: options.sourceType || 'pikaffects_image',
        motionHash: options.motionHash || null,
        playerId: options.playerId || null,
        characterId: options.characterId || null,
        model: options.sourceType === 'doodle_keyframes' ? MOTION_MODEL : MODEL,
        updatedAt: new Date().toISOString(),
        note: 'fal media URLs may expire; V1 stores the hosted URL for local demo persistence.',
      };
      finisher.clips[key] = clip;
      if (options.sourceType === 'doodle_keyframes' && options.playerId != null) {
        finisher.customUltimates[options.playerId] = Object.assign({ key, armed: true }, clip);
      }
    }
    if (DS.Store && DS.Store.save) DS.Store.save();
  }

  async function generate(attackerId, victimId, options) {
    options = options || {};
    const data = DS.Store && DS.Store.data;
    const attacker = data && data.characters && data.characters[attackerId];
    const victim = data && data.characters && data.characters[victimId];
    if (!attacker || (!victim && !options.sourceType)) throw new Error('Choose valid attacker and victim characters.');
    const finisher = ensure(attacker);
    const style = options.style || finisher.style || 'Melt';
    const skinHash = options.skinHash || victimSkinHash(victimId, victim);
    const sourceType = options.sourceType || 'pikaffects_image';
    const motionHash = options.motionHash || hashText(stable({
      motionClipDataUrl: options.motionClipDataUrl || '',
      keyframeDataUrls: options.keyframeDataUrls || [],
      motionSummary: options.motionSummary || null,
    }));
    const key = sourceType === 'doodle_keyframes' && options.playerId != null
      ? customUltimateKey(options.playerId, attackerId, skinHash, motionHash, style)
      : cacheKey(attackerId, style, victimId, skinHash, sourceType, sourceType === 'pikaffects_image' ? '' : motionHash, options.finisherKind || '');
    const imageDataUrl = options.imageDataUrl || renderCharacterDataUrl(victim || attacker);
    const job = await submitJob(attackerId, victimId || 'custom-ultimate', skinHash, style, imageDataUrl, Object.assign({}, options, { sourceType, motionHash, skinHash }));
    storeJob(attacker, key, victimId || 'custom-ultimate', skinHash, style, job, Object.assign({}, options, { sourceType, motionHash, skinHash, characterId: attackerId }));
    return { key, job };
  }

  async function generateCustomUltimate(playerId, characterId, options) {
    options = options || {};
    return generate(characterId, characterId, Object.assign({}, options, {
      playerId: String(playerId),
      characterId,
      sourceType: options.sourceType || 'doodle_keyframes',
    }));
  }

  async function refresh(attackerId, key) {
    const data = DS.Store && DS.Store.data;
    const attacker = data && data.characters && data.characters[attackerId];
    const finisher = attacker && ensure(attacker);
    const record = finisher && finisher.jobs[key];
    if (!record || !record.jobId) throw new Error('No finisher job to refresh.');
    const job = await getJob(record.jobId);
    storeJob(attacker, key, record.victimId, record.victimSkinHash, record.style, job, record);
    return job;
  }

  async function refreshPendingForGame(game) {
    if (!game || !game.fighters) return;
    const seen = new Set();
    for (const f of game.fighters) {
      if (!f || !f.ch) continue;
      const finisher = ensure(f.ch);
      for (const key in finisher.jobs) {
        const record = finisher.jobs[key];
        if (!record || !record.jobId || seen.has(record.jobId)) continue;
        if (record.status === 'ready' || record.status === 'failed' || record.status === 'missing_key') continue;
        seen.add(record.jobId);
        try {
          const latest = await getJob(record.jobId);
          storeJob(f.ch, key, record.victimId, record.victimSkinHash, record.style, latest, record);
          if (latest.status === 'ready' && latest.videoUrl) videoForClip(Object.assign({ key }, finisher.clips[key]));
        } catch (_error) {
          record.error = 'refresh failed';
          record.updatedAt = new Date().toISOString();
        }
      }
    }
  }

  function findReadyClip(attacker, victim) {
    if (!attacker || !victim || !attacker.ch || !victim.ch) return null;
    const finisher = ensure(attacker.ch);
    const custom = finisher.customUltimates && finisher.customUltimates[String(attacker.pIndex)];
    if (custom && custom.armed && custom.videoUrl) return Object.assign({ key: custom.key, customUltimate: true }, custom);
    const style = finisher.style || 'Melt';
    const skinHash = victimSkinHash(victim.name, victim.ch);
    const key = cacheKey(attacker.name, style, victim.name, skinHash);
    const clip = finisher.clips && finisher.clips[key];
    return clip && clip.videoUrl ? Object.assign({ key }, clip) : null;
  }

  function videoForClip(clip) {
    if (!clip || !clip.videoUrl) return null;
    if (preloaded[clip.key] && preloaded[clip.key].src === clip.videoUrl) return preloaded[clip.key];
    const video = document.createElement('video');
    // Safari needs muted/playsinline as real ATTRIBUTES (not just JS props) to allow inline muted autoplay.
    video.muted = true; video.defaultMuted = true; video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('autoplay', '');
    video.preload = 'auto';
    video.src = clip.videoUrl;
    // Attach off-screen: a fully-DETACHED <video> often never buffers (readyState stays 0), which leaves
    // the finisher overlay stuck on its fallback and play() racing an unloaded element. In the DOM it
    // reliably loads/decodes and stays clean for canvas drawImage (same-origin asset).
    video.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    if (global.document && document.body) document.body.appendChild(video);
    try { video.load(); } catch (_e) { /* best-effort */ }
    preloaded[clip.key] = video;
    return video;
  }

  // DEMO finisher: a pre-baked, reused FIRE clip (assets/finishers/fire.mp4). The first item a fighter
  // picks up arms this — no per-match AI generation, no backend, no ~100s wait, identical every run.
  // Full origin URL so videoForClip's `src === videoUrl` cache check matches (it normalizes to absolute).
  const LOCAL_FIRE_CLIP = (global.location && global.location.origin ? global.location.origin : '') + '/assets/finishers/fire.mp4';
  function armLocalFinisher(holder, itemLabel) {
    if (!holder) return null;
    holder.finisherItem = { label: itemLabel || 'fire', element: 'fire' };
    const clip = { key: 'local-fire-p' + (holder.pIndex || 0), videoUrl: LOCAL_FIRE_CLIP };
    holder.finisherClip = clip;
    holder.finisherCacheKey = clip.key;
    holder.finisherReady = true;   // pre-baked local clip -> arm immediately so the green aura ALWAYS shows
    const v = videoForClip(clip);  // start buffering (a ~1MB local file is ready well before it's used)
    if (v && v.load) { try { v.load(); } catch (_e) { /* off-DOM load is best-effort */ } }
    return clip;
  }

  function preloadForGame(game) {
    if (!game || !game.fighters) return;
    for (const attacker of game.fighters) {
      for (const victim of game.fighters) {
        if (attacker === victim) continue;
        const clip = findReadyClip(attacker, victim);
        if (clip) videoForClip(clip);
      }
    }
  }

  DS.Finishers = {
    MODEL,
    MOTION_MODEL,
    STYLES,
    ensure,
    victimSkinHash,
    cacheKey,
    customUltimateKey,
    renderCharacterDataUrl,
    generate,
    generateCustomUltimate,
    refresh,
    refreshPendingForGame,
    findReadyClip,
    videoForClip,
    preloadForGame,
    itemFinisherSpec,
    captureGameScreenshot,
    generateItemFinisher,
    armLocalFinisher,
    findReadyItemClip,
  };
})(window);
