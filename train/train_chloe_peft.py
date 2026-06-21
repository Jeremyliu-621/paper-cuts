#!/usr/bin/env python
"""
CHLOE — no-Neuron PEFT SFT-LoRA of the mechanic-graph student (Colab CUDA / any GPU / CPU).

WHY THIS EXISTS: the Trainium NeuronSFTTrainer saves a SHARDED adapter whose consolidator is broken
for this Qwen3 LoRA (optimum-neuron 0.4.3 fused-MLP bug), so the served `--backend local` can't load
it. This trainer uses VANILLA transformers + peft, so `model.save_pretrained()` writes a standard
`adapter_config.json` + `adapter_model.safetensors` that services/chloe/serve.py loads DIRECTLY via
PeftModel.from_pretrained — zero consolidation. The Trainium run still stands as the "trained on
Trainium" deliverable; this is the serving copy (and you can train it longer/better here).

SELF-CONTAINED: the system prompt + clamped targets are baked into the jsonl rows
(data/chloe_graph_pairs.jsonl from data/gen_chloe_graph_dataset.py), so this script does NOT import
the repo — drop it on a fresh Colab next to the jsonl and run.

ENV: CUDA Colab/Kaggle (fast) or CPU (slow but works). NOT the Neuron box.
    pip install -U "transformers>=4.45" "peft>=0.13" "datasets>=2.20" "accelerate>=0.34" safetensors sentencepiece
    python train_chloe_peft.py --data chloe_graph_pairs.jsonl --output_dir chloe_graph_lora --epochs 3

After training, copy chloe_graph_lora/ to the box and:
    python serve.py --backend local --lora-dir chloe_graph_lora
"""
from __future__ import annotations

import argparse

import torch
from datasets import load_dataset
from peft import LoraConfig, get_peft_model
from transformers import (AutoModelForCausalLM, AutoTokenizer,
                          DataCollatorForLanguageModeling, Trainer, TrainingArguments)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="CHLOE graph SFT-LoRA (vanilla peft, no Neuron).")
    p.add_argument("--data", default="chloe_graph_pairs.jsonl", help="SFT chat jsonl (messages rows)")
    p.add_argument("--model", default="Qwen/Qwen3-0.6B", help="base instruct LLM to LoRA-tune")
    p.add_argument("--output_dir", default="chloe_graph_lora", help="where to save the adapter")
    p.add_argument("--epochs", type=float, default=3.0)
    p.add_argument("--max_steps", type=int, default=-1, help="override epochs if > 0")
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--batch_size", type=int, default=8)
    p.add_argument("--gradient_accumulation_steps", type=int, default=2)
    p.add_argument("--max_seq_len", type=int, default=1024)
    p.add_argument("--lora_r", type=int, default=16)
    p.add_argument("--lora_alpha", type=int, default=32)
    p.add_argument("--lora_dropout", type=float, default=0.05)
    p.add_argument("--logging_steps", type=int, default=20)
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


def main() -> None:
    args = parse_args()
    print(f"[args] {vars(args)}")
    cuda = torch.cuda.is_available()
    print(f"[env] cuda={cuda} device={'cuda' if cuda else 'cpu'}")

    # --- tokenizer (drives the chat template) ---
    tok = AutoTokenizer.from_pretrained(args.model)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    # --- dataset: each row is {"messages":[system,user,assistant]} -> one training string ---
    ds = load_dataset("json", data_files=args.data, split="train")
    print(f"[data] {len(ds)} rows from {args.data}")

    def tokenize(ex):
        text = tok.apply_chat_template(ex["messages"], tokenize=False, add_generation_prompt=False)
        return tok(text, truncation=True, max_length=args.max_seq_len)

    ds = ds.map(tokenize, remove_columns=ds.column_names, desc="tokenizing")

    # --- base model + LoRA ---
    model = AutoModelForCausalLM.from_pretrained(
        args.model, torch_dtype=torch.bfloat16 if cuda else torch.float32)
    model.config.use_cache = False
    lora = LoraConfig(
        r=args.lora_r, lora_alpha=args.lora_alpha, lora_dropout=args.lora_dropout,
        bias="none", task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    # causal-LM collator: pads + sets labels=input_ids (-100 on pad). Trains on the full sequence.
    collator = DataCollatorForLanguageModeling(tok, mlm=False)

    targs = TrainingArguments(
        output_dir=args.output_dir,
        num_train_epochs=args.epochs,
        max_steps=args.max_steps,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        logging_steps=args.logging_steps,
        save_strategy="no",            # one explicit save at the end -> output_dir
        bf16=cuda, fp16=False,
        seed=args.seed,
        report_to="none",
    )
    trainer = Trainer(model=model, args=targs, train_dataset=ds, data_collator=collator)
    trainer.train()

    # --- save the adapter (standard peft format: adapter_config.json + adapter_model.safetensors) ---
    model.save_pretrained(args.output_dir)
    tok.save_pretrained(args.output_dir)
    print(f"[done] adapter -> {args.output_dir}")
    print(f"[done] serve it: python serve.py --backend local --lora-dir {args.output_dir}")


if __name__ == "__main__":
    main()
