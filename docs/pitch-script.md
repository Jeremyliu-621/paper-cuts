# Paper Cuts — Tech-Stack Pitch (voiceover, ~4 min)

Pace ~150 wpm. `[SHOW]` = what to be on screen (the app feature, or the stack diagram layer) while you say it.

---

**[0:00 — Hook]**
`[SHOW: the live game — draw something, watch it drop into the match]`

This is **Paper Cuts**. You draw on paper, and it becomes a playable game — no engine, no menus, no code. A kid sketches a sword, and two seconds later it's a real weapon in a live physics match. What looks like a children's doodle is actually a **real-time, multi-model AI pipeline** running behind a deliberately childlike surface. Let me walk you through the stack.

**[0:30 — The surface]**
`[SHOW: iPad drawing surface → the game canvas]`

The drawing surface is a **React, Vite, and tldraw** app — freehand strokes, shapes, and labels with full touch support. The game itself is hand-built in **vanilla JavaScript on an HTML5 Canvas** — we own the render loop, the camera, the physics, the hitboxes, and the particles, with **procedural marker-and-paper rendering** so every stroke feels drawn, not templated. Phones join over **QR codes** as gamepads — or as **projector pens** that draw straight into the shared scene — all synchronized through a **Node WebSocket relay** with **cross-device coordinate reconciliation**.

**[1:05 — AI engine room: Recognizer]**
`[SHOW: draw a shape → it gets named]`

Behind that is a small fleet of cooperating models. First, **perception**. Our **Recognizer** is a multi-tier stack: a custom-trained **convolutional neural net** for the fast path, an **open-vocabulary vision-language model** for true draw-anything recognition, and **retrieval-augmented recognition** over a vector memory — more on that in a second.

**[1:35 — Caecae (visual model)]**
`[SHOW: rough doodle → clean sprite swap]`

Next, **synthesis**. Our visual model — **Caecae** — turns a shaky doodle into a clean, flat, game-ready sprite while preserving the original shape. It's a **layered diffusion pipeline**: an **SD1.5 floor compile** guaranteed to build, an **SDXL primary** compiled in parallel for fidelity, a **teacher dataset distilled on Colab**, an **InstructPix2Pix** instruction fine-tune conditioned on a **semantic label hint**, then we **fuse the best base**, serve, and keep tuning. Output is a **raster sprite** with **rembg** background matting — trained on **AWS Trainium**.

**[2:20 — Moose (mechanic composer)]**
`[SHOW: drawn flame becomes a fire projectile, burns through a vine]`

Then, **mechanics**. **Moose** is a **neuro-symbolic composer**. A **LoRA-tuned** model proposes what a drawing should *do*, but a **safe-by-construction operation graph** guarantees the result is always a valid, balanced, non-crashing mechanic. Elemental interactions — fire melts ice, fire burns through vines — fall straight out of an **element-tag algebra**. AI creativity, with deterministic guarantees.

**[2:50 — Paper Trail (Redis)]**
`[SHOW: draw the same thing again, instant recognition]`

All of that feeds **Paper Trail** — our **Redis brain**. Every doodle is embedded and written into a **Redis Stack RediSearch HNSW vector index**. New drawings are recognized by **k-NN vector search** over the community's collective memory — that's **retrieval-augmented recognition** — so the system gets smarter and cheaper the more people play. Redis here isn't a cache; it's **vector search and agent memory**.

**[3:20 — Finishers + close]**
`[SHOW: the fire-finisher KO cinematic]`

And for spectacle, **generative cinematic finishers** — KO sequences synthesized with **Pika on fal.ai**, styled to your characters. So: a vanilla-canvas engine, a four-model AI fleet, **diffusion fine-tuning on Trainium**, a **Redis vector memory**, **generative video**, and **real-time multi-device sync** — all so a kid can draw something and instantly play it. That's **Paper Cuts**: a bridge from imagination to interaction.

---

**Delivery tips:** breathe between sections (the `[SHOW]` swaps are natural pauses); punch the model names — *Caecae, Moose, Paper Trail* — they make it sound like a real platform; if you run long, the surface section (0:30) is the safest trim.
