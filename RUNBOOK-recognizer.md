# RUNBOOK — RECOGNIZER: draw anything, the AI names it (Trainium model #2)

The third engine. CAELLUM makes a drawing *beautiful*; CHLOE makes it *play*; the RECOGNIZER decides
*what it is* — so the menu disappears and a kid can draw **anything**. A tiny CNN over a 28×28 raster
of the strokes → a game label, which then drives CAELLUM (sprite) + CHLOE (mechanic graph).

Why a CNN: it's tiny, instant on CPU, and a **plain** model — so training it on Trainium is clean
(no LoRA, no sharding, **none** of the consolidation pain CHLOE hit). That's your second
"trained on Trainium" deliverable.

```
get_quickdraw.py ─► data/quickdraw/{quickdraw.npz, classes.json}
                          │
   train_recognizer.py (CNN; xla/cuda/cpu) ─► recognizer_model/{model.pt, classes.json}
                          │
   services/recognizer/serve.py ─► POST /recognize ─► {label, archetype, element, confidence}
                          │
   js/ai.js  DS.AI.connectRecognizer('<url>/recognize')  +  DS.AI.recognize(strokes)
```

## §1 Dataset (anywhere with Python + numpy + internet)
```bash
pip install numpy
python data/get_quickdraw.py --per-class 8000 --out data/quickdraw
```
Downloads the classes in `services/recognizer/config.CATEGORIES` from Google's public QuickDraw bucket,
**skipping any class name that 404s** (the surviving list is saved to `classes.json`). ~25 classes ×
8k = 200k 28×28 bitmaps. Edit `config.CATEGORIES` to add/cut classes (each maps to a game
label/archetype/element).

## §2 Train (Trainium / Colab GPU / CPU — auto-detected)
- **Trainium box** (the deliverable): `source` the neuron venv (torch_xla present), then:
  ```bash
  pip install numpy
  python train/train_recognizer.py --data data/quickdraw --output_dir recognizer_model --epochs 8
  ```
  It prints `device=xla`. The CNN is plain PyTorch → it just works on Trainium; `model.pt` is a normal
  state_dict (no consolidation).
- **Colab GPU / CPU**: same command (prints `device=cuda`/`cpu`). Trains in minutes; QuickDraw CNNs
  hit ~90%+ val accuracy easily.

Output: `recognizer_model/model.pt` + `classes.json`. Expect `val_acc` climbing past ~0.9.

## §3 Serve (CPU — instant)
```bash
pip install -r train/requirements-recognizer.txt   # numpy pillow starlette uvicorn
cd services/recognizer && python serve.py --model ../../recognizer_model --port 8600
# sanity (on the box):
curl -s localhost:8600/healthz
curl -s localhost:8600/recognize -H 'content-type: application/json' -d '{"pixels":[ ...784 floats... ]}'
```
Returns `{"results":[{category,label,archetype,element,confidence}...], "confident":bool, "top":{...}}`.
`confident` is false when top-1 < `config.CONF_THRESHOLD` (0.40) → the game should fall back to a
top-3 chooser or a manual pick instead of guessing.

Expose `:8600` like the others (cloudflared quick tunnel), then in the game console:
```js
DS.AI.connectRecognizer('https://<tunnel>/recognize')
```

## §4 Wire into the draw flow
`DS.AI.recognize(strokes)` rasterizes the strokes to 28×28 (white ink on black = QuickDraw polarity)
and resolves to the recognizer response. The draw/spawn path uses `top.label` instead of a picked
category — e.g.:
```js
DS.AI.recognize(strokes).then(function (r) {
  var label = (r && r.confident) ? r.top.label : promptUserToPick();   // fall back when unsure
  DS.AI.spawnFromStrokes(strokes, label, x, y);                        // CAELLUM + CHLOE take it from here
});
```
Progressive-enhancement option: spawn immediately with a placeholder label, recognize in parallel, and
update the label when it returns (re-triggers CAELLUM/CHLOE with the real name).

## §5 Fallback ladder
trained CNN (confident) → top-3 chooser (unsure) → manual category pick (no recognizer). The game is
fully playable at every rung; the recognizer just removes the "tell us what you drew" step.
