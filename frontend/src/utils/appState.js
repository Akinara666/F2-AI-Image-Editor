import {
  AVAILABLE_MODELS_PLACEHOLDER,
  AVAILABLE_SAMPLERS,
  LEGACY_SAMPLER_ALIASES,
  createClientId,
  parseGenerationNumericParam
} from '../constants';

export const HISTORY_STORAGE_KEY = 'generation_history';
export const HISTORY_STORAGE_VERSION = 2;
export const HISTORY_MAX_ITEMS = 50;
export const APP_SETTINGS_STORAGE_KEY = 'generation_app_settings';
export const APP_SETTINGS_STORAGE_VERSION = 1;
export const SIDEBAR_WIDTH_STORAGE_KEY = 'app_sidebar_width';
export const DEFAULT_SIDEBAR_WIDTH = 360;
export const MIN_SIDEBAR_WIDTH = 320;
export const MAX_SIDEBAR_WIDTH = 560;
export const MIN_EDITOR_WIDTH = 320;

export const DEFAULT_PARAMS = {
  prompt: 'A futuristic city',
  negative_prompt: 'low quality, blurry',
  seed: -1,
  steps: 20,
  cfg: 5,
  denoising_strength: 1,
  mask_blur: 4,
  mask_padding: 32,
  model_id: AVAILABLE_MODELS_PLACEHOLDER[0].id,
  sampler: 'DPM++ 2M Karras',
  frame_size_index: 4
};

export const DEFAULT_BRUSH_SETTINGS = {
  brushMode: 'none',
  brushColor: '#ffffff',
  brushSize: 20
};

export const DEFAULT_GENERATION_MODE = 'whole';
const GENERATION_MODE_IDS = new Set(['whole', 'inpaint']);
const sanitizeGenerationMode = (value) => (
  GENERATION_MODE_IDS.has(value) ? value : DEFAULT_GENERATION_MODE
);

const getSanitizedNumericParam = (rawParams, name) => {
  const parsed = parseGenerationNumericParam(name, rawParams[name]);
  return parsed.valid ? parsed.value : parsed.rule?.defaultValue;
};

// Мигрируем легаси-имена и отбрасываем самплеры, которых больше нет в списке:
// иначе сохранённое значение уезжает на бэкенд и получает 422.
export const sanitizeSampler = (rawSampler) => {
  if (typeof rawSampler !== 'string') {
    return DEFAULT_PARAMS.sampler;
  }
  const mapped = LEGACY_SAMPLER_ALIASES[rawSampler] || rawSampler;
  return AVAILABLE_SAMPLERS.includes(mapped) ? mapped : DEFAULT_PARAMS.sampler;
};

export const normalizeHistoryItem = (item) => {
  if (!item || typeof item !== 'object' || typeof item.url !== 'string' || !item.url.trim()) {
    return null;
  }

  const meta = item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta)
    ? item.meta
    : {};
  const timestamp = Number(item.timestamp);
  const generatedUrl = typeof item.generated_url === 'string' && item.generated_url.trim()
    ? item.generated_url
    : null;

  return {
    id: item.id ?? createClientId('history'),
    url: item.url,
    generated_url: generatedUrl,
    meta,
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now()
  };
};

export const normalizeHistoryItems = (items) => (
  (Array.isArray(items) ? items : [])
    .map(normalizeHistoryItem)
    .filter(Boolean)
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, HISTORY_MAX_ITEMS)
);

export const loadHistoryFromStorage = () => {
  try {
    const saved = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved);
    const items = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed?.items) ? parsed.items : []);
    return normalizeHistoryItems(items);
  } catch {
    return [];
  }
};

export const loadAppSettingsFromStorage = () => {
  try {
    const saved = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!saved) {
      return {
        params: { ...DEFAULT_PARAMS },
        brush: { ...DEFAULT_BRUSH_SETTINGS },
        generationMode: DEFAULT_GENERATION_MODE
      };
    }

    const parsed = JSON.parse(saved);
    const rawParams = parsed?.params && typeof parsed.params === 'object' ? parsed.params : {};
    const rawBrush = parsed?.brush && typeof parsed.brush === 'object' ? parsed.brush : {};

    return {
      generationMode: sanitizeGenerationMode(parsed?.generationMode),
      params: {
        prompt: typeof rawParams.prompt === 'string' ? rawParams.prompt : DEFAULT_PARAMS.prompt,
        negative_prompt: typeof rawParams.negative_prompt === 'string' ? rawParams.negative_prompt : DEFAULT_PARAMS.negative_prompt,
        seed: getSanitizedNumericParam(rawParams, 'seed'),
        steps: getSanitizedNumericParam(rawParams, 'steps'),
        cfg: getSanitizedNumericParam(rawParams, 'cfg'),
        denoising_strength: getSanitizedNumericParam(rawParams, 'denoising_strength'),
        mask_blur: getSanitizedNumericParam(rawParams, 'mask_blur'),
        mask_padding: getSanitizedNumericParam(rawParams, 'mask_padding'),
        frame_size_index: getSanitizedNumericParam(rawParams, 'frame_size_index'),
        model_id: typeof rawParams.model_id === 'string' ? rawParams.model_id : DEFAULT_PARAMS.model_id,
        sampler: sanitizeSampler(rawParams.sampler)
      },
      brush: {
        brushMode: typeof rawBrush.brushMode === 'string' ? rawBrush.brushMode : DEFAULT_BRUSH_SETTINGS.brushMode,
        brushColor: typeof rawBrush.brushColor === 'string' ? rawBrush.brushColor : DEFAULT_BRUSH_SETTINGS.brushColor,
        brushSize: Number.isFinite(Number(rawBrush.brushSize))
          ? Math.max(1, Math.min(100, Number(rawBrush.brushSize)))
          : DEFAULT_BRUSH_SETTINGS.brushSize
      }
    };
  } catch {
    return {
      params: { ...DEFAULT_PARAMS },
      brush: { ...DEFAULT_BRUSH_SETTINGS },
      generationMode: DEFAULT_GENERATION_MODE
    };
  }
};

export const isMissingHistoryError = (error) => {
  const status = error?.response?.status;
  if (status === 404 || status === 410) {
    return true;
  }

  const message = String(error?.message || error?.response?.data?.detail || '');
  return /\b(404|410)\b/.test(message);
};

export const getHistoryFilename = (url) => {
  const path = String(url || '').split('?')[0];
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'image.png';
};

export const clampSidebarWidth = (
  rawWidth,
  viewportWidth = globalThis.window?.innerWidth ?? (MAX_SIDEBAR_WIDTH + MIN_EDITOR_WIDTH)
) => {
  const maxAllowed = Math.min(
    MAX_SIDEBAR_WIDTH,
    Math.max(MIN_SIDEBAR_WIDTH, viewportWidth - MIN_EDITOR_WIDTH)
  );
  return Math.round(Math.min(maxAllowed, Math.max(MIN_SIDEBAR_WIDTH, rawWidth)));
};

export const loadSidebarWidthFromStorage = () => {
  if (typeof window === 'undefined') {
    return DEFAULT_SIDEBAR_WIDTH;
  }

  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    // Number(null) === 0, что молча давало минимальную ширину вместо дефолтной.
    const saved = raw === null ? NaN : Number(raw);
    if (!Number.isFinite(saved)) {
      return clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, window.innerWidth);
    }
    return clampSidebarWidth(saved, window.innerWidth);
  } catch {
    return clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, window.innerWidth);
  }
};
