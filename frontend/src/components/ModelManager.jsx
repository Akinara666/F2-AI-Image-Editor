import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { API_ENDPOINTS } from '../constants';
import './ModelManager.css';

const TABS = [
    { id: 'installed', label: 'Установленные' },
    { id: 'civitai', label: 'Civit.ai' },
    { id: 'huggingface', label: 'HuggingFace' }
];

const ACTIVE_STATUSES = ['pending', 'downloading'];

const formatBytes = (bytes) => {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    const units = ['Б', 'КБ', 'МБ', 'ГБ'];
    let n = value;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i += 1;
    }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

const basename = (value) => String(value || '').split(/[\\/]/).pop();

const FamilyBadge = ({ family }) => (
    <span className={`mm-badge mm-badge--${family === 'sdxl' ? 'sdxl' : 'sd'}`}>
        {family === 'sdxl' ? 'SDXL' : 'SD 1.5'}
    </span>
);

const ModelManager = ({
    open,
    onClose,
    availableModels = [],
    activeModelId,
    onSelectModel,
    onModelsRefresh,
    showToastError,
    showToastSuccess,
    showToastInfo
}) => {
    const [tab, setTab] = useState('installed');
    const [query, setQuery] = useState('');
    const [searching, setSearching] = useState(false);
    const [results, setResults] = useState([]);
    const [hfFiles, setHfFiles] = useState({}); // repo -> { loading, files }
    const [expandedRepo, setExpandedRepo] = useState(null);
    const [downloads, setDownloads] = useState([]);

    const downloadsRef = useRef([]);
    const tickInFlight = useRef(false);
    useEffect(() => { downloadsRef.current = downloads; }, [downloads]);

    // Множество уже установленных имён файлов — чтобы не качать дубликаты.
    const installedNames = useMemo(
        () => new Set(availableModels.map((m) => basename(m.filename || m.id)).filter(Boolean)),
        [availableModels]
    );
    const activeDownloadNames = useMemo(
        () => new Set(downloads.filter((d) => ACTIVE_STATUSES.includes(d.status)).map((d) => d.filename)),
        [downloads]
    );

    // ---- опрос прогресса активных загрузок ----
    useEffect(() => {
        if (!open) return undefined;
        const tick = async () => {
            if (tickInFlight.current) return;
            const active = downloadsRef.current.filter((d) => ACTIVE_STATUSES.includes(d.status));
            if (active.length === 0) return;
            tickInFlight.current = true;
            try {
                await Promise.all(active.map(async (job) => {
                    try {
                        const { data } = await axios.get(API_ENDPOINTS.MODELS_DOWNLOAD_STATUS(job.job_id));
                        if (job.status !== data.status) {
                            if (data.status === 'completed') {
                                showToastSuccess?.(`Модель «${data.filename}» скачана.`);
                                onModelsRefresh?.({ silent: true });
                            } else if (data.status === 'error') {
                                showToastError?.(`Ошибка загрузки «${data.filename}»: ${data.error || 'неизвестно'}`);
                            } else if (data.status === 'canceled') {
                                showToastInfo?.(`Загрузка «${data.filename}» отменена.`);
                            }
                        }
                        setDownloads((prev) => prev.map((d) => (d.job_id === job.job_id ? { ...d, ...data } : d)));
                    } catch {
                        /* временная ошибка опроса — игнорируем */
                    }
                }));
            } finally {
                tickInFlight.current = false;
            }
        };
        const id = setInterval(tick, 1200);
        return () => clearInterval(id);
    }, [open, onModelsRefresh, showToastSuccess, showToastError, showToastInfo]);

    // Esc закрывает модалку.
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const runSearch = useCallback(async () => {
        const endpoint = tab === 'civitai' ? API_ENDPOINTS.MODELS_SEARCH_CIVITAI : API_ENDPOINTS.MODELS_SEARCH_HF;
        setSearching(true);
        setExpandedRepo(null);
        try {
            const { data } = await axios.get(endpoint, { params: { query } });
            setResults(Array.isArray(data?.results) ? data.results : []);
        } catch (err) {
            console.error('Model search failed:', err);
            showToastError?.('Поиск моделей не удался. Проверь подключение к сети.');
            setResults([]);
        } finally {
            setSearching(false);
        }
    }, [tab, query, showToastError]);

    // Сброс результатов при переключении вкладок поиска.
    useEffect(() => {
        setResults([]);
        setQuery('');
        setExpandedRepo(null);
    }, [tab]);

    const startDownload = useCallback(async ({ download_url, filename, model_id, auth }) => {
        const cleanName = basename(filename);
        if (!download_url || !cleanName) {
            showToastError?.('У этой модели нет прямой ссылки на файл.');
            return;
        }
        if (installedNames.has(cleanName) || activeDownloadNames.has(cleanName)) {
            showToastInfo?.('Эта модель уже установлена или скачивается.');
            return;
        }
        try {
            const { data } = await axios.post(API_ENDPOINTS.MODELS_DOWNLOAD, {
                download_url,
                filename: cleanName,
                model_id: model_id || cleanName,
                auth: auth || 'none'
            });
            setDownloads((prev) => [{ ...data }, ...prev.filter((d) => d.job_id !== data.job_id)]);
            showToastInfo?.(`Загрузка «${cleanName}» началась.`);
        } catch (err) {
            const detail = err?.response?.data?.detail || 'Не удалось начать загрузку.';
            showToastError?.(detail);
        }
    }, [installedNames, activeDownloadNames, showToastError, showToastInfo]);

    const cancelDownload = useCallback(async (jobId) => {
        try {
            await axios.post(API_ENDPOINTS.MODELS_DOWNLOAD_CANCEL(jobId));
        } catch {
            /* если задача уже завершилась — ничего страшного */
        }
    }, []);

    const deleteModel = useCallback(async (model) => {
        const name = basename(model.filename || model.id);
        if (!name) return;
        if (!window.confirm(`Удалить модель «${name}»? Файл будет стёрт с диска.`)) return;
        try {
            await axios.post(API_ENDPOINTS.MODELS_DELETE, { filename: name });
            showToastSuccess?.(`Модель «${name}» удалена.`);
            onModelsRefresh?.({ silent: true });
        } catch (err) {
            const detail = err?.response?.data?.detail || 'Не удалось удалить модель.';
            showToastError?.(detail);
        }
    }, [onModelsRefresh, showToastError, showToastSuccess]);

    const loadHfFiles = useCallback(async (repo) => {
        if (expandedRepo === repo) { setExpandedRepo(null); return; }
        setExpandedRepo(repo);
        if (hfFiles[repo]?.files) return;
        setHfFiles((prev) => ({ ...prev, [repo]: { loading: true, files: [] } }));
        try {
            const { data } = await axios.get(API_ENDPOINTS.MODELS_HF_FILES, { params: { repo } });
            setHfFiles((prev) => ({ ...prev, [repo]: { loading: false, files: data?.files || [] } }));
        } catch (err) {
            console.error('HF files failed:', err);
            setHfFiles((prev) => ({ ...prev, [repo]: { loading: false, files: [] } }));
            showToastError?.('Не удалось получить список файлов репозитория.');
        }
    }, [expandedRepo, hfFiles, showToastError]);

    if (!open) return null;

    const activeDownloads = downloads.filter((d) => ACTIVE_STATUSES.includes(d.status));

    // Рендерим в document.body через портал: иначе backdrop-filter у .panel
    // создаёт containing block и position: fixed «запирается» внутри сайдбара.
    return createPortal(
        <div className="mm-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
            <div className="mm-panel" onMouseDown={(e) => e.stopPropagation()}>
                <header className="mm-header">
                    <h2 className="mm-title">Модели</h2>
                    <button type="button" className="mm-close" onClick={onClose} aria-label="Закрыть">×</button>
                </header>

                <nav className="mm-tabs">
                    {TABS.map((t) => (
                        <button
                            key={t.id}
                            type="button"
                            className={`mm-tab ${tab === t.id ? 'mm-tab--active' : ''}`}
                            onClick={() => setTab(t.id)}
                        >
                            {t.label}
                        </button>
                    ))}
                </nav>

                {/* Активные загрузки */}
                {activeDownloads.length > 0 && (
                    <div className="mm-downloads">
                        {activeDownloads.map((d) => (
                            <div key={d.job_id} className="mm-download">
                                <div className="mm-download__row">
                                    <span className="mm-download__name" title={d.filename}>{d.filename}</span>
                                    <span className="mm-download__meta">
                                        {Math.round((d.progress || 0) * 100)}%
                                        {d.speed_bps ? ` · ${formatBytes(d.speed_bps)}/с` : ''}
                                    </span>
                                    <button type="button" className="mm-btn mm-btn--ghost" onClick={() => cancelDownload(d.job_id)}>
                                        Отмена
                                    </button>
                                </div>
                                <div className="mm-progress">
                                    <div className="mm-progress__bar" style={{ width: `${Math.round((d.progress || 0) * 100)}%` }} />
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                <div className="mm-body">
                    {tab === 'installed' && (
                        <div className="mm-list">
                            {availableModels.length === 0 && (
                                <p className="mm-empty">Модели не найдены.</p>
                            )}
                            {availableModels.map((m) => (
                                <div key={m.id} className={`mm-card ${m.id === activeModelId ? 'mm-card--active' : ''}`}>
                                    <div className="mm-card__main">
                                        <div className="mm-card__title">
                                            {m.label || m.id}
                                            {m.id === activeModelId && <span className="mm-badge mm-badge--active">активна</span>}
                                        </div>
                                        <div className="mm-card__sub">
                                            <FamilyBadge family={m.family} />
                                            <span className="mm-source">{m.source || 'cloud'}</span>
                                            {m.size_mb ? <span className="mm-size">{m.size_mb} МБ</span> : null}
                                        </div>
                                    </div>
                                    <div className="mm-card__actions">
                                        <button
                                            type="button"
                                            className="mm-btn mm-btn--primary"
                                            disabled={m.id === activeModelId}
                                            onClick={() => { onSelectModel?.(m.id); showToastSuccess?.(`Активная модель: ${m.label || m.id}`); }}
                                        >
                                            Выбрать
                                        </button>
                                        {m.source === 'local' && (
                                            <button type="button" className="mm-btn mm-btn--danger" onClick={() => deleteModel(m)}>
                                                Удалить
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {(tab === 'civitai' || tab === 'huggingface') && (
                        <>
                            <form
                                className="mm-search"
                                onSubmit={(e) => { e.preventDefault(); runSearch(); }}
                            >
                                <input
                                    type="text"
                                    className="mm-search__input"
                                    placeholder={tab === 'civitai' ? 'Поиск чекпоинтов на Civit.ai…' : 'Поиск моделей на HuggingFace…'}
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                />
                                <button type="submit" className="mm-btn mm-btn--primary" disabled={searching}>
                                    {searching ? 'Поиск…' : 'Найти'}
                                </button>
                            </form>

                            <div className="mm-list">
                                {!searching && results.length === 0 && (
                                    <p className="mm-empty">Введите запрос и нажмите «Найти».</p>
                                )}

                                {tab === 'civitai' && results.map((r) => {
                                    const name = basename(r.filename);
                                    const installed = installedNames.has(name);
                                    const downloading = activeDownloadNames.has(name);
                                    return (
                                        <div key={`${r.id}-${name}`} className="mm-card">
                                            {r.thumbnail && <img className="mm-thumb" src={r.thumbnail} alt="" loading="lazy" />}
                                            <div className="mm-card__main">
                                                <div className="mm-card__title">{r.name}</div>
                                                <div className="mm-card__sub">
                                                    <FamilyBadge family={r.family} />
                                                    {r.base_model && <span className="mm-source">{r.base_model}</span>}
                                                    {r.size_bytes ? <span className="mm-size">{formatBytes(r.size_bytes)}</span> : null}
                                                    {r.nsfw && <span className="mm-badge mm-badge--nsfw">NSFW</span>}
                                                </div>
                                            </div>
                                            <div className="mm-card__actions">
                                                <button
                                                    type="button"
                                                    className="mm-btn mm-btn--primary"
                                                    disabled={installed || downloading}
                                                    onClick={() => startDownload({ download_url: r.download_url, filename: r.filename, model_id: r.name, auth: 'civitai' })}
                                                >
                                                    {installed ? 'Установлена' : downloading ? 'Качается…' : 'Скачать'}
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}

                                {tab === 'huggingface' && results.map((r) => (
                                    <div key={r.id} className="mm-card mm-card--column">
                                        <div className="mm-card__head">
                                            <div className="mm-card__main">
                                                <div className="mm-card__title">{r.name}</div>
                                                <div className="mm-card__sub">
                                                    <FamilyBadge family={r.family} />
                                                    {Number.isFinite(r.downloads) && <span className="mm-source">↓ {r.downloads}</span>}
                                                    {Number.isFinite(r.likes) && <span className="mm-source">♥ {r.likes}</span>}
                                                </div>
                                            </div>
                                            <button type="button" className="mm-btn mm-btn--ghost" onClick={() => loadHfFiles(r.id)}>
                                                {expandedRepo === r.id ? 'Скрыть файлы' : 'Файлы'}
                                            </button>
                                        </div>
                                        {expandedRepo === r.id && (
                                            <div className="mm-files">
                                                {hfFiles[r.id]?.loading && <p className="mm-empty">Загрузка списка файлов…</p>}
                                                {hfFiles[r.id] && !hfFiles[r.id].loading && hfFiles[r.id].files.length === 0 && (
                                                    <p className="mm-empty">Single-file чекпоинтов (.safetensors/.ckpt) не найдено.</p>
                                                )}
                                                {hfFiles[r.id]?.files?.map((f) => {
                                                    const name = basename(f.filename);
                                                    const installed = installedNames.has(name);
                                                    const downloading = activeDownloadNames.has(name);
                                                    return (
                                                        <div key={f.filename} className="mm-file">
                                                            <span className="mm-file__name" title={f.filename}>{f.filename}</span>
                                                            {f.size_bytes ? <span className="mm-size">{formatBytes(f.size_bytes)}</span> : null}
                                                            <button
                                                                type="button"
                                                                className="mm-btn mm-btn--primary mm-btn--sm"
                                                                disabled={installed || downloading}
                                                                onClick={() => startDownload({ download_url: f.download_url, filename: f.filename, model_id: r.id, auth: 'huggingface' })}
                                                            >
                                                                {installed ? 'Установлена' : downloading ? 'Качается…' : 'Скачать'}
                                                            </button>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
};

export default ModelManager;
