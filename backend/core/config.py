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

    #_____________апдейт_______ Prompt transformer config
    PROMPT_TRANSFORM_ENABLED: bool = os.getenv("PROMPT_TRANSFORM_ENABLED", "false").lower() == "true"
    PROMPT_TRANSFORM_TIMEOUT_MS: int = int(os.getenv("PROMPT_TRANSFORM_TIMEOUT_MS", "1500"))
    PROMPT_TRANSFORM_PROVIDER: str = os.getenv("PROMPT_TRANSFORM_PROVIDER", "stub")
    #_____________апдейт_______ Strict mode and merge policy
    PROMPT_TRANSFORM_STRICT: bool = os.getenv("PROMPT_TRANSFORM_STRICT", "true").lower() == "true"
    PROMPT_NEGATIVE_MERGE_POLICY: str = os.getenv("PROMPT_NEGATIVE_MERGE_POLICY", "append")

    #_____________апдейт_______ GGUF + LoRA LLM runtime config
    LLM_MODEL_PATH: str = os.getenv("LLM_MODEL_PATH", str(BASE_DIR / "models" / "llm" / "model.gguf"))
    LLM_LORA_PATH: str = os.getenv("LLM_LORA_PATH", str(BASE_DIR / "models" / "llm" / "adapter.gguf"))
    LLM_LORA_SCALE: float = float(os.getenv("LLM_LORA_SCALE", "1.0"))
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
    MAX_CACHED_MODELS: int = 2    # Max pipelines kept in RAM (LRU eviction)

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
