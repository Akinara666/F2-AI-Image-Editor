import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
    AVAILABLE_SAMPLERS,
    AVAILABLE_SIZES,
    API_ENDPOINTS,
    parseGenerationNumericParam
} from '../constants';
import ModelManager from './ModelManager';
import { DRAWING_TOOL_MODES, SELECTION_TOOL_MODES, TOOL_GROUPS, TOOL_MODES } from './editor/toolModes';
import { ADJUSTMENT_TYPES } from '../utils/imageFilters';
import { ADJUSTMENT_LABELS } from './AdjustmentsDialog';
import './Sidebar.css';

const DIRECT_NUMBER_FIELDS = ['cfg', 'denoising_strength', 'mask_blur', 'mask_padding'];
// Режимы, где есть кисть и уместен слайдер размера.
const BRUSH_SIZE_TOOL_MODES = [...DRAWING_TOOL_MODES, TOOL_MODES.SPOT_HEAL, TOOL_MODES.CLONE_STAMP];

const ADJUSTMENT_BUTTONS = [
    ADJUSTMENT_TYPES.BRIGHTNESS_CONTRAST,
    ADJUSTMENT_TYPES.LEVELS,
    ADJUSTMENT_TYPES.CURVES,
    ADJUSTMENT_TYPES.HUE_SATURATION,
    ADJUSTMENT_TYPES.INVERT,
    ADJUSTMENT_TYPES.GAUSSIAN_BLUR,
    ADJUSTMENT_TYPES.SHARPEN,
    ADJUSTMENT_TYPES.NOISE
];

const ADJUSTMENT_FAIL_MESSAGES = {
    candidate: 'Сначала прими или отмени сгенерированного кандидата.',
    busy: 'Сначала закрой открытую коррекцию.',
    'no-target': 'Нет растрового слоя для коррекции.',
    'not-ready': 'Холст ещё не готов.'
};
const TEXT_NUMBER_FIELDS = ['seed', 'steps'];
const LAYER_BLEND_MODES = [
    { id: 'normal', label: 'Обычный' },
    { id: 'multiply', label: 'Умножение' },
    { id: 'screen', label: 'Экран' },
    { id: 'overlay', label: 'Перекрытие' }
];

const LAYER_KIND_BG = {
    Raster: 'linear-gradient(135deg, rgba(44, 173, 150, 0.35), rgba(28, 94, 87, 0.6))',
    Candidate: 'linear-gradient(135deg, rgba(84, 110, 255, 0.32), rgba(53, 41, 120, 0.7))',
    Sketch: 'linear-gradient(135deg, rgba(255, 174, 66, 0.32), rgba(131, 78, 44, 0.72))',
    Mask: 'linear-gradient(135deg, rgba(140, 150, 170, 0.28), rgba(58, 63, 90, 0.58))'
};
const TOOL_ICONS = {
    none: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
            <path d="M13 13l6 6" />
        </svg>
    ),
    hand: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 11V6a2 2 0 0 0-4 0v5" />
            <path d="M14 10V4a2 2 0 0 0-4 0v6" />
            <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
            <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
        </svg>
    ),
    marquee_rect: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 3">
            <rect x="4" y="4" width="16" height="16" rx="1" />
        </svg>
    ),
    marquee_ellipse: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 3">
            <ellipse cx="12" cy="12" rx="8" ry="8" />
        </svg>
    ),
    lasso: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 22a5 5 0 0 1-2-4" />
            <path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1" />
            <path d="M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
        </svg>
    ),
    magic_wand: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m21 3-9.5 9.5" />
            <path d="m3 21 6-6" />
            <path d="M5 3v4" />
            <path d="M3 5h4" />
            <path d="M18 14v4" />
            <path d="M16 16h4" />
        </svg>
    ),
    quick_select: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 5h6" />
            <path d="M3 12h4" />
            <path d="M3 19h8" />
            <rect x="12" y="7" width="9" height="10" rx="2" />
        </svg>
    ),
    sketch: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
    ),
    text: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7V4h16v3" />
            <path d="M12 4v16" />
            <path d="M9 20h6" />
        </svg>
    ),
    shape: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="10" height="10" rx="1" />
            <circle cx="16" cy="16" r="5" />
        </svg>
    ),
    fill: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z" />
            <path d="m5 2 5 5" />
            <path d="M2 13h15" />
            <path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z" />
        </svg>
    ),
    gradient: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M7 3v18" strokeOpacity="0.9" />
            <path d="M12 3v18" strokeOpacity="0.55" />
            <path d="M17 3v18" strokeOpacity="0.25" />
        </svg>
    ),
    eyedropper: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m2 22 1-1h3l9-9" />
            <path d="M3 21v-3l9-9" />
            <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" />
        </svg>
    ),
    eraser: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
            <path d="M22 21H7" />
            <path d="m5 11 9 9" />
        </svg>
    ),
    mask: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
        </svg>
    ),
    spot_heal: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v18" />
            <path d="M3 12h18" />
            <path d="m18 6 1.5 1.5L22 5" />
        </svg>
    ),
    clone_stamp: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="9" width="16" height="10" rx="2" />
            <path d="M9 9V6a3 3 0 0 1 6 0v3" />
            <path d="M12 14h.01" />
        </svg>
    ),
    crop: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 2v14a2 2 0 0 0 2 2h14" />
            <path d="M18 22V8a2 2 0 0 0-2-2H2" />
        </svg>
    )
};

const TOOL_LOOKUP = TOOL_GROUPS
    .flatMap((group) => group.tools)
    .reduce((accumulator, tool) => {
        accumulator[tool.id] = tool;
        return accumulator;
    }, {});

// Карточка опций инструмента с заголовком: имя активного инструмента
// и его горячая клавиша — видно, к чему относятся настройки ниже.
const ToolPanel = ({ toolId, label, children }) => {
    const tool = TOOL_LOOKUP[toolId];
    const title = label || (tool ? tool.title.replace(/\s*\([A-Z]\)$/, '') : null);
    return (
        <div className="sidebar__tool-panel">
            {title && (
                <div className="sidebar__tool-panel-header">
                    <span className="sidebar__tool-panel-title">{title}</span>
                    {tool?.shortcut && <kbd className="sidebar__kbd">{tool.shortcut}</kbd>}
                </div>
            )}
            {children}
        </div>
    );
};

// Слайдер с заголовком и значением: имя слева, значение справа, ползунок
// на всю ширину, опциональный элемент (свотч/кнопка) справа от ползунка.
const SliderControl = ({ name, value, suffix = '', min, max, onChange, trailing = null }) => (
    <div className="sidebar__control">
        <div className="sidebar__control-header">
            <span className="sidebar__control-name">{name}</span>
            <span className="sidebar__control-value">{value}{suffix}</span>
        </div>
        <div className="sidebar__control-row">
            <input
                type="range"
                className="sidebar__range sidebar__range--primary"
                aria-label={name}
                min={min}
                max={max}
                value={value}
                onChange={(e) => onChange(parseInt(e.target.value, 10))}
            />
            {trailing}
        </div>
    </div>
);

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
    onModelsRefresh,
    params, setParams,
    isGenerating, isBusy, generationStatus, onGenerate, onCancel,
    brushMode, setBrushMode,
    brushColor, setBrushColor,
    brushSize, setBrushSize,
    onQuickSelectionCopy, onQuickSelectionPaste, onQuickSelectionRefine,
    layers, onLayerSelect, onLayerAdd, onLayerToggleVisibility, onLayerToggleLock, onLayerStyleChange,
    onUndo, onClear, editorRef,
    showToastError, showToastSuccess, showToastInfo
}) => {
    const [activeTab, setActiveTab] = useState('generation');
    const [isModelManagerOpen, setIsModelManagerOpen] = useState(false);
    const [isTransformingPrompt, setIsTransformingPrompt] = useState(false);
    const [promptTransformElapsedMs, setPromptTransformElapsedMs] = useState(0);
    const [numberDrafts, setNumberDrafts] = useState({
        seed: String(params.seed),
        steps: String(params.steps)
    });
    const [layerViewMode, setLayerViewMode] = useState('list');
    const [wandTolerance, setWandTolerance] = useState(32);
    const [featherRadius, setFeatherRadius] = useState(4);
    const [textFontSize, setTextFontSize] = useState(32);
    const [shapeKind, setShapeKind] = useState('rect');
    const [shapeOutlineOnly, setShapeOutlineOnly] = useState(false);
    const [shapeStrokeWidth, setShapeStrokeWidth] = useState(2);
    const [fillTolerance, setFillTolerance] = useState(32);
    const [gradientToTransparent, setGradientToTransparent] = useState(true);
    const [gradientEndColor, setGradientEndColor] = useState('#000000');
    const [imageSizeDraft, setImageSizeDraft] = useState({ width: '', height: '' });
    const [canvasSizeDraft, setCanvasSizeDraft] = useState({ width: '', height: '' });
    const [canvasAnchor, setCanvasAnchor] = useState({ x: 0.5, y: 0.5 });

    // При входе в режим кадрирования подтягиваем текущий размер рамки.
    useEffect(() => {
        if (brushMode !== TOOL_MODES.CROP) {
            return;
        }
        const frameSize = editorRef?.current?.getFrameSize?.();
        if (frameSize) {
            setImageSizeDraft({ width: String(frameSize.width), height: String(frameSize.height) });
            setCanvasSizeDraft({ width: String(frameSize.width), height: String(frameSize.height) });
        }
    }, [brushMode, editorRef]);
    const [importPanelOpen, setImportPanelOpen] = useState(false);
    const [importUrl, setImportUrl] = useState('');
    const [isImportingUrl, setIsImportingUrl] = useState(false);
    const [exportPanelOpen, setExportPanelOpen] = useState(false);
    const [exportFormat, setExportFormat] = useState('png');
    const [exportMode, setExportMode] = useState('content');
    const [exportQuality, setExportQuality] = useState(85);
    const fileInputRef = useRef(null);

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

    const selectedLayer = Array.isArray(layers) ? (layers.find((layer) => layer.isActive) || layers[0] || null) : null;
    const selectedLayerSettings = selectedLayer ? {
        opacity: Number.isFinite(Number(selectedLayer.opacity)) ? Number(selectedLayer.opacity) : 100,
        fill: Number.isFinite(Number(selectedLayer.fill)) ? Number(selectedLayer.fill) : 100,
        blendMode: selectedLayer.blendMode || 'normal',
        locked: selectedLayer.locked === true
    } : null;

    const updateSelectedLayerSettings = (patch) => {
        if (!selectedLayer) return;
        onLayerStyleChange?.(selectedLayer.id, patch);
    };

    const handleAddLayerClick = () => {
        onLayerAdd?.();
    };

    const handleFileChange = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        setImportPanelOpen(false);
        editorRef?.current?.importImage(file);
    };

    const handleUrlImport = async () => {
        const url = importUrl.trim();
        if (!url) return;
        setIsImportingUrl(true);
        try {
            await editorRef?.current?.importImageFromUrl(url);
            setImportUrl('');
            setImportPanelOpen(false);
            showToastSuccess('Изображение загружено');
        } catch {
            showToastError('Не удалось загрузить изображение по URL. Сервер может не поддерживать CORS.');
        } finally {
            setIsImportingUrl(false);
        }
    };

    const handleExportDownload = () => {
        editorRef?.current?.exportCanvas({
            format: exportFormat,
            mode: exportMode,
            quality: exportQuality / 100
        });
        setExportPanelOpen(false);
    };

    return (
        <div className="panel sidebar">

            {/* Прокручиваемое содержимое. */}
            <div className="custom-scrollbar sidebar__content">
                <h1 className="sidebar__title">Настройки AI</h1>

                <div
                    className="sidebar__tabs"
                    role="tablist"
                    aria-label="Режим панели"
                    onKeyDown={(e) => {
                        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                        e.preventDefault();
                        const next = activeTab === 'generation' ? 'tools' : 'generation';
                        setActiveTab(next);
                        e.currentTarget.querySelector(`#sidebar-tab-${next}`)?.focus();
                    }}
                >
                    <button
                        type="button"
                        role="tab"
                        id="sidebar-tab-generation"
                        aria-selected={activeTab === 'generation'}
                        tabIndex={activeTab === 'generation' ? 0 : -1}
                        className={`btn sidebar__tab-btn ${activeTab === 'generation' ? 'sidebar__tab-btn--active' : ''}`}
                        onClick={() => setActiveTab('generation')}
                    >
                        Генерация
                    </button>
                    <button
                        type="button"
                        role="tab"
                        id="sidebar-tab-tools"
                        aria-selected={activeTab === 'tools'}
                        tabIndex={activeTab === 'tools' ? 0 : -1}
                        className={`btn sidebar__tab-btn ${activeTab === 'tools' ? 'sidebar__tab-btn--active' : ''}`}
                        onClick={() => setActiveTab('tools')}
                    >
                        Инструменты
                    </button>
                </div>

                {activeTab === 'generation' && (
                    <>
                        {/* Модель и сэмплер. */}
                        <div className="input-group">
                            <div className="sidebar__label-row">
                                <label className="input-label" htmlFor="param-model">Модель</label>
                                <button
                                    type="button"
                                    className="sidebar__model-manage-btn"
                                    onClick={() => setIsModelManagerOpen(true)}
                                >
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <circle cx="12" cy="12" r="3" />
                                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                                    </svg>
                                    Модели
                                </button>
                            </div>
                            <select
                                id="param-model"
                                name="model_id"
                                className="input-field"
                                value={availableModels.length === 0 ? '' : params.model_id}
                                onChange={handleChange}
                                disabled={availableModels.length === 0}
                            >
                                {availableModels.length === 0 && (
                                    <option value="">Модели не загружены</option>
                                )}
                                {availableModels.map(m => (
                                    <option key={m.id} value={m.id}>{m.label}</option>
                                ))}
                            </select>
                            {availableModels.length === 0 && (
                                <small className="sidebar__hint">
                                    Сервер недоступен или модели не установлены.
                                    {' '}
                                    <button
                                        type="button"
                                        className="sidebar__link-btn"
                                        onClick={() => onModelsRefresh?.()}
                                    >
                                        Обновить список
                                    </button>
                                </small>
                            )}
                        </div>

                        <div className="sidebar__grid-2col">
                            <div className="input-group">
                                <label className="input-label" htmlFor="param-sampler">Сэмплер</label>
                                <select
                                    id="param-sampler"
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
                                <label className="input-label" htmlFor="param-frame-size">Размер рамки</label>
                                <select
                                    id="param-frame-size"
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

                        {/* Основной промпт. */}
                        <div className="input-group">
                            <div className="sidebar__prompt-header sidebar__prompt-header--stacked">
                                <label className="input-label" htmlFor="param-prompt">Промпт</label>
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
                                            {isTransformingPrompt ? (
                                                <span className="sidebar__btn-spinner" />
                                            ) : (
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
                                                    <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
                                                </svg>
                                            )}
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
                                id="param-prompt"
                                name="prompt"
                                className="input-field sidebar__prompt-field"
                                value={params.prompt}
                                onChange={handleChange}
                                placeholder="Что сгенерировать? Например: a futuristic city at sunset"
                            />
                        </div>

                        {/* Негативный промпт. */}
                        <div className="input-group">
                            <label className="input-label" htmlFor="param-negative-prompt">Негативный промпт</label>
                            <textarea
                                id="param-negative-prompt"
                                name="negative_prompt"
                                className="input-field sidebar__neg-prompt-field"
                                value={params.negative_prompt}
                                onChange={handleChange}
                                placeholder="Чего избегать: low quality, blurry…"
                            />
                        </div>

                        {/* Параметры генерации. */}
                        <div className="sidebar__grid-2col">
                            <div className="input-group">
                                <label className="input-label" htmlFor="param-seed">Сид (-1 = случайный)</label>
                                <input
                                    id="param-seed"
                                    type="number"
                                    inputMode="numeric"
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
                                <label className="input-label" htmlFor="param-steps">Шаги</label>
                                <input
                                    id="param-steps"
                                    type="number"
                                    inputMode="numeric"
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
                            <label className="input-label" htmlFor="param-cfg">CFG ({params.cfg})</label>
                            <input id="param-cfg" type="range" className="input-range sidebar__range sidebar__range--primary" name="cfg" min="1" max="20" step="0.5" value={params.cfg} onChange={handleChange} />
                        </div>

                        <div className="input-group">
                            <label className="input-label" htmlFor="param-denoising">Денойзинг ({params.denoising_strength})</label>
                            <input id="param-denoising" type="range" className="input-range sidebar__range sidebar__range--accent" name="denoising_strength" min="0" max="1" step="0.05" value={params.denoising_strength} onChange={handleChange} />
                            <small className="sidebar__hint">1.0 = полностью игнорировать исходное изображение</small>
                        </div>
                    </>
                )}

                {/* Управление кистью. */}
                {activeTab === 'tools' && (
                    <>
                        <div className="input-group">
                            {TOOL_GROUPS.map((group) => (
                                <div key={group.id} className="sidebar__tool-group">
                                    <span className="sidebar__tool-group-label">{group.label}</span>
                                    <div className="sidebar__tool-bar">
                                        {group.tools.map((tool) => (
                                            <button
                                                key={tool.id}
                                                className={`btn sidebar__tool-btn ${brushMode === tool.id ? 'sidebar__tool-btn--active' : ''}`}
                                                onClick={() => setBrushMode(tool.id)}
                                                aria-pressed={brushMode === tool.id}
                                                style={{
                                                    background: brushMode === tool.id ? tool.color : 'var(--bg-hover)',
                                                    color: brushMode === tool.id ? 'white' : 'var(--text-muted)'
                                                }}
                                                title={tool.title}
                                            >
                                                {TOOL_ICONS[tool.id]}
                                                <span className="sidebar__tool-label">{tool.label}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {brushMode === 'none' && (
                            <ToolPanel toolId="none" label="Трансформация слоя">
                                <div className="sidebar__actions">
                                    <button
                                        className="btn btn-secondary sidebar__action-btn"
                                        onClick={() => editorRef?.current?.flipActiveObject('x')}
                                        title="Отразить активный слой по горизонтали"
                                    >
                                        Отразить ↔
                                    </button>
                                    <button
                                        className="btn btn-secondary sidebar__action-btn"
                                        onClick={() => editorRef?.current?.flipActiveObject('y')}
                                        title="Отразить активный слой по вертикали"
                                    >
                                        Отразить ↕
                                    </button>
                                </div>
                                <small className="sidebar__hint">
                                    Слой можно двигать, масштабировать и вращать за круглый маркер.
                                </small>
                            </ToolPanel>
                        )}

                        {brushMode !== 'none' && (
                            <>
                                {BRUSH_SIZE_TOOL_MODES.includes(brushMode) && (
                                    <ToolPanel toolId={brushMode}>
                                        <SliderControl
                                            name="Размер кисти"
                                            value={brushSize}
                                            suffix=" px"
                                            min={1}
                                            max={100}
                                            onChange={setBrushSize}
                                            trailing={brushMode === 'sketch' ? (
                                                <input
                                                    type="color"
                                                    className="sidebar__color-picker"
                                                    value={brushColor}
                                                    onChange={(e) => setBrushColor(e.target.value)}
                                                    aria-label="Цвет кисти"
                                                    title="Цвет кисти"
                                                />
                                            ) : null}
                                        />
                                        {brushMode === 'clone_stamp' && (
                                            <small className="sidebar__hint">
                                                Зажми Alt и кликни по источнику, затем рисуй в зоне назначения.
                                            </small>
                                        )}
                                        {brushMode === 'spot_heal' && (
                                            <small className="sidebar__hint">
                                                Кликни по мелкому дефекту — он будет закрашен локальной ретушью.
                                            </small>
                                        )}
                                    </ToolPanel>
                                )}
                                {SELECTION_TOOL_MODES.includes(brushMode) && (
                                    <ToolPanel toolId={brushMode}>
                                        {brushMode === TOOL_MODES.MAGIC_WAND && (
                                            <SliderControl
                                                name="Допуск"
                                                value={wandTolerance}
                                                min={0}
                                                max={128}
                                                onChange={(value) => {
                                                    setWandTolerance(value);
                                                    editorRef?.current?.setMagicWandTolerance(value);
                                                }}
                                            />
                                        )}
                                        <SliderControl
                                            name="Растушёвка"
                                            value={featherRadius}
                                            suffix=" px"
                                            min={0}
                                            max={64}
                                            onChange={setFeatherRadius}
                                            trailing={(
                                                <button
                                                    className="btn btn-secondary sidebar__action-btn sidebar__inline-btn"
                                                    onClick={() => {
                                                        if (featherRadius <= 0) return;
                                                        const applied = editorRef?.current?.featherSelection(featherRadius);
                                                        if (!applied) {
                                                            showToastInfo?.('Сначала создай выделение.');
                                                        }
                                                    }}
                                                    title="Растушевать активное выделение"
                                                >
                                                    Применить
                                                </button>
                                            )}
                                        />
                                        <div className="sidebar__actions">
                                            <button
                                                className="btn btn-secondary sidebar__action-btn"
                                                onClick={() => editorRef?.current?.invertSelection()}
                                            >
                                                Инвертировать
                                            </button>
                                            <button
                                                className="btn btn-secondary sidebar__action-btn"
                                                onClick={() => editorRef?.current?.deselectSelection()}
                                                title="Снять выделение (Ctrl+D)"
                                            >
                                                Снять
                                            </button>
                                        </div>
                                        <div className="sidebar__actions">
                                            <button
                                                className="btn btn-secondary sidebar__action-btn"
                                                onClick={() => {
                                                    const converted = editorRef?.current?.convertSelectionToInpaintMask();
                                                    if (converted) {
                                                        showToastSuccess?.('Выделение добавлено в маску инпейнта.');
                                                    } else {
                                                        showToastInfo?.('Сначала создай выделение.');
                                                    }
                                                }}
                                            >
                                                В маску инпейнта
                                            </button>
                                        </div>
                                        <small className="sidebar__hint">
                                            {brushMode === TOOL_MODES.MAGIC_WAND
                                                ? 'Клик — выделить похожие пиксели. Shift — добавить, Alt — вычесть.'
                                                : 'Обведи область. Shift — добавить к выделению, Alt — вычесть.'}
                                        </small>
                                    </ToolPanel>
                                )}
                                {brushMode === TOOL_MODES.TEXT && (
                                    <ToolPanel toolId={TOOL_MODES.TEXT}>
                                        <SliderControl
                                            name="Размер шрифта"
                                            value={textFontSize}
                                            suffix=" px"
                                            min={8}
                                            max={200}
                                            onChange={(value) => {
                                                setTextFontSize(value);
                                                editorRef?.current?.setTextOptions({ fontSize: value });
                                            }}
                                            trailing={(
                                                <input
                                                    type="color"
                                                    className="sidebar__color-picker"
                                                    value={brushColor}
                                                    onChange={(e) => setBrushColor(e.target.value)}
                                                    aria-label="Цвет текста"
                                                    title="Цвет текста"
                                                />
                                            )}
                                        />
                                        <small className="sidebar__hint">
                                            Клик по холсту — добавить текст. Клик вне текста завершает ввод.
                                        </small>
                                    </ToolPanel>
                                )}
                                {brushMode === TOOL_MODES.SHAPE && (
                                    <ToolPanel toolId={TOOL_MODES.SHAPE}>
                                        <div className="sidebar__segmented" role="radiogroup" aria-label="Тип фигуры">
                                            {[
                                                { id: 'rect', label: 'Прямоугольник' },
                                                { id: 'ellipse', label: 'Эллипс' },
                                                { id: 'line', label: 'Линия' }
                                            ].map((kind) => (
                                                <button
                                                    key={kind.id}
                                                    type="button"
                                                    className={`sidebar__segmented-btn ${shapeKind === kind.id ? 'sidebar__segmented-btn--active' : ''}`}
                                                    aria-pressed={shapeKind === kind.id}
                                                    onClick={() => {
                                                        setShapeKind(kind.id);
                                                        editorRef?.current?.setShapeOptions({ kind: kind.id });
                                                    }}
                                                >
                                                    {kind.label}
                                                </button>
                                            ))}
                                        </div>
                                        <div className="sidebar__control-row">
                                            <label className="sidebar__checkbox" style={{ flex: 1 }}>
                                                <input
                                                    type="checkbox"
                                                    checked={shapeOutlineOnly}
                                                    onChange={(e) => {
                                                        setShapeOutlineOnly(e.target.checked);
                                                        editorRef?.current?.setShapeOptions({ outlineOnly: e.target.checked });
                                                    }}
                                                />
                                                Только контур
                                            </label>
                                            <input
                                                type="color"
                                                className="sidebar__color-picker"
                                                value={brushColor}
                                                onChange={(e) => setBrushColor(e.target.value)}
                                                aria-label="Цвет фигуры"
                                                    title="Цвет фигуры"
                                            />
                                        </div>
                                        {(shapeOutlineOnly || shapeKind === 'line') && (
                                            <SliderControl
                                                name="Толщина линии"
                                                value={shapeStrokeWidth}
                                                suffix=" px"
                                                min={1}
                                                max={50}
                                                onChange={(value) => {
                                                    setShapeStrokeWidth(value);
                                                    editorRef?.current?.setShapeOptions({ strokeWidth: value });
                                                }}
                                            />
                                        )}
                                        <small className="sidebar__hint">
                                            Протяни по холсту, чтобы нарисовать фигуру. Редактируется в режиме курсора.
                                        </small>
                                    </ToolPanel>
                                )}
                                {brushMode === TOOL_MODES.FILL && (
                                    <ToolPanel toolId={TOOL_MODES.FILL}>
                                        <SliderControl
                                            name="Допуск"
                                            value={fillTolerance}
                                            min={0}
                                            max={128}
                                            onChange={(value) => {
                                                setFillTolerance(value);
                                                editorRef?.current?.setFillTolerance(value);
                                            }}
                                            trailing={(
                                                <input
                                                    type="color"
                                                    className="sidebar__color-picker"
                                                    value={brushColor}
                                                    onChange={(e) => setBrushColor(e.target.value)}
                                                    aria-label="Цвет заливки"
                                                    title="Цвет заливки"
                                                />
                                            )}
                                        />
                                        <small className="sidebar__hint">
                                            Клик внутри выделения зальёт его; без выделения работает как «ведро» по похожим пикселям.
                                        </small>
                                    </ToolPanel>
                                )}
                                {brushMode === TOOL_MODES.GRADIENT && (
                                    <ToolPanel toolId={TOOL_MODES.GRADIENT}>
                                        <div className="sidebar__control-row">
                                            <label className="sidebar__checkbox" style={{ flex: 1 }}>
                                                <input
                                                    type="checkbox"
                                                    checked={gradientToTransparent}
                                                    onChange={(e) => {
                                                        setGradientToTransparent(e.target.checked);
                                                        editorRef?.current?.setGradientOptions({ toTransparent: e.target.checked });
                                                    }}
                                                />
                                                В прозрачность
                                            </label>
                                            <div className="sidebar__swatch-field">
                                                <input
                                                    type="color"
                                                    className="sidebar__color-picker"
                                                    value={brushColor}
                                                    onChange={(e) => setBrushColor(e.target.value)}
                                                    aria-label="Начальный цвет"
                                                    title="Начальный цвет"
                                                />
                                                <span className="sidebar__swatch-label">от</span>
                                            </div>
                                            {!gradientToTransparent && (
                                                <div className="sidebar__swatch-field">
                                                    <input
                                                        type="color"
                                                        className="sidebar__color-picker"
                                                        value={gradientEndColor}
                                                        onChange={(e) => {
                                                            setGradientEndColor(e.target.value);
                                                            editorRef?.current?.setGradientOptions({ endColor: e.target.value });
                                                        }}
                                                        aria-label="Конечный цвет"
                                                    title="Конечный цвет"
                                                    />
                                                    <span className="sidebar__swatch-label">до</span>
                                                </div>
                                            )}
                                        </div>
                                        <small className="sidebar__hint">
                                            Протяни линию направления градиента по активному слою.
                                        </small>
                                    </ToolPanel>
                                )}
                                {brushMode === TOOL_MODES.EYEDROPPER && (
                                    <ToolPanel toolId={TOOL_MODES.EYEDROPPER}>
                                        <small className="sidebar__hint">
                                            Клик по холсту — взять цвет в кисть.
                                        </small>
                                    </ToolPanel>
                                )}
                                {brushMode === TOOL_MODES.CROP && (
                                    <ToolPanel toolId={TOOL_MODES.CROP}>
                                        <small className="sidebar__hint">
                                            Протяни рамку по холсту. Enter — применить, Esc — отмена. Контент за рамкой сохраняется.
                                        </small>
                                        <div className="sidebar__actions">
                                            <button
                                                className="btn btn-secondary sidebar__action-btn"
                                                onClick={() => editorRef?.current?.applyCrop()}
                                            >
                                                Применить
                                            </button>
                                            <button
                                                className="btn btn-secondary sidebar__action-btn"
                                                onClick={() => editorRef?.current?.cancelCrop()}
                                            >
                                                Отмена
                                            </button>
                                        </div>
                                        <div className="sidebar__actions">
                                            <button
                                                className="btn btn-secondary sidebar__action-btn"
                                                onClick={() => editorRef?.current?.cropToSelection()}
                                            >
                                                Кадр по выделению
                                            </button>
                                        </div>

                                        <div className="input-group">
                                            <label className="input-label">Размер изображения</label>
                                            <div className="sidebar__size-row">
                                                <input
                                                    type="number"
                                                    className="input-field"
                                                    min="1"
                                                    max="8192"
                                                    value={imageSizeDraft.width}
                                                    onChange={(e) => setImageSizeDraft((prev) => ({ ...prev, width: e.target.value }))}
                                                    placeholder="W"
                                                    aria-label="Ширина изображения"
                                                />
                                                <span className="sidebar__size-x">×</span>
                                                <input
                                                    type="number"
                                                    className="input-field"
                                                    min="1"
                                                    max="8192"
                                                    value={imageSizeDraft.height}
                                                    onChange={(e) => setImageSizeDraft((prev) => ({ ...prev, height: e.target.value }))}
                                                    placeholder="H"
                                                    aria-label="Высота изображения"
                                                />
                                                <button
                                                    className="btn btn-secondary sidebar__action-btn"
                                                    onClick={() => {
                                                        const width = parseInt(imageSizeDraft.width, 10);
                                                        const height = parseInt(imageSizeDraft.height, 10);
                                                        if (!(width >= 1) || !(height >= 1) || width > 8192 || height > 8192) {
                                                            showToastInfo?.('Укажи размер от 1 до 8192.');
                                                            return;
                                                        }
                                                        if (editorRef?.current?.resizeImage(width, height)) {
                                                            showToastSuccess?.('Размер изображения изменён.');
                                                        }
                                                    }}
                                                >
                                                    ОК
                                                </button>
                                            </div>
                                            <small className="sidebar__hint">Масштабирует все слои вместе с рамкой.</small>
                                        </div>

                                        <div className="input-group">
                                            <label className="input-label">Размер холста</label>
                                            <div className="sidebar__size-row">
                                                <input
                                                    type="number"
                                                    className="input-field"
                                                    min="1"
                                                    max="8192"
                                                    value={canvasSizeDraft.width}
                                                    onChange={(e) => setCanvasSizeDraft((prev) => ({ ...prev, width: e.target.value }))}
                                                    placeholder="W"
                                                    aria-label="Ширина холста"
                                                />
                                                <span className="sidebar__size-x">×</span>
                                                <input
                                                    type="number"
                                                    className="input-field"
                                                    min="1"
                                                    max="8192"
                                                    value={canvasSizeDraft.height}
                                                    onChange={(e) => setCanvasSizeDraft((prev) => ({ ...prev, height: e.target.value }))}
                                                    placeholder="H"
                                                    aria-label="Высота холста"
                                                />
                                                <button
                                                    className="btn btn-secondary sidebar__action-btn"
                                                    onClick={() => {
                                                        const width = parseInt(canvasSizeDraft.width, 10);
                                                        const height = parseInt(canvasSizeDraft.height, 10);
                                                        if (!(width >= 1) || !(height >= 1) || width > 8192 || height > 8192) {
                                                            showToastInfo?.('Укажи размер от 1 до 8192.');
                                                            return;
                                                        }
                                                        if (editorRef?.current?.resizeCanvas(width, height, canvasAnchor.x, canvasAnchor.y)) {
                                                            showToastSuccess?.('Размер холста изменён.');
                                                        }
                                                    }}
                                                >
                                                    ОК
                                                </button>
                                            </div>
                                            <div className="sidebar__anchor-grid" role="radiogroup" aria-label="Якорь холста">
                                                {[0, 0.5, 1].map((anchorY) => (
                                                    [0, 0.5, 1].map((anchorX) => (
                                                        <button
                                                            key={`${anchorX}-${anchorY}`}
                                                            type="button"
                                                            className={`sidebar__anchor-cell ${canvasAnchor.x === anchorX && canvasAnchor.y === anchorY ? 'sidebar__anchor-cell--active' : ''}`}
                                                            aria-label={`Якорь: ${['левый', 'центр', 'правый'][anchorX * 2]} / ${['верх', 'середина', 'низ'][anchorY * 2]}`}
                                                            onClick={() => setCanvasAnchor({ x: anchorX, y: anchorY })}
                                                            aria-pressed={canvasAnchor.x === anchorX && canvasAnchor.y === anchorY}
                                                        />
                                                    ))
                                                ))}
                                            </div>
                                            <small className="sidebar__hint">Слои остаются на месте, рамка растёт/сжимается от якоря.</small>
                                        </div>
                                    </ToolPanel>
                                )}
                                {brushMode === 'quick_select' && (
                                    <ToolPanel toolId="quick_select">
                                        <div className="sidebar__actions">
                                            <button className="btn btn-secondary sidebar__action-btn" onClick={onQuickSelectionCopy}>
                                                Копировать
                                            </button>
                                            <button className="btn btn-secondary sidebar__action-btn" onClick={onQuickSelectionPaste}>
                                                Вставить
                                            </button>
                                        </div>
                                        <div className="sidebar__actions">
                                            <button className="btn btn-secondary sidebar__action-btn" onClick={onQuickSelectionRefine}>
                                                Перегенерировать выделение
                                            </button>
                                        </div>
                                        <small className="sidebar__hint">
                                            Зажми ЛКМ и обведи контур объекта, затем скопируй и вставь рядом.
                                        </small>
                                    </ToolPanel>
                                )}
                            </>
                        )}

                        <div className="input-group">
                            <h4 className="sidebar__layers-title">Коррекция</h4>
                            <div className="sidebar__adjustments">
                                {ADJUSTMENT_BUTTONS.map((type) => (
                                    <button
                                        key={type}
                                        type="button"
                                        className="btn btn-secondary sidebar__action-btn"
                                        onClick={() => {
                                            const result = editorRef?.current?.openAdjustment(type);
                                            if (!result?.ok) {
                                                showToastInfo?.(ADJUSTMENT_FAIL_MESSAGES[result?.reason] || ADJUSTMENT_FAIL_MESSAGES['no-target']);
                                            }
                                        }}
                                    >
                                        {ADJUSTMENT_LABELS[type]}
                                    </button>
                                ))}
                            </div>
                            <small className="sidebar__hint">
                                Применяется к активному слою; активное выделение ограничивает область.
                            </small>
                        </div>

                        <div className="input-group sidebar__layers-panel">
                            <h4 className="sidebar__layers-title">Слои</h4>
                            <div className="sidebar__layers-toolbar">
                                <button
                                    type="button"
                                    className="btn sidebar__layers-add-btn"
                                    onClick={handleAddLayerClick}
                                >
                                    <span className="sidebar__layers-add-icon" aria-hidden="true">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M12 5v14" />
                                            <path d="M5 12h14" />
                                        </svg>
                                    </span>
                                    <span>Добавить слой</span>
                                </button>
                                <button
                                    type="button"
                                    className="btn sidebar__layers-view-btn"
                                    onClick={() => setLayerViewMode((prev) => (prev === 'list' ? 'compact' : 'list'))}
                                    title={layerViewMode === 'list' ? 'Компактный вид слоёв' : 'Обычный вид слоёв'}
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <rect x="3" y="3" width="7" height="7" rx="1.5" />
                                        <rect x="14" y="3" width="7" height="7" rx="1.5" />
                                        <rect x="3" y="14" width="7" height="7" rx="1.5" />
                                        <rect x="14" y="14" width="7" height="7" rx="1.5" />
                                    </svg>
                                </button>
                            </div>
                            {!Array.isArray(layers) || layers.length === 0 ? (
                                <small className="sidebar__hint">Слои появятся после добавления/рисования на холсте.</small>
                            ) : (
                                <div className={`sidebar__layers-list ${layerViewMode === 'compact' ? 'sidebar__layers-list--compact' : ''}`}>
                                    {layers.map((layer) => (
                                        <div
                                            key={layer.id}
                                            className={`sidebar__layer-row ${layer.isActive ? 'sidebar__layer-row--active' : ''}`}
                                        >
                                            <span className="sidebar__layer-grip" aria-hidden="true">
                                                <span />
                                                <span />
                                                <span />
                                            </span>
                                            <span
                                                className="sidebar__layer-thumb"
                                                style={{ background: LAYER_KIND_BG[layer.kindLabel] || LAYER_KIND_BG.Raster }}
                                                aria-hidden="true"
                                            />
                                            <button
                                                type="button"
                                                className="btn sidebar__layer-select-btn"
                                                onClick={() => onLayerSelect?.(layer.id)}
                                                title={`Выбрать слой: ${layer.name}`}
                                            >
                                                <span className="sidebar__layer-content">
                                                    <span className="sidebar__layer-name">{layer.name}</span>
                                                    <span className="sidebar__layer-meta">
                                                        {(layer.blendMode
                                                            ? (LAYER_BLEND_MODES.find((mode) => mode.id === layer.blendMode)?.label || 'Обычный')
                                                            : 'Обычный')}
                                                        {' · '}
                                                        {layer.opacity ?? 100}%
                                                    </span>
                                                </span>
                                            </button>
                                            <button
                                                type="button"
                                                className="btn sidebar__layer-visibility-btn"
                                                onClick={() => onLayerToggleVisibility?.(layer.id)}
                                                title={layer.visible ? 'Скрыть слой' : 'Показать слой'}
                                            >
                                                {layer.visible ? (
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                                                        <circle cx="12" cy="12" r="3" />
                                                    </svg>
                                                ) : (
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                        <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-6.5 0-10-7-10-7a21.77 21.77 0 0 1 5.06-5.94" />
                                                        <path d="M10.58 10.58a2 2 0 1 0 2.83 2.83" />
                                                        <path d="M22 12s-1.42 2.84-4.06 4.94" />
                                                        <path d="M2 2l20 20" />
                                                    </svg>
                                                )}
                                            </button>
                                            <button
                                                type="button"
                                                className="btn sidebar__layer-lock-btn"
                                                onClick={() => onLayerToggleLock?.(layer.id)}
                                                title={layer.locked ? 'Разблокировать слой' : 'Заблокировать слой'}
                                            >
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <rect x="5" y="11" width="14" height="10" rx="2" />
                                                    {layer.locked ? (
                                                        <path d="M8 11V8a4 4 0 1 1 8 0v3" />
                                                    ) : (
                                                        <path d="M9 11V8a4 4 0 1 1 8 0" />
                                                    )}
                                                </svg>
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {selectedLayer && selectedLayerSettings && (
                                <div className="sidebar__layer-controls">
                                    <div className="sidebar__layer-control-row">
                                        <label className="input-label">Непроз.</label>
                                        <input
                                            aria-label="Непрозрачность слоя"
                                            type="range"
                                            className="sidebar__range sidebar__range--primary"
                                            min="0"
                                            max="100"
                                            value={selectedLayerSettings.opacity}
                                            onChange={(event) => updateSelectedLayerSettings({ opacity: Number(event.target.value) })}
                                        />
                                        <span className="sidebar__layer-control-value">{selectedLayerSettings.opacity}</span>
                                    </div>
                                    <div className="sidebar__layer-control-row">
                                        <label className="input-label">Заливка</label>
                                        <input
                                            aria-label="Заливка слоя"
                                            type="range"
                                            className="sidebar__range sidebar__range--primary"
                                            min="0"
                                            max="100"
                                            value={selectedLayerSettings.fill}
                                            onChange={(event) => updateSelectedLayerSettings({ fill: Number(event.target.value) })}
                                        />
                                        <span className="sidebar__layer-control-value">{selectedLayerSettings.fill}</span>
                                    </div>
                                    <div className="sidebar__layer-mode-row">
                                        <label className="input-label">Режим</label>
                                        <select
                                            aria-label="Режим наложения слоя"
                                            className="input-field"
                                            value={selectedLayerSettings.blendMode}
                                            onChange={(event) => updateSelectedLayerSettings({ blendMode: event.target.value })}
                                        >
                                            {LAYER_BLEND_MODES.map((mode) => (
                                                <option key={mode.id} value={mode.id}>{mode.label}</option>
                                            ))}
                                        </select>
                                    </div>
                                </div>
                            )}
                        </div>

                        <details className="sidebar__hotkeys">
                            <summary>Горячие клавиши</summary>
                            <div className="sidebar__hotkeys-grid">
                                {[
                                    ['V', 'Курсор'],
                                    ['H', 'Рука (панорама)'],
                                    ['M', 'Выделение: прямоугольник / эллипс'],
                                    ['L', 'Лассо'],
                                    ['A', 'Волшебная палочка'],
                                    ['W', 'Быстрое выделение'],
                                    ['B', 'Кисть-скетч'],
                                    ['T', 'Текст'],
                                    ['U', 'Фигура'],
                                    ['G', 'Заливка / градиент'],
                                    ['I', 'Пипетка'],
                                    ['E', 'Ластик'],
                                    ['J', 'Точечная кисть'],
                                    ['S', 'Штамп'],
                                    ['C', 'Кадрирование'],
                                    ['Ctrl+Z', 'Отменить действие'],
                                    ['Ctrl+D', 'Снять выделение'],
                                    ['Shift / Alt', 'Добавить / вычесть выделение'],
                                    ['Space', 'Панорама холста'],
                                    ['Del', 'Удалить активный объект'],
                                    ['Enter / Esc', 'Кадр: применить / отмена']
                                ].map(([keys, description]) => (
                                    <div key={keys} className="sidebar__hotkeys-row">
                                        <kbd className="sidebar__kbd">{keys}</kbd>
                                        <span>{description}</span>
                                    </div>
                                ))}
                            </div>
                        </details>

                        {brushMode === 'mask' && (
                            <div className="input-group sidebar__mask-panel">
                                <h4 className="sidebar__mask-title">Маска инпейнта</h4>

                                <div className="input-group sidebar__mask-group">
                                    <label className="input-label" htmlFor="param-mask-blur">Размытие маски ({params.mask_blur})</label>
                                    <input id="param-mask-blur" type="range" className="input-range sidebar__range" name="mask_blur" min="0" max="128" step="1" value={params.mask_blur} onChange={handleChange} />
                                </div>

                                <div className="input-group sidebar__mask-group">
                                    <label className="input-label" htmlFor="param-mask-padding">Расширение маски ({params.mask_padding})</label>
                                    <input id="param-mask-padding" type="range" className="input-range sidebar__range" name="mask_padding" min="0" max="128" step="1" value={params.mask_padding} onChange={handleChange} />
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

                        <div className="sidebar__actions">
                            <button
                                className="btn btn-secondary sidebar__action-btn"
                                onClick={() => { setImportPanelOpen((prev) => !prev); setExportPanelOpen(false); }}
                            >
                                ↑ Импорт
                            </button>
                            <button
                                className="btn btn-secondary sidebar__action-btn"
                                onClick={() => { setExportPanelOpen((prev) => !prev); setImportPanelOpen(false); }}
                            >
                                ↓ Экспорт
                            </button>
                        </div>

                        {importPanelOpen && (
                            <div className="input-group">
                                <button
                                    className="btn btn-secondary sidebar__action-btn"
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    С диска
                                </button>
                                <label className="input-label" style={{ marginTop: '8px' }} htmlFor="import-url">По URL</label>
                                <div style={{ display: 'flex', gap: '6px' }}>
                                    <input
                                        id="import-url"
                                        type="url"
                                        className="input-field"
                                        placeholder="https://..."
                                        value={importUrl}
                                        onChange={(e) => setImportUrl(e.target.value)}
                                        onKeyDown={(e) => e.key === 'Enter' && handleUrlImport()}
                                        disabled={isImportingUrl}
                                    />
                                    <button
                                        className="btn btn-secondary sidebar__action-btn"
                                        onClick={handleUrlImport}
                                        disabled={isImportingUrl || !importUrl.trim()}
                                        style={{ flexShrink: 0 }}
                                    >
                                        {isImportingUrl ? '...' : 'OK'}
                                    </button>
                                </div>
                            </div>
                        )}

                        {exportPanelOpen && (
                            <div className="input-group">
                                <div className="sidebar__grid-2col">
                                    <div>
                                        <label className="input-label" htmlFor="export-mode">Область</label>
                                        <select
                                            id="export-mode"
                                            className="input-field"
                                            value={exportMode}
                                            onChange={(e) => setExportMode(e.target.value)}
                                        >
                                            <option value="content">Весь контент</option>
                                            <option value="viewport">Вьюпорт</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="input-label" htmlFor="export-format">Формат</label>
                                        <select
                                            id="export-format"
                                            className="input-field"
                                            value={exportFormat}
                                            onChange={(e) => setExportFormat(e.target.value)}
                                        >
                                            <option value="png">PNG</option>
                                            <option value="jpeg">JPEG</option>
                                        </select>
                                    </div>
                                </div>
                                {exportFormat === 'jpeg' && (
                                    <div className="input-group">
                                        <label className="input-label" htmlFor="export-quality">Качество ({exportQuality}%)</label>
                                        <input
                                            id="export-quality"
                                            type="range"
                                            className="sidebar__range sidebar__range--neutral"
                                            min="10"
                                            max="100"
                                            step="5"
                                            value={exportQuality}
                                            onChange={(e) => setExportQuality(Number(e.target.value))}
                                        />
                                    </div>
                                )}
                                <button
                                    className="btn btn-secondary sidebar__action-btn"
                                    onClick={handleExportDownload}
                                >
                                    Скачать
                                </button>
                            </div>
                        )}
                    </>
                )}
            </div>

            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleFileChange}
            />

            {/* Нижняя панель с фиксированной кнопкой. */}
            <div className="sidebar__footer">
                {isGenerating ? (
                    <button
                        className="btn sidebar__cancel-btn"
                        onClick={onCancel}
                        disabled={generationStatus === 'cancelling'}
                    >
                        {generationStatus === 'cancelling' ? (
                            <>
                                <span className="sidebar__btn-spinner" aria-hidden="true" />
                                ОТМЕНА…
                            </>
                        ) : (
                            <>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                    <rect x="5" y="5" width="14" height="14" rx="2" />
                                </svg>
                                ОТМЕНИТЬ
                            </>
                        )}
                    </button>
                ) : (
                    <button
                        className="btn sidebar__generate-btn"
                        onClick={onGenerate}
                        disabled={isBusy}
                    >
                        {generationStatus === 'restoring' ? (
                            <>
                                <span className="sidebar__btn-spinner" aria-hidden="true" />
                                ВОССТАНОВЛЕНИЕ…
                            </>
                        ) : (
                            <>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
                                    <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
                                </svg>
                                СГЕНЕРИРОВАТЬ
                            </>
                        )}
                    </button>
                )}
            </div>

            <ModelManager
                open={isModelManagerOpen}
                onClose={() => setIsModelManagerOpen(false)}
                availableModels={availableModels}
                activeModelId={params.model_id}
                onSelectModel={(id) => setParams(prev => ({ ...prev, model_id: id }))}
                onModelsRefresh={onModelsRefresh}
                showToastError={showToastError}
                showToastSuccess={showToastSuccess}
                showToastInfo={showToastInfo}
            />
        </div>
    );
};

export default Sidebar;
