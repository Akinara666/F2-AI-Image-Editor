import React, { useEffect, useState } from 'react';
import axios from 'axios';
import {
    AVAILABLE_SAMPLERS,
    AVAILABLE_SIZES,
    API_ENDPOINTS,
    parseGenerationNumericParam
} from '../constants';
import './Sidebar.css';

const DIRECT_NUMBER_FIELDS = ['cfg', 'denoising_strength', 'mask_blur', 'mask_padding'];
const TEXT_NUMBER_FIELDS = ['seed', 'steps'];
const getPromptTransformStageLabel = (elapsedMs) => {
    if (elapsedMs < 1200) {
        return 'Отправляем запрос в AI-модуль';
    }
    if (elapsedMs < 5000) {
        return 'Загружаем модель и подготавливаем контекст';
    }
    if (elapsedMs < 12000) {
        return 'Анализируем промпт и собираем улучшенную версию';
    }
    return 'Первый запуск может быть долгим, ждём ответ модели';
};

const Sidebar = ({
    availableModels,
    params, setParams,
    isGenerating, isBusy, generationStatus, onGenerate, onCancel,
    brushMode, setBrushMode,
    brushColor, setBrushColor,
    brushSize, setBrushSize,
    onUndo, onClear, editorRef,
    showToastError, showToastSuccess, showToastInfo
}) => {
    const [activeTab, setActiveTab] = useState('generation');
    const [isTransformingPrompt, setIsTransformingPrompt] = useState(false);
    const [promptTransformElapsedMs, setPromptTransformElapsedMs] = useState(0);
    const [numberDrafts, setNumberDrafts] = useState({
        seed: String(params.seed),
        steps: String(params.steps)
    });

    useEffect(() => {
        setNumberDrafts({
            seed: String(params.seed),
            steps: String(params.steps)
        });
    }, [params.seed, params.steps]);

    useEffect(() => {
        if (!isTransformingPrompt) {
            setPromptTransformElapsedMs(0);
            return undefined;
        }

        const startedAt = Date.now();
        const intervalId = window.setInterval(() => {
            setPromptTransformElapsedMs(Date.now() - startedAt);
        }, 120);

        return () => {
            window.clearInterval(intervalId);
        };
    }, [isTransformingPrompt]);

    const handleChange = (e) => {
        const { name, value, type } = e.target;

        if (name === 'frame_size_index') {
            const parsed = parseGenerationNumericParam(name, value);
            if (!parsed.valid) {
                return;
            }
            const idx = parsed.value;
            const size = AVAILABLE_SIZES[idx];
            if (editorRef && editorRef.current) {
                editorRef.current.setGenFrameSize(size.width, size.height);
            }
            setParams(prev => ({
                ...prev,
                [name]: idx
            }));
            return;
        }

        if (TEXT_NUMBER_FIELDS.includes(name)) {
            setNumberDrafts(prev => ({
                ...prev,
                [name]: value
            }));
            const parsed = parseGenerationNumericParam(name, value);
            if (!parsed.valid) {
                return;
            }
            setParams(prev => ({
                ...prev,
                [name]: parsed.value
            }));
            return;
        }

        if (DIRECT_NUMBER_FIELDS.includes(name) || type === 'range') {
            const parsed = parseGenerationNumericParam(name, value);
            if (!parsed.valid) {
                return;
            }
            setParams(prev => ({
                ...prev,
                [name]: parsed.value
            }));
            return;
        }

        setParams(prev => ({
            ...prev,
            [name]: value
        }));
    };

    const handleNumberBlur = (name) => {
        const parsed = parseGenerationNumericParam(name, numberDrafts[name]);
        const nextValue = parsed.valid ? parsed.value : params[name];
        setNumberDrafts(prev => ({
            ...prev,
            [name]: String(nextValue)
        }));
        if (parsed.valid && params[name] !== nextValue) {
            setParams(prev => ({
                ...prev,
                [name]: nextValue
            }));
        }
    };

    const handleTransformPrompt = async () => {
        if (!params.prompt.trim()) return;

        setIsTransformingPrompt(true);
        try {
            const response = await axios.post(API_ENDPOINTS.PROMPT_TRANSFORM, {
                prompt: params.prompt,
                negative_prompt: params.negative_prompt,
                use_prompt_transform: true
            });

            if (response.data.status === 'success') {
                const result = response.data.data;
                setParams(prev => ({
                    ...prev,
                    prompt: result.transformed_prompt || prev.prompt,
                    negative_prompt: result.transformed_negative_prompt || prev.negative_prompt
                }));
                showToastSuccess("Промпт успешно улучшен.");
                if (result.transform_status && result.transform_status !== 'disabled') {
                    showToastInfo(`Трансформер: ${result.provider} (${result.latency_ms} мс)`);
                }
            }
        } catch (e) {
            console.error("Prompt transform failed", e);
            const errorMsg = e.response?.data?.detail || e.message;
            showToastError(`Ошибка улучшения промпта: ${errorMsg}`);
        } finally {
            setIsTransformingPrompt(false);
        }
    };

    return (
        <div className="panel sidebar">

            {/* Scrollable Content */}
            <div className="custom-scrollbar sidebar__content">
                <h2 className="sidebar__title">Настройки AI</h2>

                <div className="sidebar__tabs" role="tablist" aria-label="Режим панели">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'generation'}
                        className={`btn sidebar__tab-btn ${activeTab === 'generation' ? 'sidebar__tab-btn--active' : ''}`}
                        onClick={() => setActiveTab('generation')}
                    >
                        Generation
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'tools'}
                        className={`btn sidebar__tab-btn ${activeTab === 'tools' ? 'sidebar__tab-btn--active' : ''}`}
                        onClick={() => setActiveTab('tools')}
                    >
                        Tools
                    </button>
                </div>

                {activeTab === 'generation' && (
                    <>
                        {/* Model & Sampler */}
                        <div className="input-group">
                            <label className="input-label">Модель</label>
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
                                <label className="input-label">Сэмплер</label>
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
                                <label className="input-label">Размер рамки</label>
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
                            <div className="sidebar__prompt-header sidebar__prompt-header--stacked">
                                <label className="input-label">Промпт</label>
                                <div className="sidebar__prompt-enhancer">
                                    <div className="sidebar__prompt-enhancer-copy">
                                        <div className="sidebar__prompt-enhancer-title">Улучшение промпта AI</div>
                                        <div className="sidebar__prompt-enhancer-caption">
                                            Делает промпт и негативный промпт чище и точнее для более детальной генерации.
                                        </div>
                                    </div>
                                    <button
                                        className="btn sidebar__prompt-enhancer-btn"
                                        onClick={handleTransformPrompt}
                                        disabled={isTransformingPrompt || !params.prompt.trim()}
                                        title="Улучшить промпт с помощью AI"
                                    >
                                        <span className="sidebar__prompt-enhancer-icon" aria-hidden="true">
                                            {isTransformingPrompt ? '⌛' : '✨'}
                                        </span>
                                        <span className="sidebar__prompt-enhancer-label">
                                            {isTransformingPrompt ? 'Улучшаем промпт...' : 'Улучшить промпт с AI'}
                                        </span>
                                    </button>
                                    {isTransformingPrompt && (
                                        <div className="sidebar__prompt-transform-status" aria-live="polite">
                                            <div className="sidebar__prompt-transform-status-header">
                                                <div className="sidebar__prompt-transform-spinner" aria-hidden="true" />
                                                <div className="sidebar__prompt-transform-copy">
                                                    <div className="sidebar__prompt-transform-title">AI обрабатывает промпт</div>
                                                    <div className="sidebar__prompt-transform-caption">
                                                        {getPromptTransformStageLabel(promptTransformElapsedMs)}
                                                    </div>
                                                </div>
                                                <div className="sidebar__prompt-transform-time">
                                                    {(promptTransformElapsedMs / 1000).toFixed(1)} c
                                                </div>
                                            </div>
                                            <div className="sidebar__prompt-transform-progress">
                                                <div className="sidebar__prompt-transform-progress-bar" />
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                            <textarea
                                name="prompt"
                                className="input-field sidebar__prompt-field"
                                value={params.prompt}
                                onChange={handleChange}
                            />
                        </div>

                        {/* Negative Prompt */}
                        <div className="input-group">
                            <label className="input-label">Негативный промпт</label>
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
                                <label className="input-label">Сид (-1 = случайный)</label>
                                <input
                                    type="number"
                                    className="input-field"
                                    name="seed"
                                    min="-1"
                                    max="4294967295"
                                    step="1"
                                    value={numberDrafts.seed}
                                    onChange={handleChange}
                                    onBlur={() => handleNumberBlur('seed')}
                                />
                            </div>
                            <div className="input-group">
                                <label className="input-label">Шаги</label>
                                <input
                                    type="number"
                                    className="input-field"
                                    name="steps"
                                    min="1"
                                    max="150"
                                    step="1"
                                    value={numberDrafts.steps}
                                    onChange={handleChange}
                                    onBlur={() => handleNumberBlur('steps')}
                                />
                            </div>
                        </div>

                        <div className="input-group">
                            <label className="input-label">CFG ({params.cfg})</label>
                            <input type="range" className="input-range sidebar__range sidebar__range--primary" name="cfg" min="1" max="20" step="0.5" value={params.cfg} onChange={handleChange} />
                        </div>

                        <div className="input-group">
                            <label className="input-label">Денойзинг ({params.denoising_strength})</label>
                            <input type="range" className="input-range sidebar__range sidebar__range--accent" name="denoising_strength" min="0" max="1" step="0.05" value={params.denoising_strength} onChange={handleChange} />
                            <small className="sidebar__hint">1.0 = полностью игнорировать исходное изображение</small>
                        </div>
                    </>
                )}

                {/* Brush Controls */}
                {activeTab === 'tools' && (
                    <>
                        <div className="input-group">
                            <h3 className="sidebar__section-title">Инструменты</h3>
                            <div className="sidebar__tool-bar">
                                {[
                                    {
                                        id: 'none', label: 'Курсор', color: 'var(--primary)', icon: (
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
                                                <path d="M13 13l6 6" />
                                            </svg>
                                        )
                                    },
                                    {
                                        id: 'sketch', label: 'Скетч', color: 'var(--primary)', icon: (
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                                            </svg>
                                        )
                                    },
                                    {
                                        id: 'mask', label: 'Маска', color: 'var(--danger)', icon: (
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <circle cx="12" cy="12" r="10" />
                                                <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
                                            </svg>
                                        )
                                    },
                                    {
                                        id: 'hand', label: 'Рука', color: 'var(--accent)', icon: (
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M18 11V6a2 2 0 0 0-4 0v5" />
                                                <path d="M14 10V4a2 2 0 0 0-4 0v6" />
                                                <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
                                                <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
                                            </svg>
                                        )
                                    },
                                    {
                                        id: 'eraser', label: 'Ластик', color: 'var(--warning)', icon: (
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
                                            color: brushMode === tool.id ? 'white' : 'var(--text-muted)'
                                        }}
                                        title={tool.label}
                                    >
                                        {tool.icon}
                                        <span className="sidebar__tool-label">{tool.label}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {brushMode !== 'none' && (
                            <div className="input-group sidebar__brush-options">
                                <div className="sidebar__brush-row">
                                    <label className="input-label sidebar__brush-label">Размер: {brushSize}</label>
                                    <input type="range" className="sidebar__range sidebar__range--neutral" min="1" max="100" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value))} style={{ flex: 1 }} />
                                    {brushMode === 'sketch' && (
                                        <input type="color" className="sidebar__color-picker" value={brushColor} onChange={(e) => setBrushColor(e.target.value)} />
                                    )}
                                </div>
                            </div>
                        )}

                        {brushMode === 'mask' && (
                            <div className="input-group sidebar__mask-panel">
                                <h4 className="sidebar__mask-title">Маска инпейнта</h4>

                                <div className="input-group sidebar__mask-group">
                                    <label className="input-label">Размытие маски ({params.mask_blur})</label>
                                    <input type="range" className="input-range sidebar__range" name="mask_blur" min="0" max="128" step="1" value={params.mask_blur} onChange={handleChange} />
                                </div>

                                <div className="input-group sidebar__mask-group">
                                    <label className="input-label">Расширение маски ({params.mask_padding})</label>
                                    <input type="range" className="input-range sidebar__range" name="mask_padding" min="0" max="128" step="1" value={params.mask_padding} onChange={handleChange} />
                                </div>
                                <small className="sidebar__mask-hint">
                                    Blur размягчает край, Padding расширяет зону правки.
                                </small>
                            </div>
                        )}

                        <div className="sidebar__actions">
                            <button className="btn btn-secondary sidebar__action-btn" onClick={onUndo}>
                                ↶ Отменить
                            </button>
                            <button className="btn btn-secondary sidebar__action-btn sidebar__action-btn--danger" onClick={onClear}>
                                Очистить
                            </button>
                        </div>
                    </>
                )}
            </div>

            {/* Footer - Fixed Button */}
            <div className="sidebar__footer">
                {isGenerating ? (
                    <button
                        className="btn btn-primary sidebar__cancel-btn"
                        onClick={onCancel}
                        disabled={generationStatus === 'cancelling'}
                    >
                        {generationStatus === 'cancelling' ? '⏳ ОТМЕНА…' : '🛑 ОТМЕНИТЬ'}
                    </button>
                ) : (
                    <button
                        className="btn btn-primary sidebar__generate-btn"
                        onClick={onGenerate}
                        disabled={isBusy}
                    >
                        {generationStatus === 'restoring' ? '⏳ ВОССТАНОВЛЕНИЕ…' : '✨ СГЕНЕРИРОВАТЬ'}
                    </button>
                )}
            </div>
        </div>
    );
};

export default Sidebar;
