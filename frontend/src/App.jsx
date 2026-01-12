import React, { useState } from 'react';
import Editor from './components/Editor';
import Sidebar from './components/Sidebar';
import axios from 'axios';

function App() {
  const [params, setParams] = useState({
    prompt: "A futuristic city",
    negative_prompt: "low quality, blurry",
    seed: -1,
    steps: 20,
    cfg: 7.5,
    denoising_strength: 0.75,
    model_id: "runwayml/stable-diffusion-v1-5"
  });

  const [isGenerating, setIsGenerating] = useState(false);
  const [brushMode, setBrushMode] = useState('none'); // none, sketch, mask
  const [brushColor, setBrushColor] = useState('#000000');
  const [brushSize, setBrushSize] = useState(20);
  
  // Ref to Editor's export function
  const editorRef = React.useRef();

  const handleGenerate = async () => {
    if (!editorRef.current) return;
    setIsGenerating(true);

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
        formData.append('model_id', params.model_id);
        
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
        const response = await axios.post('/generate', formData, {
            headers: { 'Content-Type': 'multipart/form-data' }
        });

        if (response.data.status === 'success') {
            console.log("Generated:", response.data.url);
            // 4. Add to Canvas
            editorRef.current.addGeneratedImage(response.data.url);
        }

    } catch (e) {
        console.error("Generation failed", e);
        alert("Error: " + (e.response?.data?.detail || e.message));
    } finally {
        setIsGenerating(false);
    }
  };

  return (
    <div className="App" style={{ 
        display: 'flex', 
        width: '100vw', 
        height: '100vh', 
        overflow: 'hidden',
        background: '#222'
    }}>
      <Sidebar 
         params={params} 
         setParams={setParams}
         isGenerating={isGenerating}
         onGenerate={handleGenerate}
         brushMode={brushMode}
         setBrushMode={setBrushMode}
         brushColor={brushColor}
         setBrushColor={setBrushColor}
         brushSize={brushSize}
         setBrushSize={setBrushSize}
         onUndo={() => editorRef.current?.undo()}
         onClear={() => editorRef.current?.clearAll()}
      />
      <div style={{ flex: 1, position: 'relative' }}>
          <Editor 
            ref={editorRef}
            brushMode={brushMode}
            brushColor={brushColor}
            brushSize={brushSize}
          />
      </div>
    </div>
  );
}

export default App;
