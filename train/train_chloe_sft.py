#!/usr/bin/env python
"""
CHLOE — SFT-LoRA fine-tune of the bounded mechanic-spec student (Trainium / Neuron box).

ENV: the AWS Neuron / Trainium box ONLY, inside the workshop venv:
        source /opt/aws_neuronx_venv_pytorch/bin/activate   # aws_neuronx_venv_pytorch
     (torch-neuronx, neuronx-cc, torch_xla come PRE-INSTALLED there). NO CUDA. This script
     `import config`, so run it from inside `services/chloe/` OR add that dir to PYTHONPATH so
     the single-source-of-truth NODES / SYSTEM_PROMPT / node_menu() are the SAME ones the
     dataset + serve sides use. CHLOE outputs a JSON mechanic SPEC (a node + clamped params),
     never code — this just teaches the small student to emit that JSON.

What it does
------------
Supervised fine-tune (SFT) with a PEFT LoRA adapter on config.BASE_MODEL
(Qwen/Qwen2.5-1.5B-Instruct) over data/chloe_pairs.jsonl, using optimum-neuron's
NeuronSFTTrainer + NeuronSFTConfig. Each jsonl row is a chat conversation
(system / user description / assistant clamped-JSON spec); we render it with the
tokenizer's `apply_chat_template` so the ASSISTANT spec string is the completion the
model learns to produce. The trained LoRA adapter is saved to --output_dir (default
chloe_lora) for the serve side (services/chloe/serve.py --backend local) to load on top
of the base model.

Adapted from the official optimum-neuron LLM SFT-LoRA tutorial:
    https://huggingface.co/docs/optimum-neuron/training_tutorials/sft_lora_finetune_llm
    (optimum-neuron/docs examples: sft_lora_finetune_llm.py)

Data format (one JSON object per line, written by data/gen_chloe_dataset.py):
    {"messages": [
        {"role": "system",    "content": "<SYSTEM_PROMPT>\\n\\n<node_menu()>"},
        {"role": "user",      "content": "a heavy slow cannon"},
        {"role": "assistant", "content": "{\\"node\\":\\"projectile_weapon\\",\\"params\\":{...},...}"}
    ]}
The assistant content is already a CLAMPED spec string, so the training targets are valid.

Example invocation (from services/chloe/, inside aws_neuronx_venv_pytorch)
--------------------------------------------------------------------------
    # single NeuronCore:
    python ../../train/train_chloe_sft.py \
        --data ../../data/chloe_pairs.jsonl \
        --output_dir chloe_lora \
        --max_steps 1000

    # or use the Neuron launcher across cores (recommended for Trainium):
    torchrun --nproc_per_node=2 ../../train/train_chloe_sft.py --max_steps 1000

After training, fuse/serve:
    python serve.py --backend local --adapter chloe_lora
"""

from __future__ import annotations

import argparse

# config is the single source of truth (BASE_MODEL, SYSTEM_PROMPT, node_menu, NODES).
# This script lives in train/, so Python puts train/ (not services/chloe) on sys.path when run
# by path. Add services/chloe explicitly so `import config` resolves from anywhere.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "chloe"))
import config

from datasets import load_dataset
from peft import LoraConfig
from transformers import AutoTokenizer

# optimum-neuron's Trainium-aware SFT trainer + config. From the sft_lora_finetune_llm tutorial.
from optimum.neuron import NeuronSFTConfig, NeuronSFTTrainer


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="CHLOE SFT-LoRA fine-tune on Trainium (NeuronSFTTrainer)."
    )
    p.add_argument(
        "--data",
        type=str,
        default="data/chloe_pairs.jsonl",
        help="path to the SFT chat jsonl from data/gen_chloe_dataset.py (default: data/chloe_pairs.jsonl)",
    )
    p.add_argument(
        "--model",
        type=str,
        default=config.BASE_MODEL,
        help=f"base instruct LLM to LoRA-tune (default from config: {config.BASE_MODEL})",
    )
    p.add_argument(
        "--output_dir",
        type=str,
        default="chloe_lora",
        help="where to save the trained LoRA adapter (default: chloe_lora)",
    )
    p.add_argument("--max_steps", type=int, default=1000, help="total optimizer steps (default: 1000)")
    p.add_argument("--lr", type=float, default=1e-4, help="learning rate (default: 1e-4)")
    p.add_argument(
        "--batch_size", type=int, default=1, help="per-device train batch size (default: 1)"
    )
    p.add_argument(
        "--gradient_accumulation_steps",
        type=int,
        default=8,
        help="grad-accum steps (effective batch = batch_size * accum * world; default: 8)",
    )
    p.add_argument("--max_seq_len", type=int, default=1024, help="max sequence length (default: 1024)")
    # LoRA hyperparameters — modest rank is plenty for this bounded JSON-emitting task.
    p.add_argument("--lora_r", type=int, default=16, help="LoRA rank r (default: 16)")
    p.add_argument("--lora_alpha", type=int, default=32, help="LoRA alpha (default: 32)")
    p.add_argument("--lora_dropout", type=float, default=0.05, help="LoRA dropout (default: 0.05)")
    p.add_argument("--warmup_steps", type=int, default=20, help="LR warmup steps (default: 20)")
    p.add_argument("--logging_steps", type=int, default=10, help="log every N steps (default: 10)")
    p.add_argument("--seed", type=int, default=42, help="random seed (default: 42)")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    print(f"[args] {vars(args)}")

    # --- tokenizer: drives the chat template that turns each row into one training example ---
    print(f"[load] tokenizer for {args.model}")
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    # Causal-LM SFT needs a pad token; Qwen2.5 has one, but fall back to eos defensively so
    # padding never silently breaks if a base without pad_token is swapped in via --model.
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # --- dataset: one JSON object per line, each with a "messages" chat list ---
    print(f"[data] loading SFT pairs from {args.data}")
    dataset = load_dataset("json", data_files=args.data, split="train")
    print(f"[data] {len(dataset)} chat rows")

    def format_row(example: dict) -> str:
        """Render one chat row to a single training string via the tokenizer's chat template.

        apply_chat_template with add_generation_prompt=False emits the FULL conversation —
        the assistant's clamped JSON spec is included as the completion the model learns to
        produce. We hand the trainer the formatted TEXT (formatting_func), and it tokenizes +
        builds the LM labels itself.
        """
        return tokenizer.apply_chat_template(
            example["messages"],
            tokenize=False,
            add_generation_prompt=False,
        )

    # --- LoRA config (peft): adapt the attention + MLP projections of the Qwen2 decoder ---
    lora_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
    )

    # --- NeuronSFTConfig: SFTConfig fields + Neuron/XLA training args ---
    # bf16 is the native Trainium dtype. gradient_checkpointing keeps the 1.5B model in memory
    # at seq_len=1024. We point save/output at --output_dir and pass the formatting + seq-len
    # knobs straight to the SFT machinery.
    sft_config = NeuronSFTConfig(
        output_dir=args.output_dir,
        do_train=True,
        max_steps=args.max_steps,
        learning_rate=args.lr,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        gradient_checkpointing=True,
        warmup_steps=args.warmup_steps,
        logging_steps=args.logging_steps,
        max_length=args.max_seq_len,  # trl 0.24 renamed max_seq_length -> max_length
        packing=False,  # one chat row == one example; do not pack across descriptions
        bf16=True,
        save_steps=args.max_steps,  # one save at the end -> --output_dir
        seed=args.seed,
    )

    # NeuronSFTTrainer loads the model itself via from_pretrained(model_id, **model_init_kwargs),
    # and its (training) model class REQUIRES `trn_config` — which NeuronSFTConfig built in its
    # __post_init__. Hand it through model_init_kwargs so the trainer's own (correct) loader gets it.
    sft_config.model_init_kwargs = {"trn_config": sft_config.trn_config}

    # --- the trainer: passes the LoRA config through to PEFT, formats each row via our func ---
    print(f"[train] base={args.model} | steps={args.max_steps} | "
          f"effective_batch={args.batch_size * args.gradient_accumulation_steps} (x world) | "
          f"seq_len={args.max_seq_len}")
    trainer = NeuronSFTTrainer(
        model=args.model,
        processing_class=tokenizer,  # trl 0.24 renamed the `tokenizer` arg -> `processing_class`
        train_dataset=dataset,
        peft_config=lora_config,
        formatting_func=format_row,
        args=sft_config,
    )

    trainer.train()

    # --- save the LoRA adapter (adapter_config.json + adapter_model.safetensors) to output_dir ---
    print(f"[save] writing LoRA adapter -> {args.output_dir}")
    trainer.save_model(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    print(f"[done] LoRA adapter saved to {args.output_dir}")
    print("[done] serve it: python serve.py --backend local --adapter "
          f"{args.output_dir}  (loads on top of {args.model})")


if __name__ == "__main__":
    main()
