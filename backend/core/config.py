import os
from pathlib import Path

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
    
    # Generation Defaults
    DEFAULT_STEPS: int = 20
    DEFAULT_GUIDANCE_SCALE: float = 7.5
    DEFAULT_WIDTH: int = 512
    DEFAULT_HEIGHT: int = 512

    # Cleanup Policy
    MAX_STORED_IMAGES: int = 100  # Number of images to keep before cleanup
    MAX_CACHED_MODELS: int = 2    # Max pipelines kept in RAM (LRU eviction)

    def __init__(self):
        # Ensure output directory exists
        self.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

settings = Settings()
