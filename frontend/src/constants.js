export const CANVAS_DEFAULTS = {
    GRID_SIZE: 64,
    BG_COLOR: '#1e1e1e',
    FRAME_COLOR: '#00d4ff',
    CANDIDATE_BORDER_COLOR: '#00ff00',
    MASK_COLOR: 'rgba(255, 0, 0, 0.5)',
    ERASER_COLOR: '#808080',
    DEFAULT_WIDTH: 512,
    DEFAULT_HEIGHT: 512
};

export const API_ENDPOINTS = {
    GENERATE: '/generate',
    PROMPT_TRANSFORM: '/prompt/transform',
    HEALTH: '/health',
    CANCEL: '/cancel',
    MODELS: '/models'
};

// Initial placeholder shown while fetching the real list from the backend
export const AVAILABLE_MODELS_PLACEHOLDER = [
    { id: "runwayml/stable-diffusion-v1-5", label: "Loading models..." }
];

export const AVAILABLE_SAMPLERS = [
    "Euler a",
    "Euler",
    "DPM++ 2M Karras",
    "DPM++ 2S a Karras",
    "DPM++ SDE Karras",
    "DPM2 a Karras",
    "DDIM",
    "DDPM",
    "Heun",
    "UniPC",
    "LMS"
];

export const AVAILABLE_SIZES = [
    { width: 512, height: 512, label: "512 x 512 (Square)" },
    { width: 768, height: 512, label: "768 x 512 (Landscape)" },
    { width: 512, height: 768, label: "512 x 768 (Portrait)" },
    { width: 768, height: 768, label: "768 x 768 (Square HD)" }
];
