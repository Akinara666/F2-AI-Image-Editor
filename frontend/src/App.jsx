import React, { useState } from 'react';
import Editor from './components/Editor';
import Sidebar from './components/Sidebar';
import HistoryPanel from './components/HistoryPanel';
import axios from 'axios';
import { useToast } from './components/ToastProvider';
import { API_ENDPOINTS, AVAILABLE_MODELS_PLACEHOLDER, AVAILABLE_SAMPLERS, AVAILABLE_SIZES } from './constants';
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
  const [history, setHistory] = useState(() => {
    try {
      const saved = localStorage.getItem('generation_history');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  // Persist history to localStorage
  React.useEffect(() => {
    try {
      localStorage.setItem('generation_history', JSON.stringify(history));
    } catch { /* quota exceeded — silently ignore */ }
  }, [history]);
  const [brushMode, setBrushMode] = useState('none'); // none, sketch, mask
  const [brushColor, setBrushColor] = useState('#ffffff');
  const [brushSize, setBrushSize] = useState(20);

  // Ref to Editor's export function
  const editorRef = React.useRef();
  const abortControllerRef = React.useRef(null);
  const generationStatusRef = React.useRef(GENERATION_STATUS.IDLE);
  const setGenerationLifecycleStatus = (nextStatus) => {
    generationStatusRef.current = nextStatus;
    setGenerationStatus(nextStatus);
  };
  const isGenerating = generationStatus === GENERATION_STATUS.GENERATING || generationStatus === GENERATION_STATUS.CANCELLING;
  const isBusy = generationStatus !== GENERATION_STATUS.IDLE;

  const handleGenerate = async () => {
    if (!editorRef.current || generationStatusRef.current !== GENERATION_STATUS.IDLE) return;
    setGenerationLifecycleStatus(GENERATION_STATUS.GENERATING);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      // 1. Get Crops from Editor
      const { image: initImageBlob, mask: maskImageBlob, width, height } = await editorRef.current.exportForGeneration();

      // 2. Prepare FormData
      const formData = new FormData();
      formData.append('prompt', params.prompt);
      formData.append('raw_prompt', params.prompt);
      formData.append('use_prompt_transform', 'false');
      formData.append('negative_prompt', params.negative_prompt);
      formData.append('seed', params.seed);
      formData.append('steps', params.steps);
      formData.append('cfg', params.cfg);
      formData.append('denoising_strength', params.denoising_strength);
      formData.append('mask_blur', params.mask_blur);
      formData.append('mask_padding', params.mask_padding);
      formData.append('model_id', params.model_id);
      formData.append('sampler', params.sampler);

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
          id: Date.now(),
          url: response.data.url,
          meta: response.data.meta || { prompt: params.prompt, seed: params.seed },
          timestamp: Date.now()
        };
        setHistory(prev => [newHistoryItem, ...prev]);
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
      await axios.post(API_ENDPOINTS.CANCEL);
    } catch (e) {
      console.error("Failed to cleanly cancel on server", e);
    } finally {
      abortControllerRef.current = null;
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
