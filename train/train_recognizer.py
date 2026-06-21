#!/usr/bin/env python
"""
RECOGNIZER — train the freeform doodle CNN (Trainium XLA / CUDA / CPU).

A tiny convnet over 28x28 QuickDraw bitmaps -> class logits. Plain PyTorch, so it trains cleanly on
Trainium via torch_xla (the "PyTorch on Trainium" deliverable — a CNN has NO LoRA/sharding, so NONE
of the consolidation pain CHLOE hit) and saves a normal state_dict that serves on CPU.

SELF-CONTAINED: reads data/quickdraw/quickdraw.npz + classes.json (from data/get_quickdraw.py).

ENV (pick one — auto-detected):
    Trainium box:  source the neuron venv; torch_xla is present -> device=xla
    Colab/GPU:     pip install torch ; device=cuda
    anywhere:      device=cpu (the dataset is small; still trains in minutes)

    python train/train_recognizer.py --data data/quickdraw --output_dir recognizer_model --epochs 8
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


class DoodleCNN(nn.Module):
    """2 conv blocks + 2 fc. ~0.5M params — instant inference, trains in minutes."""

    def __init__(self, n_classes: int):
        super().__init__()
        self.c1 = nn.Conv2d(1, 32, 3, padding=1)
        self.c2 = nn.Conv2d(32, 64, 3, padding=1)
        self.fc1 = nn.Linear(64 * 7 * 7, 128)
        self.fc2 = nn.Linear(128, n_classes)
        self.drop = nn.Dropout(0.3)

    def forward(self, x):
        x = F.max_pool2d(F.relu(self.c1(x)), 2)   # 28 -> 14
        x = F.max_pool2d(F.relu(self.c2(x)), 2)   # 14 -> 7
        x = x.flatten(1)
        x = self.drop(F.relu(self.fc1(x)))
        return self.fc2(x)


def pick_device(want: str):
    if want in ("auto", "xla"):
        try:
            import torch_xla.core.xla_model as xm  # noqa: F401
            return "xla"
        except Exception:
            if want == "xla":
                raise
    if (want in ("auto", "cuda")) and torch.cuda.is_available():
        return "cuda"
    return "cpu"


def main() -> None:
    ap = argparse.ArgumentParser(description="Train the doodle recognizer CNN.")
    ap.add_argument("--data", default="data/quickdraw")
    ap.add_argument("--output_dir", default="recognizer_model")
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--batch_size", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--device", default="auto", choices=["auto", "xla", "cuda", "cpu"])
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    torch.manual_seed(args.seed)

    dev_kind = pick_device(args.device)
    if dev_kind == "xla":
        import torch_xla.core.xla_model as xm
        device = xm.xla_device()
    else:
        device = torch.device(dev_kind)
    print(f"[env] device={dev_kind} ({device})")

    blob = np.load(os.path.join(args.data, "quickdraw.npz"))
    with open(os.path.join(args.data, "classes.json")) as f:
        classes = json.load(f)["classes"]
    Xtr = torch.from_numpy(blob["X_train"]).float().div_(255).unsqueeze(1)   # (N,1,28,28)
    ytr = torch.from_numpy(blob["y_train"]).long()
    Xva = torch.from_numpy(blob["X_val"]).float().div_(255).unsqueeze(1)
    yva = torch.from_numpy(blob["y_val"]).long()
    print(f"[data] {len(Xtr)} train / {len(Xva)} val | {len(classes)} classes")

    model = DoodleCNN(len(classes)).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    n = len(Xtr)

    for epoch in range(args.epochs):
        model.train()
        perm = torch.randperm(n)
        total, seen = 0.0, 0
        for i in range(0, n, args.batch_size):
            idx = perm[i:i + args.batch_size]
            xb, yb = Xtr[idx].to(device), ytr[idx].to(device)
            opt.zero_grad()
            loss = F.cross_entropy(model(xb), yb)
            loss.backward()
            if dev_kind == "xla":
                import torch_xla.core.xla_model as xm
                xm.optimizer_step(opt)
            else:
                opt.step()
            total += float(loss) * len(idx); seen += len(idx)
        # validation accuracy
        model.eval()
        correct = 0
        with torch.no_grad():
            for i in range(0, len(Xva), 1024):
                xb = Xva[i:i + 1024].to(device); yb = yva[i:i + 1024].to(device)
                correct += int((model(xb).argmax(1) == yb).sum())
        acc = correct / max(1, len(Xva))
        print(f"[epoch {epoch + 1}/{args.epochs}] loss={total / seen:.4f}  val_acc={acc:.3f}")

    os.makedirs(args.output_dir, exist_ok=True)
    torch.save(model.to("cpu").state_dict(), os.path.join(args.output_dir, "model.pt"))
    with open(os.path.join(args.output_dir, "classes.json"), "w") as f:
        json.dump({"classes": classes, "img_size": 28}, f, indent=2)
    print(f"[done] model -> {args.output_dir}/model.pt  (+ classes.json)")
    print(f"[done] serve it: python serve.py --model {args.output_dir}")


if __name__ == "__main__":
    main()
