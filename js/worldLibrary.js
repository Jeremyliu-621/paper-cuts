// Phase 1.5 Game Library: local world records and creation-first desktop entry.
(function (global) {
  'use strict';

  const DS = global.DS = global.DS || {};
  const KEY = 'magicboard:worlds:v1';
  const REQUIRED_CHARACTER_COUNT = 2;

  const STATUS = {
    draft: { id: 'draft', label: 'Draft' },
    missingPlatform: { id: 'missing platform', label: 'Missing platform' },
    missingSpawnPoints: { id: 'missing spawn points', label: 'Missing spawn points' },
    missingCharacters: { id: 'missing characters', label: 'Missing characters' },
    ready: { id: 'ready to play', label: 'Ready to play' },
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function safeIdPart(value) {
    return String(value || 'world').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'world';
  }

  function defaultDraft() {
    return {
      platforms: [],
      spawns: [],
      characters: [],
    };
  }

  function draftFor(world) {
    const draft = world && world.draft && typeof world.draft === 'object' ? world.draft : {};
    return {
      platforms: Array.isArray(draft.platforms) ? draft.platforms : [],
      spawns: Array.isArray(draft.spawns) ? draft.spawns : [],
      characters: Array.isArray(draft.characters) ? draft.characters : [],
    };
  }

  function drawingCaptureFor(world) {
    const saved = world && world.drawingCapture && typeof world.drawingCapture === 'object' ? world.drawingCapture : null;
    if (!saved) return null;
    return {
      roomId: saved.roomId || world.roomId || world.id,
      version: Number.isFinite(saved.version) ? saved.version : 0,
      capture: saved.capture && typeof saved.capture === 'object' ? saved.capture : null,
      projection: saved.projection && typeof saved.projection === 'object' ? saved.projection : null,
      semanticDraft: saved.semanticDraft && typeof saved.semanticDraft === 'object' ? saved.semanticDraft : null,
      backendUpdatedAt: saved.backendUpdatedAt || null,
      savedAt: saved.savedAt || null,
    };
  }

  function missingRequirements(world) {
    const draft = draftFor(world);
    const missing = [];
    if (draft.platforms.length < 1) missing.push('1 platform');
    if (draft.spawns.length < 2) missing.push('2 spawn points');
    if (draft.characters.length < REQUIRED_CHARACTER_COUNT) missing.push('required characters');
    return missing;
  }

  function statusFor(world) {
    const draft = draftFor(world);
    if (draft.platforms.length < 1 && draft.spawns.length < 1 && draft.characters.length < 1) return STATUS.draft;
    if (draft.platforms.length < 1) return STATUS.missingPlatform;
    if (draft.spawns.length < 2) return STATUS.missingSpawnPoints;
    if (draft.characters.length < REQUIRED_CHARACTER_COUNT) return STATUS.missingCharacters;
    return STATUS.ready;
  }

  function isReady(world) {
    return statusFor(world).id === STATUS.ready.id;
  }

  function normalizeWorld(world) {
    world = world && typeof world === 'object' ? world : {};
    const baseName = world && typeof world.name === 'string' && world.name.trim() ? world.name.trim() : 'Untitled';
    const createdAt = world.createdAt || nowIso();
    const id = world.id || ('world-' + safeIdPart(baseName) + '-' + Date.now().toString(36));
    const out = {
      id,
      name: baseName,
      roomId: world.roomId || id,
      createdAt,
      updatedAt: world.updatedAt || createdAt,
      lastEditedAt: world.lastEditedAt || null,
      thumbnail: world.thumbnail || null,
      drawingCapture: drawingCaptureFor(world),
      draft: draftFor(world),
      modeId: world.modeId || 'smash',
      mapId: world.mapId || 'meadow',
    };
    out.status = statusFor(out).id;
    return out;
  }

  function readWorlds() {
    try {
      const raw = global.localStorage.getItem(KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeWorld);
    } catch (error) {
      console.warn('world library load failed', error);
      return [];
    }
  }

  function writeWorlds(worlds) {
    const normalized = worlds.map(normalizeWorld);
    try {
      global.localStorage.setItem(KEY, JSON.stringify(normalized));
    } catch (error) {
      console.warn('world library save failed', error);
    }
    return normalized;
  }

  function nextUntitledName(worlds) {
    let max = 0;
    for (const world of worlds) {
      const match = /^Untitled\s+(\d+)$/.exec(world.name || '');
      if (match) max = Math.max(max, parseInt(match[1], 10) || 0);
    }
    return 'Untitled ' + (max + 1);
  }

  function createWorld() {
    const worlds = readWorlds();
    const name = nextUntitledName(worlds);
    const stamp = nowIso();
    const id = 'world-' + safeIdPart(name) + '-' + Date.now().toString(36);
    const world = normalizeWorld({
      id,
      name,
      roomId: id,
      createdAt: stamp,
      updatedAt: stamp,
      draft: defaultDraft(),
    });
    worlds.push(world);
    writeWorlds(worlds);
    return world;
  }

  function updateWorld(id, patch) {
    const worlds = readWorlds();
    const index = worlds.findIndex((world) => world.id === id);
    if (index < 0) return null;
    worlds[index] = normalizeWorld(Object.assign({}, worlds[index], patch || {}, { updatedAt: nowIso() }));
    writeWorlds(worlds);
    return worlds[index];
  }

  function saveDrawingCapture(id, roomCapture) {
    if (!roomCapture || typeof roomCapture !== 'object') return null;
    return updateWorld(id, {
      lastEditedAt: roomCapture.updatedAt || nowIso(),
      drawingCapture: {
        roomId: roomCapture.roomId || id,
        version: Number.isFinite(roomCapture.version) ? roomCapture.version : 0,
        capture: roomCapture.capture || null,
        projection: roomCapture.projection || null,
        semanticDraft: roomCapture.semanticDraft || null,
        backendUpdatedAt: roomCapture.updatedAt || null,
        savedAt: nowIso(),
      },
    });
  }

  function localServiceUrl(port) {
    const protocol = global.location.protocol === 'https:' ? 'https:' : 'http:';
    const host = global.location.hostname;
    if (!host || global.location.protocol === 'file:') return protocol + '//localhost:' + port + '/';
    return protocol + '//' + host + ':' + port + '/';
  }

  function drawClientUrl(world) {
    const params = new URLSearchParams(global.location.search);
    const base = params.get('drawClient') || params.get('draw') || localServiceUrl(5173);
    const backend = params.get('backend') || localServiceUrl(8000).replace(/\/$/, '');
    let url;
    try { url = new URL(base, global.location.href); }
    catch (_error) { url = new URL('http://localhost:5173/'); }
    url.searchParams.set('room', world.roomId || world.id);
    url.searchParams.set('backend', backend);
    url.searchParams.set('world', world.id);
    return url.toString();
  }

  function init(options) {
    options = options || {};
    const overlay = document.getElementById('library-overlay');
    const content = document.getElementById('library-content');
    const newButton = document.getElementById('library-new');
    if (!overlay || !content || !newButton) return null;

    let selectedMessageId = null;

    function mk(tag, cls, text) {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      if (text != null) el.textContent = text;
      return el;
    }

    function open() {
      render();
      overlay.hidden = false;
    }

    function close() {
      overlay.hidden = true;
    }

    function renderThumbnail(world) {
      const thumb = mk('div', 'world-thumb');
      thumb.setAttribute('aria-label', world.name + ' thumbnail');
      if (world.thumbnail) {
        thumb.style.backgroundImage = 'url("' + world.thumbnail + '")';
        thumb.classList.add('has-image');
        return thumb;
      }

      const view = DS.stageReference && DS.stageReference.view ? DS.stageReference.view : { w: 1920, h: 1080 };
      const platforms = DS.stageReference && DS.stageReference.platforms ? DS.stageReference.platforms : [];
      const sketch = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      sketch.setAttribute('viewBox', '0 0 ' + view.w + ' ' + view.h);
      sketch.setAttribute('aria-hidden', 'true');
      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('x', '0');
      bg.setAttribute('y', '0');
      bg.setAttribute('width', String(view.w));
      bg.setAttribute('height', String(view.h));
      bg.setAttribute('class', 'world-thumb-bg');
      sketch.appendChild(bg);
      platforms.forEach((platform) => {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(platform.x));
        rect.setAttribute('y', String(platform.y));
        rect.setAttribute('width', String(platform.w));
        rect.setAttribute('height', String(platform.h));
        rect.setAttribute('rx', String(Math.min(platform.h / 2, 22)));
        rect.setAttribute('class', 'world-thumb-platform' + (platform.pass ? ' pass' : ''));
        sketch.appendChild(rect);
      });
      thumb.appendChild(sketch);
      thumb.appendChild(mk('span', 'world-thumb-label', 'Thumbnail pending'));
      return thumb;
    }

    function renderEmpty() {
      newButton.hidden = true;
      const empty = mk('section', 'library-empty');
      empty.appendChild(mk('div', 'library-empty-mark', '+'));
      empty.appendChild(mk('h2', null, 'Create your first game'));
      empty.appendChild(mk('p', null, 'No saved worlds yet.'));
      const button = mk('button', 'library-primary', 'Create your first game');
      button.onclick = () => {
        const world = createWorld();
        selectedMessageId = world.id;
        render();
      };
      empty.appendChild(button);
      content.appendChild(empty);
    }

    function renderWorldCard(world) {
      const status = statusFor(world);
      const missing = missingRequirements(world);
      const card = mk('article', 'world-card');
      card.dataset.worldId = world.id;
      card.appendChild(renderThumbnail(world));

      const body = mk('div', 'world-card-body');
      const titleRow = mk('div', 'world-title-row');
      titleRow.appendChild(mk('h2', null, world.name));
      titleRow.appendChild(mk('span', 'world-status status-' + safeIdPart(status.id), status.label));
      body.appendChild(titleRow);
      body.appendChild(mk('p', 'world-meta', 'Updated ' + new Date(world.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })));

      const requirement = mk('p', 'world-requirements');
      requirement.textContent = missing.length ? 'Missing: ' + missing.join(', ') + '.' : 'Ready for local play.';
      body.appendChild(requirement);

      if (world.drawingCapture && world.drawingCapture.savedAt) {
        const saved = mk('p', 'world-meta');
        saved.textContent = 'Drawing saved v' + (world.drawingCapture.version || 0) + ' · '
          + new Date(world.drawingCapture.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        body.appendChild(saved);
      }

      if (selectedMessageId === world.id && missing.length) {
        body.appendChild(mk('div', 'world-blocked-msg', 'Play is blocked until this world has ' + missing.join(', ') + '.'));
      }

      const actions = mk('div', 'world-actions');
      const play = mk('button', 'world-play' + (isReady(world) ? '' : ' blocked'), 'Play');
      play.onclick = () => {
        if (!isReady(world)) {
          selectedMessageId = world.id;
          render();
          return;
        }
        selectedMessageId = null;
        close();
        if (options.onPlay) options.onPlay(world);
      };
      actions.appendChild(play);

      const edit = mk('button', 'world-edit', 'Edit Level');
      edit.onclick = () => {
        const updated = updateWorld(world.id, { lastEditedAt: nowIso() }) || world;
        selectedMessageId = world.id;
        if (options.onEdit) {
          close();
          options.onEdit(updated);
        } else {
          render();
        }
      };
      actions.appendChild(edit);

      const live = mk('button', 'world-live', 'Live Edit');
      live.disabled = true;
      live.title = 'Coming later';
      actions.appendChild(live);
      body.appendChild(actions);
      card.appendChild(body);
      return card;
    }

    function renderWorlds(worlds) {
      newButton.hidden = false;
      const grid = mk('section', 'world-grid');
      worlds
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .forEach((world) => grid.appendChild(renderWorldCard(world)));
      content.appendChild(grid);
    }

    function render() {
      const worlds = writeWorlds(readWorlds());
      content.innerHTML = '';
      if (!worlds.length) renderEmpty();
      else renderWorlds(worlds);
    }

    newButton.onclick = () => {
      const world = createWorld();
      selectedMessageId = world.id;
      render();
    };

    return {
      open,
      close,
      render,
      createWorld,
      listWorlds: readWorlds,
      updateWorld,
      saveDrawingCapture,
      drawClientUrl,
    };
  }

  DS.WorldLibrary = {
    init,
    createWorld,
    list: readWorlds,
    saveAll: writeWorlds,
    updateWorld,
    saveDrawingCapture,
    statusFor,
    missingRequirements,
    isReady,
    drawClientUrl,
    KEY,
  };
})(window);
