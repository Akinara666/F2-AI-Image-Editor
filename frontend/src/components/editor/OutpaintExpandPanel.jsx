import { useEffect, useState } from 'react';
import { EXPAND_DIRECTIONS, ASPECT_PRESETS, computeExpand, computeAspect } from './outpaintExpand';

// Панель outpaint: растит холст в нужную сторону / под соотношение, оставляя
// прозрачные поля — их бэкенд дорисовывает. Поверх готового resizeCanvas.
const OutpaintExpandPanel = ({ editorRef, showToastSuccess, showToastError }) => {
    const [size, setSize] = useState(null);

    const refresh = () => setSize(editorRef?.current?.getFrameSize?.() ?? null);
    useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const apply = (next, message) => {
        if (!next) {
            return;
        }
        const ok = editorRef?.current?.resizeCanvas?.(next.width, next.height, next.anchorX, next.anchorY);
        if (ok) {
            refresh();
            showToastSuccess?.(message);
        } else {
            showToastError?.('Не удалось изменить размер холста.');
        }
    };

    const onExpand = (direction) => {
        const current = editorRef?.current?.getFrameSize?.();
        apply(
            computeExpand(current, direction),
            `Холст расширен: ${EXPAND_DIRECTIONS[direction].label.toLowerCase()}.`
        );
    };

    const onAspect = (preset) => {
        const current = editorRef?.current?.getFrameSize?.();
        apply(computeAspect(current, preset.w, preset.h), `Холст под ${preset.label}.`);
    };

    const dirButton = (direction, glyph) => (
        <button
            type="button"
            className="btn outpaint-panel__dir-btn"
            title={`Расширить: ${EXPAND_DIRECTIONS[direction].label.toLowerCase()}`}
            aria-label={`Расширить ${EXPAND_DIRECTIONS[direction].label.toLowerCase()}`}
            onClick={() => onExpand(direction)}
        >
            {glyph}
        </button>
    );

    return (
        <div className="input-group outpaint-panel">
            <label className="input-label">Расширить холст (outpaint)</label>
            <small className="sidebar__hint outpaint-panel__size">
                {size ? `Текущий размер: ${size.width} × ${size.height}` : 'Размер холста недоступен'}
            </small>

            <div className="outpaint-panel__cross" role="group" aria-label="Направление расширения">
                <span />
                {dirButton('up', '↑')}
                <span />
                {dirButton('left', '←')}
                {dirButton('all', '⤢')}
                {dirButton('right', '→')}
                <span />
                {dirButton('down', '↓')}
                <span />
            </div>

            <div className="outpaint-panel__aspects" role="group" aria-label="Соотношение сторон">
                {ASPECT_PRESETS.map((preset) => (
                    <button
                        key={preset.id}
                        type="button"
                        className="btn outpaint-panel__aspect-btn"
                        onClick={() => onAspect(preset)}
                    >
                        {preset.label}
                    </button>
                ))}
            </div>

            <small className="sidebar__hint">
                Прозрачные поля дорисует генерация. Нажми «Сгенерировать» в режиме Outpaint.
            </small>
        </div>
    );
};

export default OutpaintExpandPanel;
