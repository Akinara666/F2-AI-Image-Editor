# LLM Models

Place your `llama-cpp-python` compatible GGUF models in this directory.

Default config expects:
- `model.gguf` for the base prompt model (e.g., Qwen 3 1.7B).
- `adapter.gguf` for any LoRA weights adapters.

If you don't use these files, you can override the paths in environment variables (`LLM_MODEL_PATH`, `LLM_LORA_PATH`).
