import { GENERATION_MODE_OPTIONS, INTENT_PRESETS } from './generationModes';

// Верх панели генерации: явный выбор режима (вся картинка / inpaint) и
// пресеты-намерения. Пресет выставляет числовые параметры через setParams,
// сам режим живёт в App (нужен при сборке запроса генерации).
const GenerationModePanel = ({ mode, onModeChange, params, setParams }) => {
    const activeOption = GENERATION_MODE_OPTIONS.find((option) => option.id === mode)
        || GENERATION_MODE_OPTIONS[0];
    const presets = INTENT_PRESETS[mode] || [];

    const applyPreset = (preset) => {
        setParams((prev) => ({ ...prev, ...preset.params }));
    };

    // Пресет считается активным, если все его параметры совпадают с текущими —
    // подсветка помогает понять, «где я сейчас».
    const isPresetActive = (preset) => Object.entries(preset.params)
        .every(([key, value]) => Number(params?.[key]) === Number(value));

    return (
        <div className="input-group gen-mode-panel">
            <label className="input-label">Режим генерации</label>
            <div className="gen-mode-panel__segmented" role="group" aria-label="Режим генерации">
                {GENERATION_MODE_OPTIONS.map((option) => {
                    const active = option.id === mode;
                    return (
                        <button
                            key={option.id}
                            type="button"
                            className="btn gen-mode-panel__seg-btn"
                            aria-pressed={active}
                            title={option.hint}
                            onClick={() => onModeChange(option.id)}
                            style={{
                                background: active ? 'var(--primary)' : 'var(--bg-hover)',
                                color: active ? '#fff' : 'var(--text-muted)'
                            }}
                        >
                            {option.label}
                        </button>
                    );
                })}
            </div>

            <small className="sidebar__hint gen-mode-panel__hint">{activeOption.hint}</small>

            {presets.length > 0 && (
                <div className="gen-mode-panel__presets" role="group" aria-label="Пресеты">
                    {presets.map((preset) => {
                        const active = isPresetActive(preset);
                        return (
                            <button
                                key={preset.id}
                                type="button"
                                className="btn gen-mode-panel__preset-btn"
                                aria-pressed={active}
                                onClick={() => applyPreset(preset)}
                                style={{
                                    borderColor: active ? 'var(--primary)' : 'var(--border)',
                                    color: active ? 'var(--primary)' : 'var(--text-muted)'
                                }}
                            >
                                {preset.label}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default GenerationModePanel;
