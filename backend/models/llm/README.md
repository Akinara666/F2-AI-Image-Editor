# LLM Models

Place your `llama-cpp-python` compatible GGUF models in this directory.

Default config expects:
- `model.gguf` for the base prompt model (e.g., Qwen 3 1.7B).
- `adapter.gguf` for any LoRA weights adapters.

If you don't use these files, you can override the paths in environment variables (`LLM_MODEL_PATH`, `LLM_LORA_PATH`).

Example download for `Qwen3-1.7B-Q8_0.gguf`:

```bash
mkdir -p backend/models/llm
cd backend/models/llm
wget -O model.gguf "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf?download=true"
```
