#!/usr/bin/env python3
"""
RECOGNIZER dataset — download Google QuickDraw bitmaps for our classes and build a train/val set.

QuickDraw publishes per-class 28x28 numpy bitmaps in a public GCS bucket. We fetch the classes in
services/recognizer/config.CATEGORIES (skipping any name that 404s), subsample each to keep it
balanced, shuffle, split, and save a single .npz + classes.json that train/train_recognizer.py reads.

    get_quickdraw.py  ──download──►  data/quickdraw/{quickdraw.npz, classes.json}
                                                  │
    train/train_recognizer.py (tiny CNN, Trainium/CUDA/CPU)  ──►  recognizer_model/

ENV: anything with Python + numpy + internet (no GPU). Run BEFORE training.

    python data/get_quickdraw.py --per-class 8000 --out data/quickdraw
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "recognizer"))
sys.path.insert(0, str(Path(__file__).resolve().parent))   # Colab: config.py uploaded next to this script
import config  # noqa: E402

BUCKET = "https://storage.googleapis.com/quickdraw_dataset/full/numpy_bitmap/{}.npy"


def fetch_class(name: str) -> "np.ndarray | None":
    """Download one class's (N, 784) uint8 bitmaps. Returns None if the class isn't in the bucket."""
    url = BUCKET.format(urllib.parse.quote(name))
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            data = r.read()
    except Exception as e:  # 404 / network -> skip this class
        print(f"  [skip] {name!r}: {e}")
        return None
    arr = np.load(io.BytesIO(data))
    return arr  # (N, 784) uint8


def main() -> None:
    ap = argparse.ArgumentParser(description="Download QuickDraw bitmaps for the recognizer.")
    ap.add_argument("--per-class", type=int, default=8000, help="max samples per class (balanced)")
    ap.add_argument("--out", default="data/quickdraw")
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)

    xs, ys, classes = [], [], []
    for name in config.quickdraw_classes():
        arr = fetch_class(name)
        if arr is None or len(arr) == 0:
            continue
        n = min(args.per_class, len(arr))
        idx = rng.choice(len(arr), size=n, replace=False)
        cls_id = len(classes)
        classes.append(name)
        xs.append(arr[idx].reshape(-1, config.IMG_SIZE, config.IMG_SIZE).astype(np.uint8))
        ys.append(np.full(n, cls_id, dtype=np.int64))
        print(f"  [ok]   {name!r}: {n} samples (class {cls_id})")

    if not classes:
        raise SystemExit("No classes downloaded — check your network / QuickDraw class names.")

    X = np.concatenate(xs)
    y = np.concatenate(ys)
    perm = rng.permutation(len(X))
    X, y = X[perm], y[perm]
    n_val = int(len(X) * args.val_frac)
    os.makedirs(args.out, exist_ok=True)
    np.savez_compressed(os.path.join(args.out, "quickdraw.npz"),
                        X_train=X[n_val:], y_train=y[n_val:], X_val=X[:n_val], y_val=y[:n_val])
    with open(os.path.join(args.out, "classes.json"), "w") as f:
        json.dump({"classes": classes, "img_size": config.IMG_SIZE}, f, indent=2)

    print(f"\n[quickdraw] {len(classes)} classes, {len(X)} samples "
          f"({len(X) - n_val} train / {n_val} val) -> {args.out}/quickdraw.npz")
    print(f"[quickdraw] classes: {classes}")


if __name__ == "__main__":
    main()
