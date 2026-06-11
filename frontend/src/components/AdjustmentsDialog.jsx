import { useEffect, useMemo, useRef, useState } from 'react';
import { ADJUSTMENT_TYPES, buildCurveLut } from '../utils/imageFilters';
import './AdjustmentsDialog.css';

export const ADJUSTMENT_LABELS = {
    [ADJUSTMENT_TYPES.BRIGHTNESS_CONTRAST]: 'Яркость/Контраст',
    [ADJUSTMENT_TYPES.LEVELS]: 'Уровни',
    [ADJUSTMENT_TYPES.CURVES]: 'Кривые',
    [ADJUSTMENT_TYPES.HUE_SATURATION]: 'Тон/Насыщенность',
    [ADJUSTMENT_TYPES.INVERT]: 'Инверсия',
    [ADJUSTMENT_TYPES.GAUSSIAN_BLUR]: 'Размытие по Гауссу',
    [ADJUSTMENT_TYPES.SHARPEN]: 'Резкость (Unsharp Mask)',
    [ADJUSTMENT_TYPES.NOISE]: 'Шум'
};

const SLIDER_CONFIGS = {
    [ADJUSTMENT_TYPES.BRIGHTNESS_CONTRAST]: [
        { key: 'brightness', label: 'Яркость', min: -100, max: 100, step: 1, defaultValue: 0 },
        { key: 'contrast', label: 'Контраст', min: -100, max: 100, step: 1, defaultValue: 0 }
    ],
    [ADJUSTMENT_TYPES.HUE_SATURATION]: [
        { key: 'hue', label: 'Тон', min: -180, max: 180, step: 1, defaultValue: 0 },
        { key: 'saturation', label: 'Насыщенность', min: -100, max: 100, step: 1, defaultValue: 0 },
        { key: 'lightness', label: 'Яркость', min: -100, max: 100, step: 1, defaultValue: 0 }
    ],
    [ADJUSTMENT_TYPES.GAUSSIAN_BLUR]: [
        { key: 'radius', label: 'Радиус', min: 0, max: 50, step: 0.5, defaultValue: 5 }
    ],
    [ADJUSTMENT_TYPES.SHARPEN]: [
        { key: 'amount', label: 'Эффект, %', min: 0, max: 300, step: 5, defaultValue: 80 },
        { key: 'radius', label: 'Радиус', min: 0.5, max: 10, step: 0.5, defaultValue: 2 },
        { key: 'threshold', label: 'Порог', min: 0, max: 255, step: 1, defaultValue: 0 }
    ],
    [ADJUSTMENT_TYPES.NOISE]: [
        { key: 'amount', label: 'Количество', min: 0, max: 100, step: 1, defaultValue: 10 }
    ],
    [ADJUSTMENT_TYPES.LEVELS]: [
        { key: 'inBlack', label: 'Вход: тени', min: 0, max: 254, step: 1, defaultValue: 0 },
        { key: 'gamma', label: 'Гамма', min: 0.1, max: 3, step: 0.05, defaultValue: 1 },
        { key: 'inWhite', label: 'Вход: света', min: 1, max: 255, step: 1, defaultValue: 255 },
        { key: 'outBlack', label: 'Выход: тени', min: 0, max: 255, step: 1, defaultValue: 0 },
        { key: 'outWhite', label: 'Выход: света', min: 0, max: 255, step: 1, defaultValue: 255 }
    ]
};

const buildDefaultParams = (type) => {
    if (type === ADJUSTMENT_TYPES.CURVES) {
        return { points: [{ x: 0, y: 0 }, { x: 255, y: 255 }] };
    }
    const params = {};
    (SLIDER_CONFIGS[type] || []).forEach((slider) => {
        params[slider.key] = slider.defaultValue;
    });
    if (type === ADJUSTMENT_TYPES.NOISE) {
        params.monochrome = true;
    }
    return params;
};

const clampCurveValue = (value) => Math.max(0, Math.min(255, Math.round(value)));

const CurvesEditor = ({ points, onChange }) => {
    const svgRef = useRef(null);
    const dragIndexRef = useRef(-1);
    const lut = useMemo(() => buildCurveLut(points), [points]);

    const eventToCurveSpace = (event) => {
        const rect = svgRef.current.getBoundingClientRect();
        return {
            x: clampCurveValue(((event.clientX - rect.left) / rect.width) * 255),
            y: clampCurveValue(255 - ((event.clientY - rect.top) / rect.height) * 255)
        };
    };

    const movePoint = (index, position) => {
        const next = points.map((point, pointIndex) => {
            if (pointIndex !== index) {
                return point;
            }
            const minX = index === 0 ? 0 : points[index - 1].x + 1;
            const maxX = index === points.length - 1 ? 255 : points[index + 1].x - 1;
            return {
                x: Math.max(minX, Math.min(maxX, position.x)),
                y: position.y
            };
        });
        onChange(next);
    };

    const handleBackgroundPointerDown = (event) => {
        if (event.target.dataset?.curvePoint !== undefined) {
            return;
        }
        const position = eventToCurveSpace(event);
        const insertIndex = points.findIndex((point) => point.x > position.x);
        const safeIndex = insertIndex === -1 ? points.length - 1 : insertIndex;
        const next = [...points];
        next.splice(safeIndex, 0, position);
        onChange(next);
        dragIndexRef.current = safeIndex;
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handlePointPointerDown = (index) => (event) => {
        event.stopPropagation();
        dragIndexRef.current = index;
        svgRef.current.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event) => {
        if (dragIndexRef.current < 0) {
            return;
        }
        movePoint(dragIndexRef.current, eventToCurveSpace(event));
    };

    const handlePointerUp = () => {
        dragIndexRef.current = -1;
    };

    const handlePointDoubleClick = (index) => (event) => {
        event.stopPropagation();
        if (index === 0 || index === points.length - 1) {
            return;
        }
        onChange(points.filter((point, pointIndex) => pointIndex !== index));
    };

    const curvePath = useMemo(() => {
        const steps = [];
        for (let x = 0; x <= 255; x += 4) {
            steps.push(`${x},${255 - lut[x]}`);
        }
        steps.push(`255,${255 - lut[255]}`);
        return `M ${steps.join(' L ')}`;
    }, [lut]);

    return (
        <svg
            ref={svgRef}
            className="adjustments-dialog__curves"
            viewBox="0 0 256 256"
            onPointerDown={handleBackgroundPointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
        >
            {[64, 128, 192].map((position) => (
                <g key={position}>
                    <line x1={position} y1="0" x2={position} y2="256" className="adjustments-dialog__curves-grid" />
                    <line x1="0" y1={position} x2="256" y2={position} className="adjustments-dialog__curves-grid" />
                </g>
            ))}
            <line x1="0" y1="256" x2="256" y2="0" className="adjustments-dialog__curves-diagonal" />
            <path d={curvePath} className="adjustments-dialog__curves-line" />
            {points.map((point, index) => (
                <circle
                    key={`${point.x}-${index}`}
                    data-curve-point
                    cx={point.x}
                    cy={255 - point.y}
                    r="6"
                    className="adjustments-dialog__curves-point"
                    onPointerDown={handlePointPointerDown(index)}
                    onDoubleClick={handlePointDoubleClick(index)}
                />
            ))}
        </svg>
    );
};

const Histogram = ({ histogram }) => {
    const path = useMemo(() => {
        if (!histogram) {
            return '';
        }
        let peak = 1;
        histogram.forEach((count) => {
            if (count > peak) peak = count;
        });
        const steps = ['M 0,100'];
        for (let value = 0; value < 256; value += 2) {
            const sampled = Math.max(histogram[value], histogram[Math.min(255, value + 1)]);
            steps.push(`L ${(value / 255) * 256},${100 - (sampled / peak) * 100}`);
        }
        steps.push('L 256,100 Z');
        return steps.join(' ');
    }, [histogram]);

    if (!histogram) {
        return null;
    }
    return (
        <svg className="adjustments-dialog__histogram" viewBox="0 0 256 100" preserveAspectRatio="none">
            <path d={path} />
        </svg>
    );
};

const AdjustmentsDialog = ({ type, onPreview, onApply, onCancel, getHistogram, selectionMissesLayer }) => {
    const [params, setParams] = useState(() => buildDefaultParams(type));
    const histogram = useMemo(
        () => (type === ADJUSTMENT_TYPES.LEVELS ? getHistogram?.() : null),
        [type, getHistogram]
    );

    // Первичный предпросмотр (для фильтров с ненулевыми дефолтами — blur и т.п.).
    useEffect(() => {
        onPreview?.(params);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onCancel?.();
            } else if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onApply?.(params);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onApply, onCancel, params]);

    const updateParams = (patch) => {
        setParams((previous) => {
            const next = { ...previous, ...patch };
            onPreview?.(next);
            return next;
        });
    };

    const sliders = SLIDER_CONFIGS[type] || [];

    return (
        <div className="adjustments-dialog" role="dialog" aria-label={ADJUSTMENT_LABELS[type]}>
            <div className="adjustments-dialog__header">
                <span className="adjustments-dialog__title">{ADJUSTMENT_LABELS[type]}</span>
            </div>

            {selectionMissesLayer && (
                <small className="adjustments-dialog__warning">
                    Выделение не пересекает активный слой — эффект не будет виден.
                </small>
            )}

            {type === ADJUSTMENT_TYPES.LEVELS && <Histogram histogram={histogram} />}

            {type === ADJUSTMENT_TYPES.CURVES && (
                <CurvesEditor
                    points={params.points}
                    onChange={(points) => updateParams({ points })}
                />
            )}

            {sliders.map((slider) => (
                <div key={slider.key} className="adjustments-dialog__row">
                    <label className="adjustments-dialog__label">
                        {slider.label}: {params[slider.key]}
                    </label>
                    <input
                        type="range"
                        min={slider.min}
                        max={slider.max}
                        step={slider.step}
                        value={params[slider.key]}
                        onChange={(event) => updateParams({ [slider.key]: Number(event.target.value) })}
                    />
                </div>
            ))}

            {type === ADJUSTMENT_TYPES.NOISE && (
                <label className="adjustments-dialog__checkbox">
                    <input
                        type="checkbox"
                        checked={Boolean(params.monochrome)}
                        onChange={(event) => updateParams({ monochrome: event.target.checked })}
                    />
                    Монохромный
                </label>
            )}

            <div className="adjustments-dialog__actions">
                <button
                    type="button"
                    className="adjustments-dialog__btn adjustments-dialog__btn--apply"
                    onClick={() => onApply?.(params)}
                >
                    Применить
                </button>
                <button
                    type="button"
                    className="adjustments-dialog__btn adjustments-dialog__btn--cancel"
                    onClick={() => onCancel?.()}
                >
                    Отмена
                </button>
            </div>
        </div>
    );
};

export default AdjustmentsDialog;
