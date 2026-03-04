import React from 'react';
import { AVAILABLE_SAMPLERS, AVAILABLE_SIZES } from '../constants';

const Sidebar = ({
    availableModels,
    params, setParams,
    isGenerating, onGenerate, onCancel,
    brushMode, setBrushMode,
    brushColor, setBrushColor,
    brushSize, setBrushSize,
    onUndo, onClear, editorRef
}) => {

    const handleChange = (e) => {
        const { name, value, type } = e.target;

        if (name === 'frame_size_index') {
            const idx = parseInt(value);
            const size = AVAILABLE_SIZES[idx];
            if (editorRef && editorRef.current) {
                editorRef.current.setGenFrameSize(size.width, size.height);
            }
            setParams(prev => ({
                ...prev,
                [name]: idx
            }));
        } else {
            setParams(prev => ({
                ...prev,
                [name]: type === 'number' ? parseFloat(value) : value
            }));
        }
    };

    return (
        <div className="panel sidebar" style={{
            width: '20rem',
            minWidth: '250px',
            maxWidth: '400px',
            display: 'flex',
            flexDirection: 'column',
            animation: 'slideInLeft 0.3s ease',
            height: '100%',
            overflow: 'hidden' // Main container doesn't scroll
        }}>

            {/* Scrollable Content */}
            <div className="custom-scrollbar" style={{
                flex: 1,
                overflowY: 'auto',
                padding: 'var(--spacing-md)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--spacing-md)'
            }}>
                <h2 style={{ margin: '0', color: 'var(--primary)' }}>AI Settings</h2>

                {/* Model & Sampler */}
                <div className="input-group">
                    <label className="input-label">Model</label>
                    <select
                        name="model_id"
                        className="input-field"
                        value={params.model_id}
                        onChange={handleChange}
                        style={{ padding: '8px' }}
                    >
                        {availableModels.map(m => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                    </select>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--spacing-sm)' }}>
                    <div className="input-group">
                        <label className="input-label">Sampler</label>
                        <select
                            name="sampler"
                            className="input-field"
                            value={params.sampler}
                            onChange={handleChange}
                            style={{ padding: '8px' }}
                        >
                            {AVAILABLE_SAMPLERS.map(s => (
                                <option key={s} value={s}>{s}</option>
                            ))}
                        </select>
                    </div>
                    <div className="input-group">
                        <label className="input-label">Frame Size</label>
                        <select
                            name="frame_size_index"
                            className="input-field"
                            value={params.frame_size_index}
                            onChange={handleChange}
                            style={{ padding: '8px' }}
                        >
                            {AVAILABLE_SIZES.map((s, idx) => (
                                <option key={idx} value={idx}>{s.label}</option>
                            ))}
                        </select>
                    </div>
                </div>

                {/* Prompt */}
                <div className="input-group">
                    <label className="input-label">Prompt</label>
                    <textarea
                        name="prompt"
                        className="input-field"
                        value={params.prompt}
                        onChange={handleChange}
                        style={{ height: '80px' }}
                    />
                </div>

                {/* Negative Prompt */}
                <div className="input-group">
                    <label className="input-label">Negative Prompt</label>
                    <textarea
                        name="negative_prompt"
                        className="input-field"
                        value={params.negative_prompt}
                        onChange={handleChange}
                        style={{ height: '60px' }}
                    />
                </div>

                {/* Params */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--spacing-sm)' }}>
                    <div className="input-group">
                        <label className="input-label">Seed (-1 = Rnd)</label>
                        <input type="number" className="input-field" name="seed" value={params.seed} onChange={handleChange} />
                    </div>
                    <div className="input-group">
                        <label className="input-label">Steps</label>
                        <input type="number" className="input-field" name="steps" value={params.steps} onChange={handleChange} />
                    </div>
                </div>

                <div className="input-group">
                    <label className="input-label">CFG Scale ({params.cfg})</label>
                    <input type="range" className="input-range" name="cfg" min="1" max="20" step="0.5" value={params.cfg} onChange={handleChange} style={{ width: '100%', accentColor: 'var(--primary)' }} />
                </div>

                <div className="input-group">
                    <label className="input-label">Denoising ({params.denoising_strength})</label>
                    <input type="range" className="input-range" name="denoising_strength" min="0" max="1" step="0.05" value={params.denoising_strength} onChange={handleChange} style={{ width: '100%', accentColor: 'var(--accent)' }} />
                    <small style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>1.0 = Ignore Init Image</small>
                </div>

                <hr style={{ borderColor: 'var(--border)', width: '100%', margin: 'var(--spacing-sm) 0' }} />

                {/* Brush Controls */}
                <div className="input-group">
                    <h3 style={{ fontSize: '1rem', marginBottom: 'var(--spacing-sm)' }}>Brush Tools</h3>
                    <div style={{ display: 'flex', gap: 'var(--spacing-xs)', marginBottom: 'var(--spacing-md)', flexWrap: 'wrap' }}>
                        {[
                            { id: 'none', label: 'Cursor', color: 'var(--primary)' },
                            { id: 'sketch', label: 'Sketch', color: 'var(--primary)' },
                            { id: 'mask', label: 'Mask', color: 'var(--danger)' },
                            { id: 'hand', label: 'Hand', color: 'var(--accent)' },
                            { id: 'eraser', label: 'Eraser', color: '#f4a261' },
                        ].map(tool => (
                            <button
                                key={tool.id}
                                className="btn"
                                onClick={() => setBrushMode(tool.id)}
                                style={{
                                    flex: 1,
                                    minWidth: '60px',
                                    background: brushMode === tool.id ? tool.color : 'var(--bg-hover)',
                                    color: brushMode === tool.id ? '#fff' : 'var(--text-muted)',
                                    padding: '6px',
                                    fontSize: '0.85rem'
                                }}
                            >
                                {tool.label}
                            </button>
                        ))}
                    </div>

                    {brushMode !== 'none' && (
                        <div className="input-group" style={{ animation: 'fadeIn 0.2s' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}>
                                <label className="input-label" style={{ marginBottom: 0, width: '60px' }}>Size: {brushSize}</label>
                                <input type="range" min="1" max="100" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value))} style={{ flex: 1, accentColor: 'var(--text-main)' }} />
                                {brushMode === 'sketch' && (
                                    <input type="color" value={brushColor} onChange={(e) => setBrushColor(e.target.value)} style={{ width: '30px', height: '30px', border: 'none', padding: 0, background: 'transparent' }} />
                                )}
                            </div>
                        </div>
                    )}

                    {brushMode === 'mask' && (
                        <div className="input-group" style={{ animation: 'fadeIn 0.2s', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm)', background: 'rgba(42,42,42,0.35)' }}>
                            <h4 style={{ margin: '0 0 var(--spacing-sm) 0', fontSize: '0.9rem', color: 'var(--danger)' }}>Inpaint Mask</h4>

                            <div className="input-group" style={{ marginBottom: 'var(--spacing-sm)' }}>
                                <label className="input-label">Mask Blur ({params.mask_blur})</label>
                                <input type="range" className="input-range" name="mask_blur" min="0" max="64" step="1" value={params.mask_blur} onChange={handleChange} style={{ width: '100%' }} />
                            </div>

                            <div className="input-group" style={{ marginBottom: 'var(--spacing-sm)' }}>
                                <label className="input-label">Mask Padding ({params.mask_padding})</label>
                                <input type="range" className="input-range" name="mask_padding" min="0" max="128" step="1" value={params.mask_padding} onChange={handleChange} style={{ width: '100%' }} />
                            </div>
                            <small style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
                                Blur размягчает край, Padding расширяет зону правки.
                            </small>
                        </div>
                    )}

                    <div style={{ display: 'flex', gap: 'var(--spacing-sm)', marginTop: 'var(--spacing-md)' }}>
                        <button className="btn btn-secondary" onClick={onUndo} style={{ flex: 1 }}>
                            ↶ Undo
                        </button>
                        <button className="btn btn-secondary" onClick={onClear} style={{ flex: 1, borderColor: 'var(--danger)', color: 'var(--danger)' }}>
                            Clear
                        </button>
                    </div>
                </div>
            </div>

            {/* Footer - Fixed Button */}
            <div style={{
                padding: 'var(--spacing-md)',
                borderTop: '1px solid var(--border)',
                background: 'var(--bg-panel)'
            }}>
                {isGenerating ? (
                    <button
                        className="btn btn-primary"
                        onClick={onCancel}
                        style={{
                            width: '100%',
                            padding: 'var(--spacing-md)',
                            fontSize: '1.1rem',
                            backgroundColor: 'var(--danger)',
                            borderColor: 'var(--danger)',
                            cursor: 'pointer'
                        }}
                    >
                        🛑 CANCEL
                    </button>
                ) : (
                    <button
                        className="btn btn-primary"
                        onClick={onGenerate}
                        style={{
                            width: '100%',
                            padding: 'var(--spacing-md)',
                            fontSize: '1.1rem',
                            cursor: 'pointer'
                        }}
                    >
                        ✨ GENERATE
                    </button>
                )}
            </div>
        </div>
    );
};

export default Sidebar;
