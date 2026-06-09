import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Presets & configuration
STYLE_PRESETS = {
    "Cinematic": "cinematic shot, dynamic lighting, 8k resolution, highly detailed, shallow depth of field, bokeh",
    "Anime": "masterpiece, anime style, key visual, vibrant colors, studio ghibli style",
    "Digital Art": "concept art, digital painting, smooth, sharp focus, artstation",
    "Photographic": "raw photo, realistic, 8k, dslr, soft lighting"
}

class Settings:
    # Service Info
    PROJECT_NAME: str = "Local AI Gen Service"
    VERSION: str = "0.1.0"
    
    # Paths
    BASE_DIR: Path = Path(__file__).parent.parent
    OUTPUT_DIR: Path = BASE_DIR / "static" / "outputs"
    MODELS_DIR: Path = BASE_DIR / "models" / "Stable-diffusion"
    
    # Model Configuration
    DEFAULT_MODEL_ID: str = os.getenv("DEFAULT_MODEL_ID", "runwayml/stable-diffusion-v1-5")
    DEVICE: str = "cuda" if os.getenv("USE_CUDA", "true").lower() == "true" else "cpu"
    SD_ENABLE_CPU_OFFLOAD: bool = os.getenv("SD_ENABLE_CPU_OFFLOAD", "true").lower() == "true"
    # Attention backend: torch SDPA is the diffusers default on torch>=2.0 and is
    # usually as fast as xformers without the extra dependency, so xformers is
    # opt-in. Enable only if you have a matching xformers build installed.
    SD_ENABLE_XFORMERS: bool = os.getenv("SD_ENABLE_XFORMERS", "false").lower() == "true"
    # TF32 accelerates fp32 matmul/conv on Ampere+ tensor cores (e.g. the fp32
    # VAE upcast) with no visible quality loss for diffusion. No-op on older GPUs.
    SD_ALLOW_TF32: bool = os.getenv("SD_ALLOW_TF32", "true").lower() == "true"
    # Runtime precision: "auto" picks bf16 on Ampere+ (same exponent range as
    # fp32 -> far fewer black/NaN VAE outputs) and fp16 on older GPUs. Override
    # with fp16 / bf16 / fp32.
    SD_TORCH_DTYPE: str = os.getenv("SD_TORCH_DTYPE", "auto").strip().lower()
    NSFW_FILTER_ENABLED: bool = os.getenv("NSFW_FILTER_ENABLED", "true").lower() == "true"
    NSFW_NEGATIVE_PROMPT: str = os.getenv(
        "NSFW_NEGATIVE_PROMPT",
        "nsfw, nude, naked, explicit, erotic, porn, sex, uncensored, nipples, breasts, genitalia",
    )
    CLIP_SKIP: int = max(1, int(os.getenv("CLIP_SKIP", "1")))
    LIVE_PREVIEW_METHOD: str = os.getenv("LIVE_PREVIEW_METHOD", "approx_nn").strip().lower()
    LIVE_PREVIEW_INTERVAL_STEPS: int = max(1, int(os.getenv("LIVE_PREVIEW_INTERVAL_STEPS", "4")))
    CIVITAI_API_TOKEN: str = os.getenv("CIVITAI_API_TOKEN", "").strip()
    HF_TOKEN: str = os.getenv("HF_TOKEN", "").strip()

    #_____________апдейт_______ Prompt transformer config
    PROMPT_TRANSFORM_ENABLED: bool = os.getenv("PROMPT_TRANSFORM_ENABLED", "false").lower() == "true"
    PROMPT_TRANSFORM_TIMEOUT_MS: int = int(os.getenv("PROMPT_TRANSFORM_TIMEOUT_MS", "1500"))
    PROMPT_TRANSFORM_PROVIDER: str = os.getenv("PROMPT_TRANSFORM_PROVIDER", "stub")
    #_____________апдейт_______ Strict mode and merge policy
    PROMPT_TRANSFORM_STRICT: bool = os.getenv("PROMPT_TRANSFORM_STRICT", "true").lower() == "true"
    PROMPT_NEGATIVE_MERGE_POLICY: str = os.getenv("PROMPT_NEGATIVE_MERGE_POLICY", "append")
    PROMPT_TRANSFORM_UNLOAD_AFTER_CALL: bool = os.getenv(
        "PROMPT_TRANSFORM_UNLOAD_AFTER_CALL",
        "true",
    ).lower() == "true"
    NEG_PROMPT_TRANSFORM_ENABLED: bool = os.getenv("NEG_PROMPT_TRANSFORM_ENABLED", "false").lower() == "true"
    NEG_PROMPT_TRANSFORM_TIMEOUT_MS: int = int(os.getenv("NEG_PROMPT_TRANSFORM_TIMEOUT_MS", "1500"))
    NEG_PROMPT_TRANSFORM_PROVIDER: str = os.getenv("NEG_PROMPT_TRANSFORM_PROVIDER", "stub")
    NEG_PROMPT_TRANSFORM_STRICT: bool = os.getenv("NEG_PROMPT_TRANSFORM_STRICT", "true").lower() == "true"
    NEG_PROMPT_TRANSFORM_UNLOAD_AFTER_CALL: bool = os.getenv("NEG_PROMPT_TRANSFORM_UNLOAD_AFTER_CALL", "true").lower() == "true"
    PROMPT_TRANSFORM_QUEUE_MODE: str = os.getenv("PROMPT_TRANSFORM_QUEUE_MODE", "wait")
    PROMPT_TRANSFORM_MAX_WAIT_MS: int = int(os.getenv("PROMPT_TRANSFORM_MAX_WAIT_MS", "20000"))

    #_____________апдейт_______ GGUF + LoRA LLM runtime config
    LLM_MODEL_PATH: str = os.getenv("LLM_MODEL_PATH", str(BASE_DIR / "models" / "llm" / "model.gguf"))
    LLM_LORA_PATH: str = os.getenv("LLM_LORA_PATH", str(BASE_DIR / "models" / "llm" / "adapter.gguf"))
    LLM_LORA_SCALE: float = float(os.getenv("LLM_LORA_SCALE", "1.0"))
    LLM_POSITIVE_LORA_PATH: str = os.getenv("LLM_POSITIVE_LORA_PATH", os.getenv("LLM_LORA_PATH", ""))
    LLM_NEGATIVE_LORA_PATH: str = os.getenv("LLM_NEGATIVE_LORA_PATH", "")
    LLM_POSITIVE_LORA_SCALE: float = float(os.getenv("LLM_POSITIVE_LORA_SCALE", os.getenv("LLM_LORA_SCALE", "1.0")))
    LLM_NEGATIVE_LORA_SCALE: float = float(os.getenv("LLM_NEGATIVE_LORA_SCALE", "1.0"))
    LLM_CTX_SIZE: int = int(os.getenv("LLM_CTX_SIZE", "4096"))
    LLM_THREADS: int = int(os.getenv("LLM_THREADS", "6"))
    LLM_GPU_LAYERS: int = int(os.getenv("LLM_GPU_LAYERS", "0"))
    LLM_MAX_NEW_TOKENS: int = int(os.getenv("LLM_MAX_NEW_TOKENS", "220"))
    LLM_TEMPERATURE: float = float(os.getenv("LLM_TEMPERATURE", "0.2"))
    LLM_TOP_P: float = float(os.getenv("LLM_TOP_P", "0.9"))
    LLM_SYSTEM_PROMPT: str = os.getenv(
        "LLM_SYSTEM_PROMPT",
        "You are a Stable Diffusion prompt transformer. "
        "Return ONLY strict JSON with keys: "
        "positive_prompt (string), negative_prompt_extra (string), style_tags (array of strings).",
    )
    
    # Generation Defaults
    DEFAULT_STEPS: int = 20
    DEFAULT_GUIDANCE_SCALE: float = 7.5
    DEFAULT_WIDTH: int = 512
    DEFAULT_HEIGHT: int = 512

    # Cleanup Policy
    MAX_STORED_IMAGES: int = 100  # Number of images to keep before cleanup
    MAX_CACHED_MODELS: int = 2    # Max underlying model bundles kept in RAM (LRU eviction)

    # CORS
    CORS_ALLOW_ORIGINS: list[str] = [
        origin.strip()
        for origin in os.getenv(
            "CORS_ALLOW_ORIGINS",
            "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173",
        ).split(",")
        if origin.strip()
    ]
    CORS_ALLOW_ORIGIN_REGEX: str = os.getenv(
        "CORS_ALLOW_ORIGIN_REGEX",
        r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    )

    def __init__(self):
        # Ensure output directory exists
        self.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

settings = Settings()
