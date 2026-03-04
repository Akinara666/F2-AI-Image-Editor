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
                            { id: 'none', label: 'Cursor', color: 'var(--primary)' },
                            { id: 'sketch', label: 'Sketch', color: 'var(--primary)' },
                            { id: 'mask', label: 'Mask', color: 'var(--danger)' },
                            { id: 'hand', label: 'Hand', color: 'var(--accent)' },
                            { id: 'eraser', label: 'Eraser', color: '#f4a261' },
                        ].map(tool => (
                            <button
                                key={tool.id}
                                className="btn sidebar__tool-btn"
                                onClick={() => setBrushMode(tool.id)}
                                style={{
                                    background: brushMode === tool.id ? tool.color : 'var(--bg-hover)',
                                    color: brushMode === tool.id ? '#fff' : 'var(--text-muted)'
                                }}
                            >
                                {tool.label}
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
