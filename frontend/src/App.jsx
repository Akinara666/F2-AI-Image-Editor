import React, { useState } from 'react';
import Editor from './components/Editor';
import Sidebar from './components/Sidebar';
import HistoryPanel from './components/HistoryPanel';
import axios from 'axios';
import { useToast } from './components/ToastProvider';
import { API_ENDPOINTS, AVAILABLE_MODELS, AVAILABLE_SAMPLERS, AVAILABLE_SIZES } from './constants';
import './theme.css';
import './App.css';

function App() {
  const { showSuccess, showError } = useToast();
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
    model_id: AVAILABLE_MODELS[0].id,
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
            model_id: prev.model_id === AVAILABLE_MODELS[0].id ? response.data.models[0].id : prev.model_id
          }));
        }
      } catch (err) {
        console.error("Failed to fetch models:", err);
        showError("Failed to load models list from server.");
      }
    };
    fetchModels();
  }, []);

  const [isGenerating, setIsGenerating] = useState(false);
  const [abortController, setAbortController] = useState(null);
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

  const handleGenerate = async () => {
    if (!editorRef.current) return;
    setIsGenerating(true);

    const controller = new AbortController();
    setAbortController(controller);

    try {
      // 1. Get Crops from Editor
      const { image: initImageBlob, mask: maskImageBlob, width, height } = await editorRef.current.exportForGeneration();

      // 2. Prepare FormData
      const formData = new FormData();
      formData.append('prompt', params.prompt);
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
        // 4. Add to Canvas
        editorRef.current.addGeneratedImage(response.data.url);

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
      setIsGenerating(false);
      setAbortController(null);
    }
  };

  const handleCancel = async () => {
    if (abortController) {
      abortController.abort();
    }
    setIsGenerating(false);
    setAbortController(null);
    try {
      await axios.post(API_ENDPOINTS.CANCEL);
    } catch (e) {
      console.error("Failed to cleanly cancel on server", e);
    }
  };

  const handleRestore = (item) => {
    editorRef.current.addGeneratedImage(item.url);
  };

  return (
    <div className="app-container">
      <Sidebar
        availableModels={availableModels}
        params={params}
        setParams={setParams}
        isGenerating={isGenerating}
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
      />
      <div className="editor-wrapper" style={{ flex: 1, position: 'relative' }}>
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
      />
    </div>
  );
}

export default App;
