import React from 'react';
import { AVAILABLE_SAMPLERS, AVAILABLE_SIZES } from '../constants';
import './Sidebar.css';

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
        <div className="panel sidebar">

            {/* Scrollable Content */}
            <div className="custom-scrollbar sidebar__content">
                <h2 className="sidebar__title">AI Settings</h2>

                {/* Model & Sampler */}
                <div className="input-group">
                    <label className="input-label">Model</label>
                    <select
                        name="model_id"
                        className="input-field"
                        value={params.model_id}
                        onChange={handleChange}
                    >
                        {availableModels.map(m => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                    </select>
                </div>

                <div className="sidebar__grid-2col">
                    <div className="input-group">
                        <label className="input-label">Sampler</label>
                        <select
                            name="sampler"
                            className="input-field"
                            value={params.sampler}
                            onChange={handleChange}
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
                        className="input-field sidebar__prompt-field"
                        value={params.prompt}
                        onChange={handleChange}
                    />
                </div>

                <div className="input-group">
                    <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <input
                            type="checkbox"
                            checked={!!params.use_prompt_transform}
                            onChange={(e) => setParams(prev => ({ ...prev, use_prompt_transform: e.target.checked }))}
                        />
                        Use Prompt Transformer
                    </label>
                    <small className="sidebar__hint">Преобразует естественный язык в SD-стиль перед генерацией.</small>
                </div>

                {/* Negative Prompt */}
                <div className="input-group">
                    <label className="input-label">Negative Prompt</label>
                    <textarea
                        name="negative_prompt"
                        className="input-field sidebar__neg-prompt-field"
                        value={params.negative_prompt}
                        onChange={handleChange}
                    />
                </div>

                {/* Params */}
                <div className="sidebar__grid-2col">
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
                    <input type="range" className="input-range sidebar__range sidebar__range--primary" name="cfg" min="1" max="20" step="0.5" value={params.cfg} onChange={handleChange} />
                </div>

                <div className="input-group">
                    <label className="input-label">Denoising ({params.denoising_strength})</label>
                    <input type="range" className="input-range sidebar__range sidebar__range--accent" name="denoising_strength" min="0" max="1" step="0.05" value={params.denoising_strength} onChange={handleChange} />
                    <small className="sidebar__hint">1.0 = Ignore Init Image</small>
                </div>

                <hr className="sidebar__divider" />

                {/* Brush Controls */}
                <div className="input-group">
                    <h3 className="sidebar__section-title">Brush Tools</h3>
                    <div className="sidebar__tool-bar">
                        {[
                            {
                                id: 'none', label: 'Cursor', color: 'var(--primary)', icon: (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
                                        <path d="M13 13l6 6" />
                                    </svg>
                                )
                            },
                            {
                                id: 'sketch', label: 'Sketch', color: 'var(--primary)', icon: (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                                    </svg>
                                )
                            },
                            {
                                id: 'mask', label: 'Mask', color: 'var(--danger)', icon: (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="12" cy="12" r="10" />
                                        <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
                                    </svg>
                                )
                            },
                            {
                                id: 'hand', label: 'Hand', color: 'var(--accent)', icon: (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M18 11V6a2 2 0 0 0-4 0v5" />
                                        <path d="M14 10V4a2 2 0 0 0-4 0v6" />
                                        <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
                                        <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
                                    </svg>
                                )
                            },
                            {
                                id: 'eraser', label: 'Eraser', color: 'var(--warning)', icon: (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                                        <path d="M22 21H7" />
                                        <path d="m5 11 9 9" />
                                    </svg>
                                )
                            },
                        ].map(tool => (
                            <button
                                key={tool.id}
                                className={`btn sidebar__tool-btn ${brushMode === tool.id ? 'sidebar__tool-btn--active' : ''}`}
                                onClick={() => setBrushMode(tool.id)}
                                style={{
                                    background: brushMode === tool.id ? tool.color : 'var(--bg-hover)',
                                    color: brushMode === tool.id ? '#fff' : 'var(--text-muted)'
                                }}
                                title={tool.label}
                            >
                                {tool.icon}
                                <span className="sidebar__tool-label">{tool.label}</span>
                            </button>
                        ))}
                    </div>

                    {brushMode !== 'none' && (
                        <div className="input-group sidebar__brush-options">
                            <div className="sidebar__brush-row">
                                <label className="input-label sidebar__brush-label">Size: {brushSize}</label>
                                <input type="range" className="sidebar__range sidebar__range--neutral" min="1" max="100" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value))} style={{ flex: 1 }} />
                                {brushMode === 'sketch' && (
                                    <input type="color" className="sidebar__color-picker" value={brushColor} onChange={(e) => setBrushColor(e.target.value)} />
                                )}
                            </div>
                        </div>
                    )}

                    {brushMode === 'mask' && (
                        <div className="input-group sidebar__mask-panel">
                            <h4 className="sidebar__mask-title">Inpaint Mask</h4>

                            <div className="input-group sidebar__mask-group">
                                <label className="input-label">Mask Blur ({params.mask_blur})</label>
                                <input type="range" className="input-range sidebar__range" name="mask_blur" min="0" max="64" step="1" value={params.mask_blur} onChange={handleChange} />
                            </div>

                            <div className="input-group sidebar__mask-group">
                                <label className="input-label">Mask Padding ({params.mask_padding})</label>
                                <input type="range" className="input-range sidebar__range" name="mask_padding" min="0" max="128" step="1" value={params.mask_padding} onChange={handleChange} />
                            </div>
                            <small className="sidebar__mask-hint">
                                Blur размягчает край, Padding расширяет зону правки.
                            </small>
                        </div>
                    )}

                    <div className="sidebar__actions">
                        <button className="btn btn-secondary sidebar__action-btn" onClick={onUndo}>
                            ↶ Undo
                        </button>
                        <button className="btn btn-secondary sidebar__action-btn sidebar__action-btn--danger" onClick={onClear}>
                            Clear
                        </button>
                    </div>
                </div>
            </div>

            {/* Footer - Fixed Button */}
            <div className="sidebar__footer">
                {isGenerating ? (
                    <button
                        className="btn btn-primary sidebar__cancel-btn"
                        onClick={onCancel}
                    >
                        🛑 CANCEL
                    </button>
                ) : (
                    <button
                        className="btn btn-primary sidebar__generate-btn"
                        onClick={onGenerate}
                    >
                        ✨ GENERATE
                    </button>
                )}
            </div>
        </div>
    );
};

export default Sidebar;
