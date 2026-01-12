import React from 'react';

const Sidebar = ({ 
    params, setParams, 
    isGenerating, onGenerate, 
    brushMode, setBrushMode,
    brushColor, setBrushColor,
    brushSize, setBrushSize,
    onUndo, onClear
}) => {
    
    const handleChange = (e) => {
        const { name, value, type } = e.target;
        setParams(prev => ({
            ...prev,
            [name]: type === 'number' ? parseFloat(value) : value
        }));
    };

    return (
        <div style={{
            width: '300px', 
            background: '#2b2b2b', 
            color: '#eee', 
            padding: '15px',
            display: 'flex',
            flexDirection: 'column',
            gap: '15px',
            borderRight: '1px solid #444',
            overflowY: 'auto'
        }}>
            <h2 style={{margin: '0 0 10px 0'}}>Settings</h2>

            {/* Prompt */}
            <div>
                <label>Prompt</label>
                <textarea 
                    name="prompt" 
                    value={params.prompt} 
                    onChange={handleChange}
                    style={{width: '100%', height: '80px', background: '#111', color: '#fff', border: '1px solid #555'}}
                />
            </div>

            {/* Negative Prompt */}
            <div>
                <label>Negative Prompt</label>
                <textarea 
                    name="negative_prompt" 
                    value={params.negative_prompt} 
                    onChange={handleChange}
                    style={{width: '100%', height: '60px', background: '#111', color: '#fff', border: '1px solid #555'}}
                />
            </div>

            {/* Params */}
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px'}}>
                <div>
                    <label>Seed (-1 = Rnd)</label>
                    <input type="number" name="seed" value={params.seed} onChange={handleChange} style={{width: '100%'}}/>
                </div>
                <div>
                    <label>Steps</label>
                    <input type="number" name="steps" value={params.steps} onChange={handleChange} style={{width: '100%'}}/>
                </div>
            </div>

            <div>
                <label>CFG Scale ({params.cfg})</label>
                <input type="range" name="cfg" min="1" max="20" step="0.5" value={params.cfg} onChange={handleChange} style={{width: '100%'}}/>
            </div>

            <div>
                <label>Denoising Strength ({params.denoising_strength})</label>
                <input type="range" name="denoising_strength" min="0" max="1" step="0.05" value={params.denoising_strength} onChange={handleChange} style={{width: '100%'}}/>
                <small style={{color: '#aaa'}}>1.0 = Ignore Init Image (Txt2Img)</small>
            </div>

            <hr style={{borderColor: '#444', width: '100%'}} />

            {/* Brush Controls */}
             <div>
                <h3>Brush</h3>
                <div style={{display: 'flex', gap: '5px', marginBottom: '10px'}}>
                    <button 
                        onClick={() => setBrushMode('none')}
                        style={{flex: 1, background: brushMode === 'none' ? '#007acc' : '#444', color: '#fff', border: 'none', padding: '5px'}}
                    >Cursor</button>
                    <button 
                        onClick={() => setBrushMode('sketch')}
                        style={{flex: 1, background: brushMode === 'sketch' ? '#007acc' : '#444', color: '#fff', border: 'none', padding: '5px'}}
                    >Sketch</button>
                    <button 
                        onClick={() => setBrushMode('mask')}
                        style={{flex: 1, background: brushMode === 'mask' ? '#e63946' : '#444', color: '#fff', border: 'none', padding: '5px'}}
                    >Mask</button>
                </div>
                
                {brushMode !== 'none' && (
                    <>
                        <div>
                            <label>Size: {brushSize}</label>
                            <input type="range" min="1" max="100" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value))} style={{width: '100%'}}/>
                        </div>
                        {brushMode === 'sketch' && (
                            <div>
                                <label>Color</label>
                                <input type="color" value={brushColor} onChange={(e) => setBrushColor(e.target.value)} style={{width: '100%', height: '30px'}}/>
                            </div>
                        )}
                    </>
                )}
                
                <div style={{display: 'flex', gap: '5px', marginTop: '10px'}}>
                     <button onClick={onUndo} style={{flex: 1, padding: '5px', background: '#555', color: '#fff', border: '1px solid #777', cursor: 'pointer'}}>
                        ↶ Undo
                     </button>
                     <button onClick={onClear} style={{flex: 1, padding: '5px', background: '#e63946', color: '#fff', border: '1px solid #777', cursor: 'pointer'}}>
                        Clear Sketches
                     </button>
                </div>
            </div>

            <hr style={{borderColor: '#444', width: '100%'}} />

            <button 
                onClick={onGenerate}
                disabled={isGenerating}
                style={{
                    padding: '15px', 
                    background: isGenerating ? '#555' : 'linear-gradient(45deg, #007acc, #00d4ff)', 
                    color: '#fff', 
                    border: 'none', 
                    fontWeight: 'bold',
                    cursor: isGenerating ? 'not-allowed' : 'pointer'
                }}
            >
                {isGenerating ? 'Generating...' : 'GENERATE'}
            </button>
        </div>
    );
};

export default Sidebar;
