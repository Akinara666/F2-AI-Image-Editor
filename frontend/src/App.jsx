import React, { useState } from 'react';
import Editor from './components/Editor';
import Sidebar from './components/Sidebar';
import HistoryPanel from './components/HistoryPanel';
import axios from 'axios';
import { useToast } from './components/ToastProvider';
import {
  API_ENDPOINTS,
  AVAILABLE_MODELS_PLACEHOLDER,
  AVAILABLE_SAMPLERS,
  createClientId,
  normalizeGenerationParams,
  resolveApiUrl
} from './constants';
import './theme.css';
import './App.css';

const HISTORY_STORAGE_KEY = 'generation_history';
const HISTORY_STORAGE_VERSION = 2;
const HISTORY_MAX_ITEMS = 50;
const APP_SETTINGS_STORAGE_KEY = 'generation_app_settings';
const APP_SETTINGS_STORAGE_VERSION = 1;
const SIDEBAR_WIDTH_STORAGE_KEY = 'app_sidebar_width';
const DEFAULT_SIDEBAR_WIDTH = 360;
const MIN_SIDEBAR_WIDTH = 320;
const MAX_SIDEBAR_WIDTH = 560;
const MIN_EDITOR_WIDTH = 320;

const DEFAULT_PARAMS = {
  prompt: "A futuristic city",
  negative_prompt: "low quality, blurry",
  seed: -1,
  steps: 20,
  cfg: 7.5,
  denoising_strength: 0.75,
  mask_blur: 4,
  mask_padding: 32,
  model_id: AVAILABLE_MODELS_PLACEHOLDER[0].id,
  sampler: AVAILABLE_SAMPLERS[0],
  frame_size_index: 0
};

const DEFAULT_BRUSH_SETTINGS = {
  brushMode: 'none',
  brushColor: '#ffffff',
  brushSize: 20
};

const normalizeHistoryItem = (item) => {
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

const normalizeHistoryItems = (items) => (
  (Array.isArray(items) ? items : [])
    .map(normalizeHistoryItem)
    .filter(Boolean)
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, HISTORY_MAX_ITEMS)
);

const loadHistoryFromStorage = () => {
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

const loadAppSettingsFromStorage = () => {
  try {
    const saved = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!saved) {
      return {
        params: { ...DEFAULT_PARAMS },
        brush: { ...DEFAULT_BRUSH_SETTINGS }
      };
    }

    const parsed = JSON.parse(saved);
    const rawParams = parsed?.params && typeof parsed.params === 'object' ? parsed.params : {};
    const rawBrush = parsed?.brush && typeof parsed.brush === 'object' ? parsed.brush : {};
    const { normalized } = normalizeGenerationParams({
      ...DEFAULT_PARAMS,
      ...rawParams
    });

    return {
      params: {
        prompt: typeof rawParams.prompt === 'string' ? rawParams.prompt : DEFAULT_PARAMS.prompt,
        negative_prompt: typeof rawParams.negative_prompt === 'string' ? rawParams.negative_prompt : DEFAULT_PARAMS.negative_prompt,
        seed: normalized.seed,
        steps: normalized.steps,
        cfg: normalized.cfg,
        denoising_strength: normalized.denoising_strength,
        mask_blur: normalized.mask_blur,
        mask_padding: normalized.mask_padding,
        frame_size_index: normalized.frame_size_index,
        model_id: typeof rawParams.model_id === 'string' ? rawParams.model_id : DEFAULT_PARAMS.model_id,
        sampler: typeof rawParams.sampler === 'string' ? rawParams.sampler : DEFAULT_PARAMS.sampler,
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
      brush: { ...DEFAULT_BRUSH_SETTINGS }
    };
  }
};

const isMissingHistoryError = (error) => {
  const status = error?.response?.status;
  if (status === 404 || status === 410) {
    return true;
  }

  const message = String(error?.message || error?.response?.data?.detail || '');
  return /\b(404|410)\b/.test(message);
};

const getHistoryFilename = (url) => {
  const path = String(url || '').split('?')[0];
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'image.png';
};

const clampSidebarWidth = (rawWidth, viewportWidth = window.innerWidth) => {
  const maxAllowed = Math.min(
    MAX_SIDEBAR_WIDTH,
    Math.max(MIN_SIDEBAR_WIDTH, viewportWidth - MIN_EDITOR_WIDTH)
  );
  return Math.round(Math.min(maxAllowed, Math.max(MIN_SIDEBAR_WIDTH, rawWidth)));
};

const loadSidebarWidthFromStorage = () => {
  if (typeof window === 'undefined') {
    return DEFAULT_SIDEBAR_WIDTH;
  }

  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    if (!Number.isFinite(saved)) {
      return clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, window.innerWidth);
    }
    return clampSidebarWidth(saved, window.innerWidth);
  } catch {
    return clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, window.innerWidth);
  }
};

function App() {
  const GENERATION_STATUS = {
    IDLE: 'idle',
    GENERATING: 'generating',
    CANCELLING: 'cancelling',
    RESTORING: 'restoring'
  };
  const { showSuccess, showError, showInfo } = useToast();
  const initialAppSettings = React.useMemo(loadAppSettingsFromStorage, []);
  const [availableModels, setAvailableModels] = useState([]);
  const [params, setParams] = useState(initialAppSettings.params);

  // Fetch models on mount
  React.useEffect(() => {
    const fetchModels = async () => {
      try {
        const response = await axios.get(API_ENDPOINTS.MODELS);
        if (response.data && response.data.models) {
          setAvailableModels(response.data.models);
          // Replace placeholder or missing stored model with the first available model.
          setParams(prev => ({
            ...prev,
            model_id: (
              prev.model_id === AVAILABLE_MODELS_PLACEHOLDER[0].id
              || !response.data.models.some((model) => model.id === prev.model_id)
            )
              ? response.data.models[0].id
              : prev.model_id
          }));
        }
      } catch (err) {
        console.error("Failed to fetch models:", err);
        showError("Не удалось загрузить список моделей с сервера.");
      }
    };
    fetchModels();
  }, []);

  const [generationStatus, setGenerationStatus] = useState(GENERATION_STATUS.IDLE);
  const [history, setHistory] = useState(loadHistoryFromStorage);
  const [generationPreview, setGenerationPreview] = useState(null);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidthFromStorage);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const appContainerRef = React.useRef(null);
  const sidebarResizeStateRef = React.useRef(null);

  const removeHistoryItem = React.useCallback((itemOrId) => {
    const targetId = typeof itemOrId === 'string' ? itemOrId : itemOrId?.id;
    if (!targetId) {
      return;
    }

    setHistory((prev) => {
      const next = prev.filter((item) => item.id !== targetId);
      return next.length === prev.length ? prev : normalizeHistoryItems(next);
    });
  }, []);

  const pruneMissingHistoryItems = React.useCallback(async (items, signal) => {
    if (!items.length) {
      return;
    }

    const missingIds = (
      await Promise.all(items.map(async (item) => {
        try {
          const response = await fetch(resolveApiUrl(item.url), {
            method: 'HEAD',
            cache: 'no-store',
            signal
          });
          if (response.ok) {
            return null;
          }
          return response.status === 404 || response.status === 410 ? item.id : null;
        } catch (error) {
          if (signal.aborted) {
            return null;
          }
          return null;
        }
      }))
    ).filter(Boolean);

    if (missingIds.length === 0 || signal.aborted) {
      return;
    }

    setHistory((prev) => {
      const next = prev.filter((item) => !missingIds.includes(item.id));
      return next.length === prev.length ? prev : normalizeHistoryItems(next);
    });
  }, []);

  // Persist history to localStorage
  React.useEffect(() => {
    const normalizedHistory = normalizeHistoryItems(history);
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({
        version: HISTORY_STORAGE_VERSION,
        items: normalizedHistory
      }));
    } catch { /* quota exceeded — silently ignore */ }
  }, [history]);

  React.useEffect(() => {
    if (history.length === 0) {
      return undefined;
    }

    const controller = new AbortController();
    void pruneMissingHistoryItems(history, controller.signal);

    return () => {
      controller.abort();
    };
  }, [history, pruneMissingHistoryItems]);

  React.useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch { /* ignore storage issues */ }
  }, [sidebarWidth]);

  React.useEffect(() => {
    const handleResize = () => {
      setSidebarWidth((currentWidth) => clampSidebarWidth(currentWidth, window.innerWidth));
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  React.useEffect(() => {
    if (!isResizingSidebar) {
      return undefined;
    }

    const handlePointerMove = (event) => {
      const containerLeft = sidebarResizeStateRef.current?.containerLeft ?? 0;
      const nextWidth = event.clientX - containerLeft;
      setSidebarWidth(clampSidebarWidth(nextWidth, window.innerWidth));
    };

    const stopResizing = () => {
      setIsResizingSidebar(false);
      sidebarResizeStateRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResizing);
    window.addEventListener('pointercancel', stopResizing);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResizing);
      window.removeEventListener('pointercancel', stopResizing);
    };
  }, [isResizingSidebar]);
  const [brushMode, setBrushMode] = useState(initialAppSettings.brush.brushMode);
  const [brushColor, setBrushColor] = useState(initialAppSettings.brush.brushColor);
  const [brushSize, setBrushSize] = useState(initialAppSettings.brush.brushSize);

  React.useEffect(() => {
    try {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
        version: APP_SETTINGS_STORAGE_VERSION,
        params,
        brush: {
          brushMode,
          brushColor,
          brushSize
        }
      }));
    } catch { /* quota exceeded — silently ignore */ }
  }, [params, brushMode, brushColor, brushSize]);

  // Ref to Editor's export function
  const editorRef = React.useRef();
  const abortControllerRef = React.useRef(null);
  const currentGenerationRequestIdRef = React.useRef(null);
  const spotHealInFlightRef = React.useRef(false);
  const generationStatusRef = React.useRef(GENERATION_STATUS.IDLE);
  const setGenerationLifecycleStatus = (nextStatus) => {
    generationStatusRef.current = nextStatus;
    setGenerationStatus(nextStatus);
  };
  const isGenerating = generationStatus === GENERATION_STATUS.GENERATING || generationStatus === GENERATION_STATUS.CANCELLING;
  const isBusy = generationStatus !== GENERATION_STATUS.IDLE;

  const pollGenerationPreview = React.useCallback(async (requestId, signal) => {
    while (!signal.aborted && currentGenerationRequestIdRef.current === requestId) {
      try {
        const response = await axios.get(API_ENDPOINTS.GENERATION_PREVIEW(requestId), {
          signal,
          params: { t: Date.now() }
        });
        const preview = response.data?.data;
        if (preview) {
          setGenerationPreview(preview);
        }
      } catch (error) {
        if (signal.aborted || axios.isCancel(error)) {
          return;
        }
        if (error?.response?.status !== 404) {
          console.error("Failed to fetch generation preview", error);
        }
      }

      await new Promise((resolve) => {
        const timerId = window.setTimeout(resolve, 450);
        signal.addEventListener('abort', () => {
          window.clearTimeout(timerId);
          resolve();
        }, { once: true });
      });
    }
  }, []);

  const handleGenerate = async () => {
    if (!editorRef.current || generationStatusRef.current !== GENERATION_STATUS.IDLE) return;

    const { normalized: normalizedParams, invalidFields } = normalizeGenerationParams(params);
    if (invalidFields.length > 0) {
      showError(`Некорректные числовые параметры: ${invalidFields.map(field => field.label).join(', ')}`);
      return;
    }
    if (JSON.stringify(normalizedParams) !== JSON.stringify(params)) {
      setParams(prev => ({
        ...prev,
        ...normalizedParams
      }));
    }

    setGenerationLifecycleStatus(GENERATION_STATUS.GENERATING);

    const controller = new AbortController();
    const previewController = new AbortController();
    const requestId = createClientId('generation');
    abortControllerRef.current = controller;
    currentGenerationRequestIdRef.current = requestId;
    setGenerationPreview(null);

    try {
      void pollGenerationPreview(requestId, previewController.signal);
      // 1. Get Crops from Editor
      const { image: initImageBlob, mask: maskImageBlob, width, height } = await editorRef.current.exportForGeneration();

      // 2. Prepare FormData
      const formData = new FormData();
      formData.append('request_id', requestId);
      formData.append('prompt', normalizedParams.prompt);
      formData.append('raw_prompt', normalizedParams.prompt);
      formData.append('use_prompt_transform', 'false');
      formData.append('negative_prompt', normalizedParams.negative_prompt);
      formData.append('seed', normalizedParams.seed);
      formData.append('steps', normalizedParams.steps);
      formData.append('cfg', normalizedParams.cfg);
      formData.append('denoising_strength', normalizedParams.denoising_strength);
      formData.append('mask_blur', normalizedParams.mask_blur);
      formData.append('mask_padding', normalizedParams.mask_padding);
      formData.append('model_id', normalizedParams.model_id);
      formData.append('sampler', normalizedParams.sampler);
      formData.append('active_tool', brushMode);
      // Smart Mode: if mask exists -> mask, else -> auto (backend handles txt2img/img2img)
      formData.append('mode', 'auto');

      formData.append('width', width);
      formData.append('height', height);

      if (initImageBlob) {
        formData.append('init_image', initImageBlob, 'init.png');
      }
      if (maskImageBlob) {
        formData.append('mask_image', maskImageBlob, 'mask.png');
      }

      // 3. Send Request
      // Note: Vite proxy set up in vite.config.js to localhost:8000
      const response = await axios.post(API_ENDPOINTS.GENERATE, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        signal: controller.signal
      });

      if (response.data.status === 'success') {
        console.log("Generated:", response.data.url);
        showSuccess("Изображение успешно сгенерировано.");
        if (response.data?.meta?.model_downloaded_now) {
          showInfo("Выбранная модель была скачана во время генерации и теперь сохранена локально.");
        }
        if (response.data?.meta?.prompt_transform_status && response.data.meta.prompt_transform_status !== 'disabled') {
          showInfo(`Трансформер промпта: ${response.data.meta.prompt_transform_status}`);
        }
        // 4. Add to Canvas
        await editorRef.current.addGeneratedImage(response.data.url);

        const historyMeta = response.data.meta || {
          prompt: normalizedParams.prompt,
          raw_prompt: normalizedParams.prompt,
          negative_prompt: normalizedParams.negative_prompt,
          seed: normalizedParams.seed
        };
        let historyDocumentUrl = response.data.url;

        try {
          const { image: historySnapshotBlob } = await editorRef.current.exportHistorySnapshot();
          const historyFormData = new FormData();
          historyFormData.append('image', historySnapshotBlob, 'history-snapshot.png');
          historyFormData.append('prompt', historyMeta.prompt || normalizedParams.prompt);
          historyFormData.append('raw_prompt', historyMeta.raw_prompt || normalizedParams.prompt);
          historyFormData.append('negative_prompt', historyMeta.negative_prompt || normalizedParams.negative_prompt);
          historyFormData.append('seed', String(historyMeta.seed ?? normalizedParams.seed));
          historyFormData.append('active_tool', String(historyMeta.active_tool ?? brushMode));
          historyFormData.append('generated_url', response.data.url);

          const historySnapshotResponse = await axios.post(API_ENDPOINTS.HISTORY_SAVE, historyFormData, {
            headers: { 'Content-Type': 'multipart/form-data' }
          });
          if (historySnapshotResponse.data?.url) {
            historyDocumentUrl = historySnapshotResponse.data.url;
          }
        } catch (historySnapshotError) {
          console.error("Failed to save full history snapshot", historySnapshotError);
          showInfo("Сгенерированный фрагмент сохранён, но полный снимок холста сохранить не удалось.");
        }

        // 5. Add to History
        const newHistoryItem = {
          id: createClientId('history'),
          url: historyDocumentUrl,
          generated_url: response.data.url,
          meta: historyMeta,
          timestamp: Date.now()
        };
        setHistory(prev => normalizeHistoryItems([newHistoryItem, ...prev]));
      }

    } catch (e) {
      if (axios.isCancel(e)) {
        console.log("Request canceled by user");
        showError("Генерация отменена.");
      } else {
        console.error("Generation failed", e);
        const errorMsg = e.response?.data?.detail || e.message;
        console.error("Error details:", errorMsg);
        showError(`Ошибка генерации: ${errorMsg}`);
      }
    } finally {
      previewController.abort();
      abortControllerRef.current = null;
      if (currentGenerationRequestIdRef.current === requestId) {
        currentGenerationRequestIdRef.current = null;
      }
      setGenerationPreview(null);
      if (generationStatusRef.current !== GENERATION_STATUS.CANCELLING) {
        setGenerationLifecycleStatus(GENERATION_STATUS.IDLE);
      }
    }
  };

  const handleCancel = async () => {
    if (generationStatusRef.current !== GENERATION_STATUS.GENERATING) {
      return;
    }

    setGenerationLifecycleStatus(GENERATION_STATUS.CANCELLING);
    abortControllerRef.current?.abort();

    try {
      const requestId = currentGenerationRequestIdRef.current;
      if (requestId) {
        await axios.post(API_ENDPOINTS.CANCEL, { request_id: requestId });
      }
    } catch (e) {
      console.error("Failed to cleanly cancel on server", e);
    } finally {
      abortControllerRef.current = null;
      currentGenerationRequestIdRef.current = null;
      setGenerationLifecycleStatus(GENERATION_STATUS.IDLE);
    }
  };

  const handleSpotHealPoint = async ({ x, y, radius }) => {
    if (!editorRef.current) {
      return;
    }
    if (generationStatusRef.current !== GENERATION_STATUS.IDLE) {
      showInfo("Дождись завершения текущей генерации.");
      return;
    }
    if (spotHealInFlightRef.current) {
      return;
    }
    if (!editorRef.current.canSpotHeal?.()) {
      showInfo("Сначала добавь изображение на холст, затем используй Spot Healing.");
      return;
    }

    const { normalized: normalizedParams, invalidFields } = normalizeGenerationParams(params);
    if (invalidFields.length > 0) {
      showError(`Некорректные числовые параметры: ${invalidFields.map(field => field.label).join(', ')}`);
      return;
    }

    spotHealInFlightRef.current = true;
    try {
      await editorRef.current.acceptCandidateAsync?.();

      const { image: initImageBlob, mask: maskImageBlob, width, height } = await editorRef.current.exportForSpotHeal({
        x,
        y,
        radius
      });

      if (!initImageBlob || !maskImageBlob) {
        throw new Error("Не удалось подготовить область для точечной ретуши.");
      }

      const formData = new FormData();
      formData.append('prompt', normalizedParams.prompt);
      formData.append('negative_prompt', normalizedParams.negative_prompt);
      formData.append('seed', String(normalizedParams.seed));
      formData.append('steps', String(normalizedParams.steps));
      formData.append('cfg', String(normalizedParams.cfg));
      formData.append('denoising_strength', String(normalizedParams.denoising_strength));
      formData.append('mask_blur', String(normalizedParams.mask_blur));
      formData.append('mask_padding', String(normalizedParams.mask_padding));
      formData.append('model_id', normalizedParams.model_id);
      formData.append('sampler', normalizedParams.sampler);
      formData.append('active_tool', 'spot_heal');
      formData.append('width', String(width));
      formData.append('height', String(height));
      formData.append('init_image', initImageBlob, 'spot-heal-init.png');
      formData.append('mask_image', maskImageBlob, 'spot-heal-mask.png');

      const response = await axios.post(API_ENDPOINTS.SPOT_HEAL, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      if (response.data?.status === 'success' && response.data?.url) {
        await editorRef.current.addGeneratedImage(response.data.url);
        await editorRef.current.acceptCandidateAsync?.();
        showSuccess("Точечная ретушь применена.");
      } else {
        throw new Error("Сервер не вернул результат точечной ретуши.");
      }
    } catch (error) {
      console.error("Spot heal failed", error);
      const errorMsg = error.response?.data?.detail || error.message;
      showError(`Ошибка Spot Healing: ${errorMsg}`);
    } finally {
      spotHealInFlightRef.current = false;
    }
  };

  const handleQuickSelectionCopy = async () => {
    if (!editorRef.current) {
      return;
    }
    const copied = await editorRef.current.copyQuickSelection?.();
    if (!copied) {
      showInfo("Сначала выдели область инструментом Quick Select (W).");
      return;
    }
    showSuccess("Выделенная область скопирована.");
  };

  const handleQuickSelectionPaste = async () => {
    if (!editorRef.current) {
      return;
    }
    const pasted = await editorRef.current.pasteQuickSelection?.();
    if (!pasted) {
      showInfo("Буфер пуст. Сначала скопируй выделение.");
      return;
    }
    showSuccess("Копия вставлена рядом как новый слой.");
  };

  const handleRestore = async (item) => {
    if (!editorRef.current || generationStatusRef.current !== GENERATION_STATUS.IDLE) {
      return;
    }

    setGenerationLifecycleStatus(GENERATION_STATUS.RESTORING);
    try {
      await editorRef.current.restoreHistoryDocument(item.url);
      showSuccess("Элемент истории восстановлен на холст.");
    } catch (e) {
      console.error("Failed to restore history item", e);
      const errorMsg = e.response?.data?.detail || e.message;
      if (isMissingHistoryError(e)) {
        removeHistoryItem(item);
      }
      showError(`Не удалось восстановить элемент истории: ${errorMsg}`);
    } finally {
      setGenerationLifecycleStatus(GENERATION_STATUS.IDLE);
    }
  };

  const handleDownloadHistoryItem = async (item) => {
    try {
      const response = await fetch(resolveApiUrl(item.url), {
        mode: 'cors',
        cache: 'no-store'
      });
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.status}`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = getHistoryFilename(item.url);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      console.error("Failed to download history item", e);
      if (isMissingHistoryError(e)) {
        removeHistoryItem(item);
      }
      const errorMsg = e.response?.data?.detail || e.message;
      showError(`Не удалось скачать изображение: ${errorMsg}`);
    }
  };

  const handleDeleteHistoryItem = async (item) => {
    try {
      const urls = Array.from(new Set([item.url, item.generated_url].filter(Boolean)));
      await axios.post(API_ENDPOINTS.HISTORY_DELETE, {
        urls
      });
      removeHistoryItem(item);
      showSuccess("Изображение удалено из истории.");
    } catch (e) {
      console.error("Failed to delete history item", e);
      if (isMissingHistoryError(e)) {
        removeHistoryItem(item);
        showInfo("Файл уже отсутствовал и был удалён из истории.");
        return;
      }
      const errorMsg = e.response?.data?.detail || e.message;
      showError(`Не удалось удалить изображение: ${errorMsg}`);
    }
  };

  const handleCopyHistoryPrompt = async (item) => {
    const promptText = String(item?.meta?.prompt || item?.meta?.raw_prompt || '').trim();
    if (!promptText) {
      showError("У этого элемента истории нет сохранённого промпта.");
      return;
    }

    try {
      await navigator.clipboard.writeText(promptText);
      showSuccess("Промпт скопирован в буфер обмена.");
    } catch (error) {
      console.error("Failed to copy history prompt", error);
      showError("Не удалось скопировать промпт.");
    }
  };

  const handleSidebarResizeStart = (event) => {
    if (event.button !== 0) {
      return;
    }

    const containerRect = appContainerRef.current?.getBoundingClientRect();
    sidebarResizeStateRef.current = {
      containerLeft: containerRect?.left ?? 0
    };
    setIsResizingSidebar(true);
    event.preventDefault();
  };

  return (
    <div
      ref={appContainerRef}
      className={`app-container ${isResizingSidebar ? 'app-container--resizing' : ''}`}
    >
      <div className="sidebar-shell" style={{ width: `${sidebarWidth}px` }}>
        <Sidebar
          availableModels={availableModels}
          params={params}
          setParams={setParams}
          isGenerating={isGenerating}
          isBusy={isBusy}
          generationStatus={generationStatus}
          onGenerate={handleGenerate}
          onCancel={handleCancel}
          brushMode={brushMode}
          setBrushMode={setBrushMode}
          brushColor={brushColor}
          setBrushColor={setBrushColor}
          brushSize={brushSize}
          setBrushSize={setBrushSize}
          onQuickSelectionCopy={handleQuickSelectionCopy}
          onQuickSelectionPaste={handleQuickSelectionPaste}
          onUndo={() => editorRef.current?.undo()}
          onClear={() => editorRef.current?.clearAll()}
          editorRef={editorRef}
          showToastError={showError}
          showToastSuccess={showSuccess}
          showToastInfo={showInfo}
        />
      </div>
      <div
        className="sidebar-resizer"
        onPointerDown={handleSidebarResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize settings panel"
      />
      <div className="editor-wrapper">
        <Editor
          ref={editorRef}
          brushMode={brushMode}
          setBrushMode={setBrushMode}
          brushColor={brushColor}
          brushSize={brushSize}
          generationPreview={generationPreview}
          onSpotHealPoint={handleSpotHealPoint}
        />
      </div>
      <HistoryPanel
        history={history}
        onSelect={handleRestore}
        onMissing={removeHistoryItem}
        onDelete={handleDeleteHistoryItem}
        onDownload={handleDownloadHistoryItem}
        onCopyPrompt={handleCopyHistoryPrompt}
        isBusy={isBusy}
      />
    </div>
  );
}

export default App;
