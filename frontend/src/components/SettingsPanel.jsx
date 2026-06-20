import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { API_ENDPOINTS } from '../constants';
import './SettingsPanel.css';

const ADMIN_TOKEN_KEY = 'settings_admin_token';

// Модалка настроек сервера: читает/правит backend/.env через /config.
// Правки применяются после рестарта backend (см. баннер).
const SettingsPanel = ({ open, onClose, showToastSuccess, showToastError, showToastInfo }) => {
    const [loading, setLoading] = useState(false);
    const [schema, setSchema] = useState([]);
    const [values, setValues] = useState({});
    const [editable, setEditable] = useState(false);
    const [envFile, setEnvFile] = useState('');
    const [edits, setEdits] = useState({});
    const [saving, setSaving] = useState(false);
    const [adminToken, setAdminToken] = useState(() => {
        try { return localStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; }
    });

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await axios.get(API_ENDPOINTS.CONFIG);
            const data = res.data?.data || {};
            setSchema(Array.isArray(data.schema) ? data.schema : []);
            setValues(data.values || {});
            setEditable(Boolean(data.editable));
            setEnvFile(data.env_file || '');
            setEdits({});
        } catch {
            showToastError?.('Не удалось загрузить настройки сервера.');
        } finally {
            setLoading(false);
        }
    }, [showToastError]);

    useEffect(() => { if (open) load(); }, [open, load]);

    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    const setEdit = (key, val) => setEdits((prev) => ({ ...prev, [key]: val }));
    const fieldValue = (entry) => (entry.key in edits ? edits[entry.key] : values[entry.key]);

    const handleSave = async () => {
        if (!editable) return;
        if (!adminToken.trim()) { showToastError?.('Введите админ-токен для сохранения.'); return; }
        if (Object.keys(edits).length === 0) { showToastInfo?.('Нет изменений.'); return; }
        setSaving(true);
        try {
            try { localStorage.setItem(ADMIN_TOKEN_KEY, adminToken); } catch { /* переполнение хранилища не критично */ }
            const res = await axios.patch(
                API_ENDPOINTS.CONFIG,
                { values: edits },
                { headers: { 'X-Admin-Token': adminToken } }
            );
            const written = res.data?.written || [];
            showToastSuccess?.(`Сохранено (${written.length}). Перезапустите backend, чтобы применить.`);
            await load();
        } catch (e) {
            showToastError?.(e.response?.data?.detail || 'Не удалось сохранить настройки.');
        } finally {
            setSaving(false);
        }
    };

    // Группировка записей схемы по entry.group с сохранением порядка.
    const groups = [];
    const byGroup = {};
    schema.forEach((entry) => {
        if (!byGroup[entry.group]) { byGroup[entry.group] = []; groups.push([entry.group, byGroup[entry.group]]); }
        byGroup[entry.group].push(entry);
    });

    const renderControl = (entry) => {
        const key = entry.key;
        if (entry.type === 'secret') {
            const isSet = values[key]?.set;
            return (
                <input
                    type="password"
                    className="sp-input"
                    autoComplete="new-password"
                    placeholder={isSet ? '••• задано — введите новый, чтобы заменить' : 'не задано'}
                    value={key in edits ? edits[key] : ''}
                    onChange={(e) => setEdit(key, e.target.value)}
                />
            );
        }
        if (entry.type === 'bool') {
            const checked = String(fieldValue(entry)) === 'true';
            return (
                <label className="sp-switch">
                    <input type="checkbox" checked={checked} onChange={(e) => setEdit(key, e.target.checked ? 'true' : 'false')} />
                    <span className="sp-switch__slider" />
                </label>
            );
        }
        if (entry.type === 'select') {
            return (
                <select className="sp-input" value={fieldValue(entry) ?? ''} onChange={(e) => setEdit(key, e.target.value)}>
                    {entry.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
            );
        }
        const inputType = (entry.type === 'int' || entry.type === 'float') ? 'number' : 'text';
        const step = entry.type === 'float' ? '0.1' : (entry.type === 'int' ? '1' : undefined);
        return (
            <input
                type={inputType}
                step={step}
                min={entry.min}
                max={entry.max}
                className="sp-input"
                value={fieldValue(entry) ?? ''}
                onChange={(e) => setEdit(key, e.target.value)}
            />
        );
    };

    const renderReadonly = (entry) => {
        if (entry.type === 'secret') {
            return <span className="sp-readonly">{values[entry.key]?.set ? '••• задано' : 'не задано'}</span>;
        }
        return <span className="sp-readonly">{String(fieldValue(entry) ?? '')}</span>;
    };

    return createPortal(
        <div className="sp-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
            <div className="sp-panel" onMouseDown={(e) => e.stopPropagation()}>
                <header className="sp-header">
                    <h2 className="sp-title">Настройки сервера</h2>
                    <button type="button" className="sp-close" onClick={onClose} aria-label="Закрыть">×</button>
                </header>

                <div className="sp-banner">
                    Изменения пишутся в <code>{envFile || 'backend/.env'}</code> и применяются после <b>перезапуска backend</b>.
                </div>

                {loading ? (
                    <div className="sp-body"><p className="sp-muted">Загрузка…</p></div>
                ) : (
                    <div className="sp-body">
                        {!editable && (
                            <div className="sp-notice">
                                Редактирование выключено. Задайте <code>SETTINGS_ADMIN_TOKEN</code> в backend/.env и перезапустите backend, чтобы править отсюда. Сейчас — только просмотр.
                            </div>
                        )}
                        {groups.map(([group, entries]) => (
                            <section key={group} className="sp-group">
                                <h3 className="sp-group__title">{group}</h3>
                                {entries.map((entry) => (
                                    <div key={entry.key} className="sp-row">
                                        <div className="sp-row__label">
                                            <span>{entry.label}</span>
                                            {entry.help && <small className="sp-muted">{entry.help}</small>}
                                        </div>
                                        <div className="sp-row__control">
                                            {editable ? renderControl(entry) : renderReadonly(entry)}
                                        </div>
                                    </div>
                                ))}
                            </section>
                        ))}
                    </div>
                )}

                {editable && (
                    <footer className="sp-footer">
                        <input
                            type="password"
                            className="sp-input sp-token"
                            autoComplete="off"
                            placeholder="Админ-токен (SETTINGS_ADMIN_TOKEN)"
                            value={adminToken}
                            onChange={(e) => setAdminToken(e.target.value)}
                        />
                        <button type="button" className="sp-btn sp-btn--primary" onClick={handleSave} disabled={saving}>
                            {saving ? 'Сохранение…' : 'Сохранить'}
                        </button>
                    </footer>
                )}
            </div>
        </div>,
        document.body
    );
};

export default SettingsPanel;
