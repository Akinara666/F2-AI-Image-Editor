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
  normalizeGenerationParams
} from './constants';
import './theme.css';
import './App.css';

const HISTORY_STORAGE_KEY = 'generation_history';
const HISTORY_STORAGE_VERSION = 2;
const HISTORY_MAX_ITEMS = 50;

const normalizeHistoryItem = (item) => {
  if (!item || typeof item !== 'object' || typeof item.url !== 'string' || !item.url.trim()) {
    return null;
  }

  const meta = item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta)
    ? item.meta
    : {};
  const timestamp = Number(item.timestamp);

  return {
    id: item.id ?? createClientId('history'),
    url: item.url,
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

function App() {
  const GENERATION_STATUS = {
    IDLE: 'idle',
    GENERATING: 'generating',
    CANCELLING: 'cancelling',
    RESTORING: 'restoring'
  };
  const { showSuccess, showError, showInfo } = useToast();
  const [availableModels, setAvailableModels] = useState([]);
  const [params, setParams] = useState({
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
  });

  // Fetch models on mount
  React.useEffect(() => {
    const fetchModels = async () => {
      try {
        const response = await axios.get(API_ENDPOINTS.MODELS);
        if (response.data && response.data.models) {
          setAvailableModels(response.data.models);
          // Auto-select first model if none selected
          setParams(prev => ({
            ...prev,
            model_id: prev.model_id === AVAILABLE_MODELS_PLACEHOLDER[0].id ? response.data.models[0].id : prev.model_id
          }));
        }
      } catch (err) {
        console.error("Failed to fetch models:", err);
        showError("Failed to load models list from server.");
      }
    };
    fetchModels();
  }, []);

  const [generationStatus, setGenerationStatus] = useState(GENERATION_STATUS.IDLE);
  const [history, setHistory] = useState(loadHistoryFromStorage);

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
  const [brushMode, setBrushMode] = useState('none'); // none, sketch, mask
  const [brushColor, setBrushColor] = useState('#ffffff');
  const [brushSize, setBrushSize] = useState(20);

  // Ref to Editor's export function
  const editorRef = React.useRef();
  const abortControllerRef = React.useRef(null);
  const currentGenerationRequestIdRef = React.useRef(null);
  const generationStatusRef = React.useRef(GENERATION_STATUS.IDLE);
  const setGenerationLifecycleStatus = (nextStatus) => {
    generationStatusRef.current = nextStatus;
    setGenerationStatus(nextStatus);
  };
  const isGenerating = generationStatus === GENERATION_STATUS.GENERATING || generationStatus === GENERATION_STATUS.CANCELLING;
  const isBusy = generationStatus !== GENERATION_STATUS.IDLE;

  const handleGenerate = async () => {
    if (!editorRef.current || generationStatusRef.current !== GENERATION_STATUS.IDLE) return;

    const { normalized: normalizedParams, invalidFields } = normalizeGenerationParams(params);
    if (invalidFields.length > 0) {
      showError(`Invalid numeric parameters: ${invalidFields.map(field => field.label).join(', ')}`);
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
    const requestId = createClientId('generation');
    abortControllerRef.current = controller;
    currentGenerationRequestIdRef.current = requestId;

    try {
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
        showSuccess("Image generated successfully!");
        if (response.data?.meta?.prompt_transform_status && response.data.meta.prompt_transform_status !== 'disabled') {
          showInfo(`Prompt transformer: ${response.data.meta.prompt_transform_status}`);
        }
        // 4. Add to Canvas
        await editorRef.current.addGeneratedImage(response.data.url);

        // 5. Add to History
        const newHistoryItem = {
          id: createClientId('history'),
          url: response.data.url,
          meta: response.data.meta || { prompt: normalizedParams.prompt, seed: normalizedParams.seed },
          timestamp: Date.now()
        };
        setHistory(prev => normalizeHistoryItems([newHistoryItem, ...prev]));
      }

    } catch (e) {
      if (axios.isCancel(e)) {
        console.log("Request canceled by user");
        // showSuccess is used here or showError, but usually cancellations don't need a harsh red error
        showError("Generation cancelled.");
      } else {
        console.error("Generation failed", e);
        const errorMsg = e.response?.data?.detail || e.message;
        console.error("Error details:", errorMsg);
        showError(`Generation failed: ${errorMsg}`);
      }
    } finally {
      abortControllerRef.current = null;
      if (currentGenerationRequestIdRef.current === requestId) {
        currentGenerationRequestIdRef.current = null;
      }
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

  const handleRestore = async (item) => {
    if (!editorRef.current || generationStatusRef.current !== GENERATION_STATUS.IDLE) {
      return;
    }

    setGenerationLifecycleStatus(GENERATION_STATUS.RESTORING);
    try {
      await editorRef.current.addGeneratedImage(item.url);
      showSuccess("History item restored to preview.");
    } catch (e) {
      console.error("Failed to restore history item", e);
      const errorMsg = e.response?.data?.detail || e.message;
      showError(`Failed to restore history item: ${errorMsg}`);
    } finally {
      setGenerationLifecycleStatus(GENERATION_STATUS.IDLE);
    }
  };

  return (
    <div className="app-container">
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
        onUndo={() => editorRef.current?.undo()}
        onClear={() => editorRef.current?.clearAll()}
        editorRef={editorRef}
        showToastError={showError}
        showToastSuccess={showSuccess}
        showToastInfo={showInfo}
      />
      <div className="editor-wrapper">
        <Editor
          ref={editorRef}
          brushMode={brushMode}
          brushColor={brushColor}
          brushSize={brushSize}
        />
      </div>
      <HistoryPanel
        history={history}
        onSelect={handleRestore}
        isBusy={isBusy}
      />
    </div>
  );
}

export default App;
