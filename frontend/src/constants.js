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

export const CANVAS_OBJECT_ROLES = {
    FRAME_HIT_AREA: 'frame-hit-area',
    BASE: 'base',
    CANDIDATE: 'candidate',
    SKETCH: 'sketch',
    MASK: 'mask',
    FRAME: 'frame'
};

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

export const resolveApiUrl = (path = "") => {
    if (!path) {
        return API_BASE_URL;
    }
    if (/^https?:\/\//i.test(path)) {
        return path;
    }
    return `${API_BASE_URL}${path}`;
};

export const API_ENDPOINTS = {
    GENERATE: `${API_BASE_URL}/generate`,
    PROMPT_TRANSFORM: `${API_BASE_URL}/prompt/transform`,
    PROMPT_HEALTH: `${API_BASE_URL}/prompt/health`,
    HEALTH: `${API_BASE_URL}/health`,
    CANCEL: `${API_BASE_URL}/cancel`,
    MODELS: `${API_BASE_URL}/models`
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

export const GENERATION_NUMERIC_PARAM_RULES = {
    frame_size_index: {
        label: "Frame Size",
        type: "int",
        defaultValue: 0,
        min: 0,
        max: AVAILABLE_SIZES.length - 1
    },
    seed: {
        label: "Seed",
        type: "int",
        defaultValue: -1,
        min: -1,
        max: 4294967295
    },
    steps: {
        label: "Steps",
        type: "int",
        defaultValue: 20,
        min: 1,
        max: 150
    },
    cfg: {
        label: "CFG Scale",
        type: "float",
        defaultValue: 7.5,
        min: 1,
        max: 20
    },
    denoising_strength: {
        label: "Denoising",
        type: "float",
        defaultValue: 0.75,
        min: 0,
        max: 1
    },
    mask_blur: {
        label: "Mask Blur",
        type: "int",
        defaultValue: 4,
        min: 0,
        max: 64
    },
    mask_padding: {
        label: "Mask Padding",
        type: "int",
        defaultValue: 32,
        min: 0,
        max: 128
    }
};

export const parseGenerationNumericParam = (name, rawValue) => {
    const rule = GENERATION_NUMERIC_PARAM_RULES[name];
    if (!rule) {
        return { valid: false, reason: "unknown", value: rawValue };
    }

    if (rawValue === "" || rawValue === null || rawValue === undefined) {
        return { valid: false, reason: "empty", value: rule.defaultValue, rule };
    }

    const numericValue = Number(rawValue);
    if (!Number.isFinite(numericValue)) {
        return { valid: false, reason: "nan", value: rule.defaultValue, rule };
    }

    if (rule.type === "int" && !Number.isInteger(numericValue)) {
        return { valid: false, reason: "not_integer", value: rule.defaultValue, rule };
    }

    let value = numericValue;
    if (rule.min !== undefined) {
        value = Math.max(rule.min, value);
    }
    if (rule.max !== undefined) {
        value = Math.min(rule.max, value);
    }
    if (rule.type === "int") {
        value = Math.trunc(value);
    }

    return { valid: true, reason: null, value, rule };
};

export const normalizeGenerationParams = (params) => {
    const normalized = { ...params };
    const invalidFields = [];

    Object.keys(GENERATION_NUMERIC_PARAM_RULES).forEach((name) => {
        const parsed = parseGenerationNumericParam(name, params[name]);
        if (parsed.valid) {
            normalized[name] = parsed.value;
            return;
        }

        invalidFields.push({
            name,
            label: parsed.rule?.label || name,
            reason: parsed.reason
        });
    });

    return {
        normalized,
        invalidFields
    };
};

export const createClientId = (prefix = "id") => {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) {
        return `${prefix}-${uuid}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};
