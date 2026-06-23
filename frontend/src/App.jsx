import React, { useState } from 'react';
import Editor from './components/Editor';
import Sidebar from './components/Sidebar';
import HistoryPanel from './components/HistoryPanel';
import { resolveBackendMode } from './components/editor/generationModes';
import { TOOL_MODES } from './components/editor/toolModes';
import axios from 'axios';
import { useToast } from './components/ToastProvider';
import {
  API_ENDPOINTS,
  AVAILABLE_MODELS_PLACEHOLDER,
  createClientId,
  normalizeGenerationParams,
  resolveApiUrl
} from './constants';
import {
  APP_SETTINGS_STORAGE_KEY,
  APP_SETTINGS_STORAGE_VERSION,
  HISTORY_STORAGE_KEY,
  HISTORY_STORAGE_VERSION,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
  getHistoryFilename,
  isMissingHistoryError,
  loadAppSettingsFromStorage,
  loadHistoryFromStorage,
  loadSidebarWidthFromStorage,
  normalizeHistoryItems
} from './utils/appState';
import './theme.css';
import './App.css';

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

  // Загрузка/обновление списка моделей (вызывается при монтировании и из меню моделей).
  const refreshModels = React.useCallback(async ({ silent = false } = {}) => {
    try {
      const response = await axios.get(API_ENDPOINTS.MODELS);
      const models = response.data?.models;
      if (Array.isArray(models)) {
        setAvailableModels(models);
        // Если выбранной модели больше нет в списке (или это заглушка), берём первую доступную.
        setParams(prev => ({
          ...prev,
          model_id: (
            prev.model_id === AVAILABLE_MODELS_PLACEHOLDER[0].id
            || !models.some((model) => model.id === prev.model_id)
          )
            ? (models[0]?.id ?? prev.model_id)
            : prev.model_id
        }));
        return models;
      }
      return [];
    } catch (err) {
      console.error("Failed to fetch models:", err);
      if (!silent) showError("Не удалось загрузить список моделей с сервера.");
      return [];
    }
  }, [showError]);

  React.useEffect(() => {
    refreshModels({ silent: false });
  }, [refreshModels]);

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

  // Сохраняем историю в localStorage.
  React.useEffect(() => {
    const normalizedHistory = normalizeHistoryItems(history);
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({
        version: HISTORY_STORAGE_VERSION,
        items: normalizedHistory
      }));
    } catch { /* Переполнение хранилища не должно ломать интерфейс. */ }
  }, [history]);

  // HEAD-проверку всей истории делаем один раз при первом непустом списке:
  // раньше каждое изменение history заново опрашивало все элементы. Удаления
  // отдельных файлов дальше отлавливает onError у <img> в HistoryPanel.
  const initialHistoryPruneDoneRef = React.useRef(false);
  React.useEffect(() => {
    if (initialHistoryPruneDoneRef.current || history.length === 0) {
      return undefined;
    }
    initialHistoryPruneDoneRef.current = true;

    const controller = new AbortController();
    void pruneMissingHistoryItems(history, controller.signal);

    return () => {
      controller.abort();
    };
  }, [history, pruneMissingHistoryItems]);

  React.useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch { /* Ошибки localStorage здесь безопасно игнорировать. */ }
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
  const [generationMode, setGenerationMode] = useState(initialAppSettings.generationMode);
  const [layers, setLayers] = useState([]);

  React.useEffect(() => {
    try {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
        version: APP_SETTINGS_STORAGE_VERSION,
        params,
        generationMode,
        brush: {
          brushMode,
          brushColor,
          brushSize
        }
      }));
    } catch { /* Переполнение хранилища не должно ломать интерфейс. */ }
  }, [params, generationMode, brushMode, brushColor, brushSize]);

  // Живое превью растушёвки/расширения маски на холсте: реагирует на слайдеры
  // mask_blur/mask_padding и включается только в режимах с маской.
  React.useEffect(() => {
    editorRef.current?.setMaskFeatherPreview?.({
      blur: params.mask_blur,
      padding: params.mask_padding,
      enabled: generationMode === 'inpaint'
    });
  }, [params.mask_blur, params.mask_padding, generationMode]);

  // Смена режима подтягивает уместный инструмент: в inpaint сразу даём кисть
  // маски, в «вся картинка» уводим на курсор. Outpaint инструмент не трогает —
  // его зону задаёт прозрачность кадра (ручки холста — отдельный слайс).
  const handleGenerationModeChange = (nextMode) => {
    setGenerationMode(nextMode);
    if (nextMode === 'inpaint') {
      setBrushMode(TOOL_MODES.MASK);
    } else if (nextMode === 'whole') {
      setBrushMode(TOOL_MODES.CURSOR);
    }
  };

  // Ссылка на публичные методы редактора.
  const editorRef = React.useRef();
  const abortControllerRef = React.useRef(null);
  const currentGenerationRequestIdRef = React.useRef(null);
  const spotHealInFlightRef = React.useRef(false);
  const quickSelectRefineInFlightRef = React.useRef(false);
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
          // Backend reports a terminal status — stop polling immediately instead
          // of hammering /generate/preview while the response/history-save runs.
          if (preview.status && !['pending', 'running'].includes(preview.status)) {
            return;
          }
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
        // Снимаем слушатель после срабатывания таймера, иначе за долгую
        // генерацию на signal накапливаются сотни обработчиков abort.
        const onAbort = () => {
          window.clearTimeout(timerId);
          resolve();
        };
        const timerId = window.setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, 450);
        signal.addEventListener('abort', onAbort, { once: true });
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
      // 1. Получаем подготовленные данные из редактора.
      const { image: initImageBlob, mask: maskImageBlob, width, height } = await editorRef.current.exportForGeneration();

      // В режиме inpaint без маски бэкенд вернёт 400 — ловим это заранее и
      // подсказываем, что делать (finally сбросит статус и preview).
      if (generationMode === 'inpaint' && !maskImageBlob) {
        showError('Inpaint: нарисуйте маску на области, которую нужно изменить.');
        return;
      }

      // 2. Собираем FormData для запроса генерации.
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
      // Явный режим из UI: пользователь сам выбрал «вся картинка / inpaint /
      // outpaint». В режиме «вся картинка» маску не отправляем, даже если она
      // нарисована, — никакого backend-угадывания.
      const { mode: backendMode, sendMask } = resolveBackendMode(generationMode);
      formData.append('mode', backendMode);

      formData.append('width', width);
      formData.append('height', height);

      if (initImageBlob) {
        formData.append('init_image', initImageBlob, 'init.png');
      }
      if (sendMask && maskImageBlob) {
        formData.append('mask_image', maskImageBlob, 'mask.png');
      }

      // 3. Отправляем запрос на backend.
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
        // 4. Добавляем результат на холст. Картинку backend отдаёт инлайном
        // (image_data_url) — это убирает второй запрос к /outputs и ожидание
        // записи на диск ровно в момент «превью → чёткая».
        await editorRef.current.addGeneratedImage(response.data.url, response.data.image_data_url);

        // Sharp result is on the canvas now: kill the live-preview overlay and
        // its polling at once, so the blurry 384px preview doesn't linger on top
        // during the (slower) history snapshot below.
        previewController.abort();
        if (currentGenerationRequestIdRef.current === requestId) {
          currentGenerationRequestIdRef.current = null;
        }
        setGenerationPreview(null);

        // История — bookkeeping: снимок всего холста кодируется и грузится
        // отдельным запросом (через туннель — секунды). Не держим на нём статус
        // генерации, иначе кнопка «Остановить» висит уже после появления картинки.
        // Делаем в фоне — кнопка освобождается сразу (finally ниже), а пункт
        // истории добавится, когда снимок сохранится.
        void (async () => {
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

          const newHistoryItem = {
            id: createClientId('history'),
            url: historyDocumentUrl,
            generated_url: response.data.url,
            meta: historyMeta,
            timestamp: Date.now()
          };
          setHistory(prev => normalizeHistoryItems([newHistoryItem, ...prev]));
        })();
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
    if (editorRef.current.hasPendingCandidate?.()) {
      showInfo("Сначала прими или отклони текущий кандидат, затем запускай Spot Healing.");
      return;
    }

    const { normalized: normalizedParams, invalidFields } = normalizeGenerationParams(params);
    if (invalidFields.length > 0) {
      showError(`Некорректные числовые параметры: ${invalidFields.map(field => field.label).join(', ')}`);
      return;
    }

    spotHealInFlightRef.current = true;
    const controller = new AbortController();
    const requestId = createClientId('spot-heal');
    abortControllerRef.current = controller;
    currentGenerationRequestIdRef.current = requestId;
    setGenerationPreview(null);
    setGenerationLifecycleStatus(GENERATION_STATUS.GENERATING);

    try {
      const { image: initImageBlob, mask: maskImageBlob, width, height } = await editorRef.current.exportForSpotHeal({
        x,
        y,
        radius
      });

      if (!initImageBlob || !maskImageBlob) {
        throw new Error("Не удалось подготовить область для точечной ретуши.");
      }

      const formData = new FormData();
      formData.append('request_id', requestId);
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
        headers: { 'Content-Type': 'multipart/form-data' },
        signal: controller.signal
      });

      if (response.data?.status === 'success' && response.data?.url) {
        await editorRef.current.addGeneratedImage(response.data.url, response.data.image_data_url);
        await editorRef.current.acceptCandidateAsync?.();
        showSuccess("Точечная ретушь применена.");
      } else {
        throw new Error("Сервер не вернул результат точечной ретуши.");
      }
    } catch (error) {
      if (axios.isCancel(error)) {
        showInfo("Spot Healing отменён.");
        return;
      }
      console.error("Spot heal failed", error);
      const errorMsg = error.response?.data?.detail || error.message;
      showError(`Ошибка Spot Healing: ${errorMsg}`);
    } finally {
      spotHealInFlightRef.current = false;
      if (currentGenerationRequestIdRef.current === requestId) {
        currentGenerationRequestIdRef.current = null;
      }
      abortControllerRef.current = null;
      setGenerationPreview(null);
      if (generationStatusRef.current !== GENERATION_STATUS.CANCELLING) {
        setGenerationLifecycleStatus(GENERATION_STATUS.IDLE);
      }
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

  const handleQuickSelectionRefine = async () => {
    if (!editorRef.current) {
      return;
    }
    if (generationStatusRef.current !== GENERATION_STATUS.IDLE) {
      showInfo("Дождись завершения текущей генерации.");
      return;
    }
    if (quickSelectRefineInFlightRef.current) {
      return;
    }
    if (!editorRef.current.hasQuickSelection?.()) {
      showInfo("Сначала выдели область инструментом Quick Select (W).");
      return;
    }
    if (editorRef.current.hasPendingCandidate?.()) {
      showInfo("Сначала прими или отклони текущий кандидат, затем запускай Quick Select refine.");
      return;
    }

    const { normalized: normalizedParams, invalidFields } = normalizeGenerationParams(params);
    if (invalidFields.length > 0) {
      showError(`Некорректные числовые параметры: ${invalidFields.map(field => field.label).join(', ')}`);
      return;
    }

    quickSelectRefineInFlightRef.current = true;
    const controller = new AbortController();
    const requestId = createClientId('quick-select-refine');
    abortControllerRef.current = controller;
    currentGenerationRequestIdRef.current = requestId;
    setGenerationPreview(null);
    setGenerationLifecycleStatus(GENERATION_STATUS.GENERATING);

    try {
      const payload = await editorRef.current.exportForQuickSelectRefine?.();
      if (!payload?.image || !payload?.selection) {
        throw new Error("Не удалось подготовить выделение для перегенерации.");
      }

      const formData = new FormData();
      formData.append('request_id', requestId);
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
      formData.append('width', String(payload.width));
      formData.append('height', String(payload.height));
      formData.append('selection_left', String(payload.selection.left));
      formData.append('selection_top', String(payload.selection.top));
      formData.append('selection_width', String(payload.selection.width));
      formData.append('selection_height', String(payload.selection.height));
      formData.append('active_tool', 'quick_select');
      formData.append('init_image', payload.image, 'quick-select-init.png');
      if (payload.mask) {
        formData.append('mask_image', payload.mask, 'quick-select-mask.png');
      }

      const response = await axios.post(API_ENDPOINTS.QUICK_SELECT_REFINE, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        signal: controller.signal
      });

      if (response.data?.status === 'success' && response.data?.url) {
        await editorRef.current.addGeneratedImage(response.data.url, response.data.image_data_url);
        await editorRef.current.acceptCandidateAsync?.();
        showSuccess("Выделенная область перегенерирована.");
      } else {
        throw new Error("Сервер не вернул результат quick-select refine.");
      }
    } catch (error) {
      if (axios.isCancel(error)) {
        showInfo("Quick Select refine отменён.");
        return;
      }
      console.error("Quick-select refine failed", error);
      const errorMsg = error.response?.data?.detail || error.message;
      showError(`Ошибка Quick Select refine: ${errorMsg}`);
    } finally {
      quickSelectRefineInFlightRef.current = false;
      if (currentGenerationRequestIdRef.current === requestId) {
        currentGenerationRequestIdRef.current = null;
      }
      abortControllerRef.current = null;
      setGenerationPreview(null);
      if (generationStatusRef.current !== GENERATION_STATUS.CANCELLING) {
        setGenerationLifecycleStatus(GENERATION_STATUS.IDLE);
      }
    }
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

  const handleLayersChange = React.useCallback((nextLayers) => {
    setLayers(Array.isArray(nextLayers) ? nextLayers : []);
  }, []);

  const handleLayerSelect = React.useCallback((layerId) => {
    editorRef.current?.selectLayer?.(layerId);
  }, []);

  const handleLayerToggleVisibility = React.useCallback((layerId) => {
    editorRef.current?.toggleLayerVisibility?.(layerId);
  }, []);

  const handleLayerAdd = React.useCallback(async () => {
    const added = await editorRef.current?.addLayer?.();
    if (!added) {
      showInfo("Не удалось создать слой: выбери объект на холсте или сначала сгенерируй изображение.");
    } else {
      showSuccess("Новый слой создан.");
    }
  }, [showInfo, showSuccess]);

  const handleLayerToggleLock = React.useCallback((layerId) => {
    editorRef.current?.toggleLayerLock?.(layerId);
  }, []);

  const handleLayerStyleChange = React.useCallback((layerId, patch) => {
    editorRef.current?.updateLayerStyle?.(layerId, patch);
  }, []);

  return (
    <div
      ref={appContainerRef}
      className={`app-container ${isResizingSidebar ? 'app-container--resizing' : ''}`}
    >
      <div className="sidebar-shell" style={{ width: `${sidebarWidth}px` }}>
        <Sidebar
          availableModels={availableModels}
          onModelsRefresh={refreshModels}
          params={params}
          setParams={setParams}
          generationMode={generationMode}
          setGenerationMode={handleGenerationModeChange}
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
          onQuickSelectionRefine={handleQuickSelectionRefine}
          layers={layers}
          onLayerSelect={handleLayerSelect}
          onLayerAdd={handleLayerAdd}
          onLayerToggleVisibility={handleLayerToggleVisibility}
          onLayerToggleLock={handleLayerToggleLock}
          onLayerStyleChange={handleLayerStyleChange}
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
          setBrushColor={setBrushColor}
          brushSize={brushSize}
          generationPreview={generationPreview}
          onSpotHealPoint={handleSpotHealPoint}
          onLayersChange={handleLayersChange}
          onToolNotify={showInfo}
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
